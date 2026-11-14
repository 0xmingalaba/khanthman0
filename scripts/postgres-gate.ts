#!/usr/bin/env node
/**
 * PostgreSQL test gate.
 *
 * WHY THIS EXISTS
 *
 * The previous CI step was `npm run test:postgres 2>&1 | tee log`, followed by a
 * `grep "# skipped [1-9]"` guard. Both halves were broken:
 *
 *   1. A pipeline returns the exit status of its LAST command. `tee` succeeds, so a
 *      failing suite produced a green step. Verified: a deliberately failing test that
 *      printed `# fail 1` still exited 0.
 *
 *   2. The skip guard never fired. When TEST_DATABASE_URL is unset the suites use
 *      `describe.skip`, which skips four whole suites. The spec reporter then prints
 *      `tests 0 / skipped 0`, because no *individual test* was skipped. Verified: a
 *      run that executed nothing reported `# skipped 0`.
 *
 * WHAT IT DOES INSTEAD
 *
 * Runs the suite once with the built-in JUnit reporter, which is machine-readable and
 * records per-test `<skipped/>` elements that the aggregate summary hides. The gate
 * then asserts explicit preconditions and postconditions:
 *
 *   - TEST_DATABASE_URL must be set                       (else: misconfigured CI)
 *   - the report must be well-formed JUnit                (else: cannot be trusted)
 *   - the suite must actually execute (> 0 testcases)      (else: nothing ran)
 *   - zero skipped testcases                               (skips are prohibited here)
 *   - zero <failure>/<error> elements                      (else: suite failed)
 *   - the child process must exit 0                        (else: runner crashed)
 *
 * A malformed or truncated report is NEVER treated as a pass. Detection of "did the
 * suite run" must not degrade to "did some XML appear".
 *
 * Exit codes are distinct so CI logs identify the cause without reading prose:
 *   0 pass · 1 test failures · 2 missing config · 3 nothing executed · 4 skipped tests
 *   5 runner crashed · 6 unreadable or malformed report
 *
 * Usage:
 *   node --import tsx scripts/postgres-gate.ts
 *   PG_GATE_SUITE=<glob>       override the suite under test (used by self-tests)
 *   PG_GATE_JUNIT=<path>       override the report path. SINGLE-RUN USE ONLY:
 *                              a fixed path is the caller's to serialise, because two
 *                              concurrent runs writing one file would each read the
 *                              other's report. The default is already unique per run
 *                              (pid + random UUID), so the override is never needed in CI.
 *                              An EXISTING file at that path is refused (exit 6) rather
 *                              than deleted.
 *   PG_GATE_JUNIT_FORCE=1      explicitly authorise overwriting an existing
 *                              PG_GATE_JUNIT path. Never set this in CI.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EXIT = {
  PASS: 0,
  TEST_FAILURES: 1,
  MISSING_CONFIG: 2,
  NOTHING_EXECUTED: 3,
  TESTS_SKIPPED: 4,
  RUNNER_CRASHED: 5,
  UNREADABLE_REPORT: 6,
} as const;

export type Counts = { testcases: number; skipped: number; failures: number; errors: number };

export type GateResult = {
  ok: boolean;
  exitCode: number;
  reason: string;
  counts: Counts;
};

/** The outcome of deciding where the JUnit report should be written. */
export type ReportPathDecision =
  | { ok: true; path: string; owned: boolean; clearExisting: boolean }
  | { ok: false; exitCode: number; reason: string };

/** A parsed JUnit report, plus whether it can be trusted at all. */
export type JunitReport = {
  wellFormed: boolean;
  counts: Counts;
  /** Human-readable diagnosis when `wellFormed` is false, else null. */
  problem: string | null;
};

export const EMPTY_COUNTS: Counts = {
  testcases: 0,
  skipped: 0,
  failures: 0,
  errors: 0,
};

/**
 * Elements a Node junit report may legitimately contain, and where they may appear.
 *
 * Ordered parent -> allowed children. Anything else is a structural violation, not a
 * naming detail: it means the document is not the report we expect (a different
 * reporter, a proxy error page, an HTML body) and must not be trusted.
 */
const CONTENTS: Record<string, readonly string[]> = {
  testsuites: ["testsuite", "testcase"],
  testsuite: ["testsuite", "testcase", "system-out", "system-err", "properties"],
  testcase: ["skipped", "failure", "error", "system-out", "system-err"],
  skipped: [],
  failure: [],
  error: [],
  "system-out": [],
  "system-err": [],
  properties: ["property"],
  property: [],
};

/** Leaf elements that describe one outcome; more than one per testcase is invalid. */
const OUTCOME_ELEMENTS = new Set(["skipped", "failure", "error"]);

/** Attributes each element may carry. Unknown attributes are rejected. */
const ATTRIBUTES: Record<string, readonly string[]> = {
  testsuites: ["name", "tests", "failures", "errors", "time", "disabled", "skipped"],
  testsuite: [
    "name",
    "tests",
    "failures",
    "errors",
    "skipped",
    "time",
    "timestamp",
    "hostname",
    "disabled",
    "package",
    "file",
    "id",
  ],
  testcase: ["name", "classname", "time", "failure", "status", "assertions", "file", "line"],
  skipped: ["type", "message"],
  failure: ["type", "message"],
  error: ["type", "message"],
  "system-out": [],
  "system-err": [],
  properties: [],
  property: ["name", "value"],
};

/**
 * Attributes every reporter instance of an element must carry.
 *
 * Node ALWAYS emits `name` on `<testsuite>` and `<testcase>`; a report missing it did not
 * come from the reporter (or was hand-edited), so it is rejected rather than guessed at.
 */
const REQUIRED_ATTRIBUTES: Record<string, readonly string[]> = {
  testsuite: ["name"],
  testcase: ["name"],
};

/** Attributes whose value must be a non-negative integer when present. */
const INTEGER_ATTRIBUTES = ["tests", "failures", "errors", "skipped", "disabled", "assertions", "line"];

/** Attributes whose value must be a non-negative decimal when present. */
const DECIMAL_ATTRIBUTES = ["time"];

/**
 * Maximum element depth. A real report nests at most testsuites > testsuite > testsuite
 * > testcase > failure (5). The cap keeps a hostile or corrupt file from exhausting the
 * stack and makes "absurd nesting" a structural rejection rather than a crash.
 */
const MAX_DEPTH = 64;

/** XML name production, simplified: must start with a letter or underscore. */
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/** XML `S` production: whitespace in markup is exactly these four characters. */
const isXmlSpace = (ch: string): boolean =>
  ch === " " || ch === "\t" || ch === "\r" || ch === "\n";

/** Skip XML whitespace from `index`, returning the new index. */
function skipSpaces(text: string, index: number): number {
  let i = index;
  while (i < text.length && isXmlSpace(text[i]!)) i += 1;
  return i;
}

/**
 * XML 1.0 `Char` production.
 *
 *   Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 *
 * Notably this EXCLUDES 0x0, the surrogate range 0xD800-0xDFFF, 0xFFFE and 0xFFFF, and
 * every other C0 control except tab, CR and LF. A "character reference" to any of those
 * is not well-formed XML even though it looks like one.
 */
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** A parsed element with everything the gate needs to reason about it. */
type XmlElement = {
  name: string;
  attributes: Map<string, string>;
  children: XmlElement[];
  /** 1-based line of the opening tag, for actionable CI messages. */
  line: number;
};

type XmlParse =
  | { ok: true; root: XmlElement; declaration: boolean }
  | { ok: false; problem: string };

/** Thrown internally to abort parsing at the first structural violation. */
class XmlError extends Error {}

/**
 * Decode the predefined XML entities and numeric character references.
 *
 * Only the five predefined entities plus numeric references are legal XML without a
 * DTD, and Node's reporter emits exactly those. An unknown entity (`&nbsp;`, `&foo;`) is
 * a hard error rather than a passthrough, so a document that is not really XML cannot
 * slip through looking almost right.
 *
 * Numeric references are validated against the `Char` production: `&#0;`, `&#1;`,
 * `&#xD800;`, `&#xFFFE;` and anything above 0x10FFFF are rejected. JavaScript's
 * `String.fromCodePoint` would happily produce a lone surrogate for `&#xD800;`, so the
 * check has to happen here rather than relying on the conversion to fail.
 */
function decodeEntities(raw: string, where: string): string {
  let out = "";
  let index = 0;
  while (index < raw.length) {
    const amp = raw.indexOf("&", index);
    if (amp === -1) {
      out += raw.slice(index);
      break;
    }
    out += raw.slice(index, amp);
    const semi = raw.indexOf(";", amp + 1);
    if (semi === -1) throw new XmlError(`${where}: unterminated entity reference.`);
    const entity = raw.slice(amp + 1, semi);
    if (entity === "amp") out += "&";
    else if (entity === "lt") out += "<";
    else if (entity === "gt") out += ">";
    else if (entity === "quot") out += '"';
    else if (entity === "apos") out += "'";
    else if (/^#\d+$/.test(entity) || /^#x[0-9A-Fa-f]+$/.test(entity)) {
      const code = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (!Number.isFinite(code) || code > 0x10ffff) {
        throw new XmlError(`${where}: character reference ${entity} is out of range.`);
      }
      // A reference may name a legal character; 0, surrogates and the non-characters
      // 0xFFFE/0xFFFF are not legal XML characters at all.
      if (!isXmlChar(code)) {
        const hex = code.toString(16).toUpperCase();
        throw new XmlError(
          `${where}: character reference ${entity} (U+${hex}) is not a legal XML character.`
        );
      }
      out += String.fromCodePoint(code);
    } else {
      throw new XmlError(`${where}: unknown entity &${entity};.`);
    }
    index = semi + 1;
  }
  return out;
}

/** Line number of a byte offset, for error messages. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Validate the XML declaration.
 *
 *   XMLDecl ::= '<?xml' VersionInfo EncodingDecl? SDDecl? S? '?>'
 *
 * Node emits `<?xml version="1.0" encoding="utf-8"?>`. This accepts exactly that shape:
 * `version` is mandatory and must be `1.0`, `encoding` and `standalone` are optional but
 * must be well-formed and correctly ordered. `<?XML ...?>`, a missing version, a bogus
 * attribute and version `2.0` are all rejected — the previous code accepted all four.
 */
function validateDeclaration(body: string): string | null {
  const S = "[ \\t\\r\\n]";
  const pattern = new RegExp(
    `^${S}+version${S}*=${S}*("1\\.0"|'1\\.0')` +
      `(${S}+encoding${S}*=${S}*("[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?` +
      `(${S}+standalone${S}*=${S}*("(yes|no)"|'(yes|no)'))?` +
      `${S}*$`
  );
  if (!pattern.test(body)) {
    return (
      "XML declaration is not well-formed. Expected " +
      `<?xml version="1.0" encoding="utf-8"?>. Got <?xml${body}?>.`
    );
  }
  return null;
}

/**
 * Parse XML structurally and enforce XML 1.0 well-formedness.
 *
 * SCOPE, STATED PRECISELY: this is a validating parser for the subset of XML 1.0 that a
 * JUnit report can contain — elements, attributes, character data, comments, CDATA
 * sections, the XML declaration, the five predefined entities and numeric character
 * references. It deliberately does NOT implement DTDs, entity declarations, namespaces
 * as a resolution mechanism, or XInclude; a DOCTYPE is rejected outright, which also
 * removes XML entity-expansion attacks from reach.
 *
 * WHAT IS REJECTED (each is an XML 1.0 well-formedness rule, not a tag-name heuristic):
 *   - any character outside the `Char` production (NUL, surrogates, 0xFFFE, 0xFFFF, C0
 *     controls other than tab/CR/LF)
 *   - numeric character references to a non-`Char` code point
 *   - a malformed XML declaration, or any processing instruction other than it
 *   - markup after the root element closes (second root, trailing content)
 *   - an end tag that does not match the open element (wrong nesting)
 *   - whitespace between `</` and the element name, or between the name and `>`
 *     being anything other than XML `S`
 *   - a tag that never closes (truncation)
 *   - an attribute with no `=`, an unquoted value, or an unterminated quote
 *   - a duplicated attribute on one element
 *   - `]]>` appearing raw in character data
 *   - a comment containing `--`, or ending in `-` immediately before `-->`
 *   - an unknown entity, an unknown character reference, or a bare `&`
 *   - a DOCTYPE, or CDATA outside the root element
 *
 * Markup is scanned for complete tags first, then attributes, so raw `>` inside a quoted
 * value (Node's encoding of a test name containing `>`) is handled correctly.
 */
function parseXml(text: string): XmlParse {
  let offset = 0;
  let declaration = false;
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];

  const fail = (message: string): never => {
    throw new XmlError(message);
  };

  /** Read a complete tag starting at `offset` (which points at `<`), honouring quotes. */
  const readTag = (): { raw: string; end: number } => {
    let quote: string | null = null;
    for (let i = offset + 1; i < text.length; i += 1) {
      const ch = text[i]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        return { raw: text.slice(offset, i + 1), end: i + 1 };
      }
    }
    if (quote) {
      return fail(`line ${lineAt(text, offset)}: unterminated attribute value in a tag.`);
    }
    return fail(
      `line ${lineAt(text, offset)}: unterminated tag. The report is truncated or the ` +
        "runner died mid-write."
    );
  };

  /** Parse `name="value" name='value'` pairs from the inside of a tag. */
  const parseAttributes = (body: string, element: string, line: number): Map<string, string> => {
    const attributes = new Map<string, string>();
    const allowed = ATTRIBUTES[element];
    let index = 0;
    while (index < body.length) {
      index = skipSpaces(body, index);
      if (index >= body.length) break;
      const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(body.slice(index));
      if (!nameMatch) {
        return fail(`line ${line}: malformed attribute near "${body.slice(index, index + 12)}".`);
      }
      const name = nameMatch[0];
      index += name.length;
      index = skipSpaces(body, index);
      if (body[index] !== "=") {
        return fail(`line ${line}: attribute "${name}" on <${element}> has no value.`);
      }
      index += 1;
      index = skipSpaces(body, index);
      const quote = body[index];
      if (quote !== '"' && quote !== "'") {
        return fail(`line ${line}: attribute "${name}" on <${element}> is not quoted.`);
      }
      const closeQuote = body.indexOf(quote, index + 1);
      if (closeQuote === -1) {
        return fail(`line ${line}: attribute "${name}" on <${element}> has an unterminated value.`);
      }
      const rawValue = body.slice(index + 1, closeQuote);
      if (rawValue.includes("<")) {
        return fail(`line ${line}: attribute "${name}" on <${element}> contains a raw "<".`);
      }
      if (attributes.has(name)) {
        return fail(`line ${line}: attribute "${name}" is duplicated on <${element}>.`);
      }
      if (allowed && !allowed.includes(name)) {
        return fail(
          `line ${line}: <${element}> has unexpected attribute "${name}". ` +
            "This is not a report from the expected test runner."
        );
      }
      attributes.set(name, decodeEntities(rawValue, `line ${line} attribute "${name}"`));
      index = closeQuote + 1;
    }

    for (const required of REQUIRED_ATTRIBUTES[element] ?? []) {
      if (!attributes.has(required)) {
        return fail(`line ${line}: <${element}> is missing its required "${required}" attribute.`);
      }
      if (attributes.get(required)!.trim().length === 0) {
        return fail(
          `line ${line}: <${element}> has an empty "${required}" attribute. ` +
            "An empty name identifies nothing and cannot be reported on."
        );
      }
    }
    return attributes;
  };

  /** Validate a run of character data: legal chars, legal entities, no raw `]]>`. */
  const checkCharacterData = (chunk: string, line: number): void => {
    if (chunk.includes("]]>")) {
      throw new XmlError(
        `line ${line}: character data contains a raw "]]>". ` +
          "That sequence is only legal as the end of a CDATA section."
      );
    }
    if (chunk.includes("&")) decodeEntities(chunk, `line ${line} text`);
  };

  while (offset < text.length) {
    const lt = text.indexOf("<", offset);
    const textChunk = lt === -1 ? text.slice(offset) : text.slice(offset, lt);
    const chunkLine = lineAt(text, offset);

    if (stack.length === 0 && root === null && textChunk.length > 0) {
      // Only XML `S` is allowed before the root (Misc*: comments, PIs, whitespace).
      // Anything else -- including JS's idea of whitespace such as a vertical tab or a
      // form feed -- is content outside the root and is rejected. `.trim()` previously
      // hid this by discarding such characters before they could be examined.
      for (let i = 0; i < textChunk.length; i += 1) {
        if (!isXmlSpace(textChunk[i]!)) {
          const bad = textChunk.charCodeAt(i);
          return fail(
            `line ${lineAt(text, offset + i)}: character U+${bad
              .toString(16)
              .toUpperCase()
              .padStart(4, "0")} appears before the root element. Only legal XML ` +
              "whitespace may precede it."
          );
        }
      }
    }
    if (stack.length === 0 && root !== null && textChunk.length > 0) {
      // Only XML `S` may follow the root (Misc*). JavaScript's `.trim()` also treats
      // U+00A0 and friends as whitespace, so a non-breaking space here was previously
      // discarded instead of rejected -- it is content outside the root, not whitespace.
      for (let i = 0; i < textChunk.length; i += 1) {
        if (!isXmlSpace(textChunk[i]!)) {
          const bad = textChunk.charCodeAt(i);
          return fail(
            `line ${lineAt(text, offset + i)}: character U+${bad
              .toString(16)
              .toUpperCase()
              .padStart(4, "0")} appears after the closing root element. Only legal ` +
              "XML whitespace may follow it, and a document may have only one root."
          );
        }
      }
    }
    if (stack.length > 0) checkCharacterData(textChunk, chunkLine);

    if (lt === -1) break;
    offset = lt;

    if (text.startsWith("<!--", offset)) {
      const close = text.indexOf("-->", offset + 4);
      if (close === -1) return fail(`line ${chunkLine}: unterminated comment.`);
      const body = text.slice(offset + 4, close);
      if (body.includes("--")) {
        return fail(`line ${chunkLine}: comment contains "--", which XML forbids.`);
      }
      // `<!-- foo --->` is caught above; this covers the exact "--" boundary too, and is
      // kept separate so the message names the real rule.
      if (body.endsWith("-")) {
        return fail(
          `line ${chunkLine}: comment ends with "-" immediately before "-->", ` +
            "which produces the forbidden sequence `--->`."
        );
      }
      offset = close + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", offset)) {
      if (stack.length === 0) {
        return fail(`line ${chunkLine}: CDATA is not allowed outside the root element.`);
      }
      const close = text.indexOf("]]>", offset + 9);
      if (close === -1) return fail(`line ${chunkLine}: unterminated CDATA section.`);
      offset = close + 3;
      continue;
    }
    if (text.startsWith("<!DOCTYPE", offset) || text.startsWith("<!doctype", offset)) {
      return fail("JUnit report contains a DOCTYPE, which the test runner never emits.");
    }
    if (text.startsWith("<?", offset)) {
      const close = text.indexOf("?>", offset + 2);
      if (close === -1) return fail(`line ${chunkLine}: unterminated processing instruction.`);
      const body = text.slice(offset + 2, close);
      const target = /^([^\s?]*)/.exec(body)?.[1] ?? "";
      // Only the XML declaration is legal here, and only as the very first markup.
      if (offset !== 0 || target !== "xml") {
        return fail(
          `line ${chunkLine}: unexpected processing instruction <?${target}?>. ` +
            "The test runner emits no processing instructions other than the XML " +
            "declaration at the start of the document."
        );
      }
      const problem = validateDeclaration(body.slice(3));
      if (problem) return fail(problem);
      declaration = true;
      offset = close + 2;
      continue;
    }

    const { raw, end } = readTag();
    const line = chunkLine;

    // Closing tag. XML forbids whitespace between `</` and the name.
    if (raw.startsWith("</")) {
      const afterDelimiter = raw.slice(2);
      if (afterDelimiter.length > 0 && isXmlSpace(afterDelimiter[0]!)) {
        return fail(
          `line ${line}: whitespace immediately after "</" in "${raw.trim()}". ` +
            "An end tag must be </name> with no gap."
        );
      }
      const name = afterDelimiter.slice(0, -1).replace(/[ \t\r\n]+$/, "");
      if (!NAME.test(name)) {
        return fail(`line ${line}: malformed end tag "${raw.trim()}".`);
      }
      if (stack.length === 0) {
        return fail(`line ${line}: end tag </${name}> with no open element.`);
      }
      const open = stack[stack.length - 1]!;
      if (open.name !== name) {
        return fail(
          `line ${line}: end tag </${name}> does not match open element <${open.name}> ` +
            `opened on line ${open.line}. The report is malformed.`
        );
      }
      stack.pop();
      offset = end;
      continue;
    }

    // Opening or self-closing tag.
    //
    // EMPTY-ELEMENT TAG SYNTAX, per XML 1.0 section 3.1:
    //
    //     EmptyElemTag ::= '<' Name (S Attribute)* S? '/>'
    //
    // The `/` and the `>` are adjacent. Whitespace is allowed BEFORE the slash (`<a />`)
    // but not BETWEEN the slash and the `>` — `<a / >` is not well-formed. The previous
    // implementation stripped trailing whitespace before testing for the slash, which
    // wrongly accepted `<a / >`. The check is now made on the raw tag text.
    const inner0 = raw.slice(1, -1);
    if (/\/\s+>$/.test(raw)) {
      return fail(
        `line ${line}: invalid empty-element tag "${raw.trim()}". The "/" must ` +
          "immediately precede \">\"; write <name/> or <name />."
      );
    }
    const trimmedRight = inner0.replace(/[ \t\r\n]+$/, "");
    const selfClosing = trimmedRight.endsWith("/");
    const inner = selfClosing ? trimmedRight.slice(0, -1) : trimmedRight;

    const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(inner);
    if (!nameMatch) {
      return fail(`line ${line}: malformed start tag "${raw.slice(0, 20)}".`);
    }
    const name = nameMatch[1]!;
    if (!NAME.test(name)) return fail(`line ${line}: invalid element name "${name}".`);

    const attributes = parseAttributes(inner.slice(name.length), name, line);

    if (!(name in CONTENTS)) {
      return fail(
        `line ${line}: unexpected element <${name}>. This is not a report from the ` +
          "expected test runner."
      );
    }
    if (stack.length === 0) {
      if (root !== null) {
        return fail(`line ${line}: second root element <${name}>; a document has only one root.`);
      }
      if (name !== "testsuites") {
        return fail(
          `line ${line}: root element is <${name}>, expected <testsuites>. ` +
            "This is not a JUnit report."
        );
      }
    } else {
      const parent = stack[stack.length - 1]!;
      const allowedChildren = CONTENTS[parent.name]!;
      if (!allowedChildren.includes(name)) {
        return fail(
          `line ${line}: <${name}> is not allowed inside <${parent.name}> opened on ` +
            `line ${parent.line}. The report is malformed.`
        );
      }
      if (OUTCOME_ELEMENTS.has(name)) {
        const alreadyImmediate = parent.children.some((child) => OUTCOME_ELEMENTS.has(child.name));
        if (alreadyImmediate) {
          return fail(
            `line ${line}: <${parent.name}> has more than one outcome element. ` +
              "A test case cannot be both skipped and failed."
          );
        }
      }
    }
    if (stack.length >= MAX_DEPTH) {
      return fail(`line ${line}: report nests deeper than ${MAX_DEPTH} elements.`);
    }

    const element: XmlElement = { name, attributes, children: [], line };
    if (stack.length > 0) {
      stack[stack.length - 1]!.children.push(element);
    } else {
      root = element;
    }
    if (!selfClosing) stack.push(element);
    offset = end;
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1]!;
    return fail(
      `line ${open.line}: <${open.name}> is never closed. The report is truncated; ` +
        "the runner likely died mid-write."
    );
  }
  if (!root) return fail("JUnit report contains no root element.");
  return { ok: true, root, declaration };
}

/** Count elements named `name` anywhere in the subtree rooted at `node`. */
function countNamed(node: XmlElement, name: string): number {
  let total = node.name === name ? 1 : 0;
  for (const child of node.children) total += countNamed(child, name);
  return total;
}

/**
 * Validate the JUnit document structure and its aggregate counts.
 *
 * ACCEPTED FORMAT, STATED EXACTLY. This is what Node's built-in `junit` reporter emits,
 * verified against captures in this repository:
 *
 *   <testsuites>                          no attributes (and none are required)
 *     <testsuite name=… tests=… failures=… errors=… skipped=… time=… hostname=…>
 *       <testsuite …>                        nested suites are allowed
 *       <testcase name=… classname=… time=…> one of:
 *         <failure type=… message=…>text</failure>   |
 *         <error …>…</error>                         |
 *         <skipped type=… message=…/>                |
 *         (self-closing: the test passed)
 *       </testcase>
 *       <system-out>…</system-out>
 *
 * There are no aggregate attributes on the root. Counting rules, confirmed on real
 * output: a suite's `tests` equals its DIRECT children (testcases plus nested suites),
 * while its `failures`, `errors` and `skipped` equal the totals across its whole subtree.
 *
 * Tampering check: when these attributes are present they must agree with the elements
 * actually present. A report claiming 0 failures while containing `<failure>` elements —
 * or vice versa — is rejected, because the gate's verdict depends on those counts.
 */
function validateJunitStructure(root: XmlElement): string | null {
  const walk = (node: XmlElement): string | null => {
    for (const [name, value] of node.attributes) {
      if (INTEGER_ATTRIBUTES.includes(name) && !/^\d+$/.test(value)) {
        return `line ${node.line}: <${node.name}> attribute ${name}="${value}" is not a non-negative integer.`;
      }
      if (DECIMAL_ATTRIBUTES.includes(name) && !/^\d+(\.\d+)?$/.test(value)) {
        return `line ${node.line}: <${node.name}> attribute ${name}="${value}" is not a non-negative decimal.`;
      }
    }

    if (node.name === "testsuites") {
      // No attributes are expected on the root; accept the documented JUnit set but
      // require any declared total to match the document.
      const declaredTests = node.attributes.get("tests");
      const actual = countNamed(node, "testcase");
      if (declaredTests !== undefined && Number(declaredTests) !== actual) {
        return (
          `line ${node.line}: <testsuites tests="${declaredTests}"> disagrees with the ` +
          `${actual} test case(s) present. The report is inconsistent.`
        );
      }
      for (const [attr, element] of [
        ["failures", "failure"],
        ["errors", "error"],
        ["skipped", "skipped"],
      ] as const) {
        const declared = node.attributes.get(attr);
        const found = countNamed(node, element);
        if (declared !== undefined && Number(declared) !== found) {
          return (
            `line ${node.line}: <testsuites ${attr}="${declared}"> disagrees with the ` +
            `${found} <${element}> element(s) present. The report is inconsistent.`
          );
        }
      }
      for (const child of node.children) {
        const problem = walk(child);
        if (problem) return problem;
      }
      return null;
    }

    if (node.name === "testsuite") {
      const direct = node.children.filter(
        (child) => child.name === "testcase" || child.name === "testsuite"
      ).length;
      const declaredTests = node.attributes.get("tests");
      if (declaredTests !== undefined && Number(declaredTests) !== direct) {
        return (
          `line ${node.line}: <testsuite name="${node.attributes.get("name")}" ` +
          `tests="${declaredTests}"> disagrees with its ${direct} direct child test case(s) ` +
          "and suite(s). The report is inconsistent."
        );
      }
      for (const [attr, element] of [
        ["failures", "failure"],
        ["errors", "error"],
        ["skipped", "skipped"],
      ] as const) {
        const declared = node.attributes.get(attr);
        if (declared === undefined) continue;
        const found = countNamed(node, element);
        if (Number(declared) !== found) {
          return (
            `line ${node.line}: <testsuite name="${node.attributes.get("name")}" ` +
            `${attr}="${declared}"> disagrees with the ${found} <${element}> element(s) ` +
            "in its subtree. The report is inconsistent."
          );
        }
      }
    }

    // A testcase may carry at most one outcome element.
    if (node.name === "testcase") {
      const outcomes = node.children.filter((child) => OUTCOME_ELEMENTS.has(child.name));
      if (outcomes.length > 1) {
        return (
          `line ${node.line}: <testcase name="${node.attributes.get("name")}"> has ` +
          `${outcomes.length} outcome elements (${outcomes.map((o) => o.name).join(", ")}). ` +
          "A test case has exactly one outcome."
        );
      }
    }

    for (const child of node.children) {
      const problem = walk(child);
      if (problem) return problem;
    }
    return null;
  };

  return walk(root);
}

/**
 * Parse and VALIDATE a JUnit report.
 *
 * Validation is structural, not textual: the document is parsed into an element tree,
 * every rejection is a violated XML 1.0 well-formedness or JUnit structural rule, and
 * aggregate counts are cross-checked against the elements actually present.
 *
 * On any rejection `wellFormed` is false and `decide()` refuses to pass the gate
 * (exit 6); counts are zeroed because a document that failed validation cannot supply
 * trustworthy counts.
 */
export function parseJunit(xml: string): JunitReport {
  const reject = (problem: string): JunitReport => ({
    wellFormed: false,
    counts: EMPTY_COUNTS,
    problem,
  });

  // DOCUMENT BOUNDARIES ARE NOT NORMALISED.
  //
  // A byte-order mark is stripped because XML 1.0 appendix F permits one at the very
  // start of an entity, and a decoder may leave it in the string. Nothing else is
  // stripped: no trim(), no whitespace collapsing.
  //
  // An earlier version called `.trim()` on the whole document, which was wrong in two
  // distinct ways. It silently discarded characters OUTSIDE the root that XML forbids
  // (a vertical tab, say) before validation could see them, and it moved an XML
  // declaration that was preceded by whitespace into a legal position, hiding the fact
  // that `<?xml ...?>` must be the very first thing in the document. Both rules are now
  // enforced on the raw text.
  const withoutBom = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;

  if (withoutBom.length === 0) return reject("JUnit report is empty.");
  if (withoutBom.trim().length === 0) {
    return reject("JUnit report is empty (it contains only whitespace).");
  }

  // A declaration must start at offset 0. Whitespace before it is not legal, because the
  // XML declaration is part of the prolog and must begin the document.
  const leadingDecl = /^[ \t\r\n]+(<\?xml(?=[ \t\r\n?]))/.exec(withoutBom);
  if (leadingDecl) {
    const line = lineAt(withoutBom, leadingDecl[0].length - leadingDecl[1]!.length);
    return reject(
      `line ${line}: the XML declaration must be the very first thing in the document; ` +
        "whitespace before <?xml is not allowed."
    );
  }

  const text = withoutBom;

  // Every character in the document must satisfy the XML `Char` production. Doing this
  // once up front means no later stage has to defend against NULs or lone surrogates.
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    if (!isXmlChar(code)) {
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      return reject(
        `line ${lineAt(text, i)}: character U+${hex} is not a legal XML character.`
      );
    }
    i += code > 0xffff ? 2 : 1;
  }

  let parsed: XmlParse;
  try {
    parsed = parseXml(text);
  } catch (error) {
    if (error instanceof XmlError) return reject(error.message);
    throw error;
  }
  if (!parsed.ok) return reject(parsed.problem);

  if (parsed.root.name !== "testsuites") {
    return reject(
      `Root element is <${parsed.root.name}>, expected <testsuites>. This is not a JUnit report.`
    );
  }

  const structural = validateJunitStructure(parsed.root);
  if (structural) return reject(structural);

  return {
    wellFormed: true,
    counts: {
      testcases: countNamed(parsed.root, "testcase"),
      skipped: countNamed(parsed.root, "skipped"),
      failures: countNamed(parsed.root, "failure"),
      errors: countNamed(parsed.root, "error"),
    },
    problem: null,
  };
}

/**
 * Pure decision function: no I/O, so every CI outcome is unit-testable.
 *
 * Ordering is deliberate and load-bearing:
 *   1. configuration      — a missing URL explains everything else
 *   2. report trust        — an untrusted report cannot prove anything
 *   3. execution           — zero or all-skipped means nothing ran
 *   4. recorded failures   — JUnit says a test failed
 *   5. process health      — runner exited non-zero but recorded no failure => crash
 *   6. pass
 */
export function decide(input: {
  hasDatabaseUrl: boolean;
  childExitCode: number;
  reportReadable: boolean;
  report: JunitReport;
}): GateResult {
  const { hasDatabaseUrl, childExitCode, reportReadable, report } = input;
  const counts = report.counts;

  const fail = (exitCode: number, reason: string): GateResult => ({
    ok: false,
    exitCode,
    reason,
    counts,
  });

  if (!hasDatabaseUrl) {
    return fail(
      EXIT.MISSING_CONFIG,
      "TEST_DATABASE_URL is not set. The PostgreSQL concurrency suite cannot run; " +
        "refusing to report a green result for tests that never executed."
    );
  }

  if (!reportReadable) {
    return fail(EXIT.UNREADABLE_REPORT, "Could not read the JUnit report from the test runner.");
  }

  // Fix 1: a malformed / truncated / foreign report is never a pass.
  if (!report.wellFormed) {
    return fail(
      EXIT.UNREADABLE_REPORT,
      `JUnit report is not trustworthy: ${report.problem ?? "unknown format"}. ` +
        "A gate that cannot read the report must not infer success from it."
    );
  }

  if (childExitCode !== 0 && counts.testcases === 0) {
    return fail(
      EXIT.RUNNER_CRASHED,
      `Test runner exited ${childExitCode} without recording any test cases.`
    );
  }

  if (counts.testcases === 0) {
    return fail(
      EXIT.NOTHING_EXECUTED,
      "The suite reported zero test cases. Nothing ran, so the concurrency proof is " +
        "absent and a green result would be meaningless."
    );
  }

  // "Nothing actually executed", second shape.
  //
  // When whole suites are skipped (`describe.skip`), JUnit records ONE <testcase> per
  // skipped suite, each containing <skipped/>. So testcases>0 does not prove anything
  // ran. If every recorded testcase is skipped, the suite executed nothing — which is
  // exactly the scenario the original grep guard was meant to catch and did not
  // (the spec reporter prints 'skipped 0' in that case).
  if (counts.skipped === counts.testcases) {
    return fail(
      EXIT.NOTHING_EXECUTED,
      `All ${counts.testcases} recorded test case(s) were skipped, so no test executed. ` +
        "This is what a missing or unreachable TEST_DATABASE_URL looks like when the " +
        "suites skip themselves."
    );
  }

  if (counts.skipped > 0) {
    return fail(
      EXIT.TESTS_SKIPPED,
      `${counts.skipped} test case(s) were skipped. Skips are prohibited in this suite ` +
        "because a skipped concurrency test still reads as a pass at a glance."
    );
  }

  // Fix 3 (first half): JUnit actually recorded a failing test.
  if (counts.failures > 0 || counts.errors > 0) {
    return fail(
      EXIT.TEST_FAILURES,
      `${counts.failures} failure(s) and ${counts.errors} error(s) recorded in the ` +
        `JUnit report (runner exit ${childExitCode}).`
    );
  }

  // Fix 3 (second half): the runner exited non-zero, the report is complete, and no
  // test is recorded as failing. That is a crash during teardown, an unhandled
  // rejection, an out-of-memory kill or a failed exit hook — NOT a test failure, and
  // reporting it as one would send the reader hunting for a failing assertion that
  // does not exist.
  if (childExitCode !== 0) {
    return fail(
      EXIT.RUNNER_CRASHED,
      `Test runner exited ${childExitCode} although all ${counts.testcases} recorded ` +
        "test case(s) passed. The process failed outside the assertions (crash during " +
        "teardown, unhandled rejection, or killed)."
    );
  }

  return {
    ok: true,
    exitCode: EXIT.PASS,
    reason: `${counts.testcases} test case(s) passed with no skips.`,
    counts,
  };
}

/**
 * Unique report path.
 *
 * Concurrency-safe across processes AND containers: PID alone repeats inside separate
 * containers on a shared host, which would let two gate runs overwrite one another's
 * report. A random UUID removes that collision.
 */
export function defaultReportPath(): string {
  return join(tmpdir(), `pg-gate-${process.pid}-${randomUUID()}.xml`);
}

/**
 * Resolve the exit code the gate classifies, with the crash-classification test seam.
 *
 * WHY A SEAM IS NEEDED. Node's runner attributes every non-zero outcome it can observe to
 * a recorded testcase: a throwing `after` hook, a late uncaught throw, a late rejection,
 * process.exitCode set inside a test, and even process.abort() all produce exit 1 with a
 * synthetic <failure> (verified). The reporter also only flushes at exit, so there is no
 * window to kill the runner after the report is written. "Complete report, no recorded
 * failure, non-zero exit" is therefore unreachable from the runner itself.
 *
 * SAFETY RULES. A test seam that can turn a failing run green would be worse than no
 * test at all, so the substitution is constrained rather than trusted:
 *
 *   1. The simulated value must be a finite integer, and NOT zero. `0` is rejected
 *      explicitly, because substituting 0 for a genuine non-zero child exit is exactly
 *      the "turn a crash into a pass" failure this gate exists to prevent.
 *   2. Digit-only syntax is required (`"5"`, not `"5.0"`, `" 5"`, `"1e3"`, `"0x5"`), so
 *      a malformed value cannot be coerced into a surprising number by Number().
 *   3. An invalid value is IGNORED with a warning, never applied and never fatal — a
 *      mistyped test variable must not change a verdict on its own.
 *   4. The returned code is non-zero whenever the child's was non-zero. The seam can
 *      therefore only make a verdict WORSE (inject a crash where there was none), never
 *      better, so it cannot mask a real failure.
 *
 * Pure, so every branch is unit-testable.
 */
export function resolveRunnerExit(
  childExitCode: number,
  simulated: string | undefined
): { exitCode: number; note: string | null } {
  if (simulated === undefined) return { exitCode: childExitCode, note: null };

  const trimmed = simulated.trim();
  if (trimmed.length === 0) {
    return {
      exitCode: childExitCode,
      note:
        "warning: PG_GATE_SIMULATE_RUNNER_EXIT is set but empty; ignoring it and using " +
        `the runner's real exit code ${childExitCode}.`,
    };
  }

  // Digit-only: rejects "-1", "1.5", "1e3", "0x5", "+3", "abc" and whitespace-padded
  // numbers without relying on Number() coercion, which would accept most of them.
  if (!/^\d+$/.test(trimmed)) {
    return {
      exitCode: childExitCode,
      note:
        `warning: PG_GATE_SIMULATE_RUNNER_EXIT=${JSON.stringify(simulated)} is not a ` +
        "non-negative integer; ignoring it. A test seam must not change a verdict " +
        "through a malformed value.",
    };
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return {
      exitCode: childExitCode,
      note: `warning: PG_GATE_SIMULATE_RUNNER_EXIT=${trimmed} is out of range; ignoring it.`,
    };
  }

  // Rule 1: zero must never replace a real exit code. It would either be a no-op on a
  // passing run or, far worse, hide a genuine non-zero child exit.
  if (value === 0) {
    return {
      exitCode: childExitCode,
      note:
        "warning: PG_GATE_SIMULATE_RUNNER_EXIT=0 is not permitted — a simulated exit " +
        "code must be non-zero, and zero can never replace a real runner result. " +
        `Using the runner's real exit code ${childExitCode}.`,
    };
  }

  // Rule 4: a non-zero child exit can never be reported as a zero exit. Unreachable
  // given rule 1, but stated as an assertion so a future edit cannot break it silently.
  if (childExitCode !== 0 && value === 0) {
    return {
      exitCode: childExitCode,
      note: "warning: refusing to replace a non-zero runner exit with zero.",
    };
  }

  return {
    exitCode: value,
    note:
      `note: PG_GATE_SIMULATE_RUNNER_EXIT=${trimmed} overrides the runner's real exit ` +
      `code ${childExitCode} for crash-classification testing.`,
  };
}

/**
 * Decide where the JUnit report goes, and whether this run may write there.
 *
 * The default is a per-run unique temporary path, which this run owns and deletes.
 *
 * `PG_GATE_JUNIT` overrides it, and an override is treated as the CALLER'S file:
 *
 *   - an empty value is refused (exit 2) rather than silently falling back, so a typo in
 *     CI cannot quietly change which report is inspected;
 *   - an existing file is NEVER deleted implicitly. The gate refuses with exit 6 unless
 *     the caller sets `PG_GATE_JUNIT_FORCE=1`, which is the explicit statement that
 *     overwriting that path is intended;
 *   - a non-existent path is fine: the runner creates it, and the gate deletes only what
 *     it created... except an override is left for inspection (see cleanup below).
 *
 * Pure, so every branch is unit-testable without touching the filesystem.
 */
export function decideReportPath(input: {
  override: string | undefined;
  force: boolean;
  exists: boolean;
  defaultPath: string;
}): ReportPathDecision {
  const { override, force, exists, defaultPath } = input;

  if (override === undefined) {
    // Unique per run (pid + UUID), so an existing file would have to be a leftover from
    // this very process id. It is still cleared, and a failure to clear it is fatal.
    return { ok: true, path: defaultPath, owned: true, clearExisting: true };
  }

  if (override.trim().length === 0) {
    return {
      ok: false,
      exitCode: EXIT.MISSING_CONFIG,
      reason:
        "PG_GATE_JUNIT is set but empty. Unset it to use the per-run unique report path, " +
        "or give a real file path.",
    };
  }

  if (exists && !force) {
    return {
      ok: false,
      exitCode: EXIT.UNREADABLE_REPORT,
      reason:
        `PG_GATE_JUNIT points at ${override}, which already exists. Refusing to ` +
        "overwrite a caller-supplied file. Remove it, choose another path, or set " +
        "PG_GATE_JUNIT_FORCE=1 to authorise overwriting it.",
    };
  }

  return { ok: true, path: override, owned: false, clearExisting: exists && force };
}

/** Run the suite and gate the result. */
async function main(): Promise<void> {
  const suite = process.env.PG_GATE_SUITE ?? "tests/integration/postgres-concurrency.test.ts";
  const reportPathDefault = defaultReportPath();
  const hasDatabaseUrl = Boolean(process.env.TEST_DATABASE_URL);

  // Fail fast: do not even spawn the runner when the configuration is absent, so the
  // log says exactly what is wrong instead of showing four skipped suites.
  if (!hasDatabaseUrl) {
    const result = decide({
      hasDatabaseUrl: false,
      childExitCode: 0,
      reportReadable: true,
      report: { wellFormed: true, counts: EMPTY_COUNTS, problem: null },
    });
    console.error(`\n[postgres-gate] FAIL (exit ${result.exitCode}): ${result.reason}\n`);
    process.exitCode = result.exitCode;
    return;
  }

  const override = process.env.PG_GATE_JUNIT;
  const force = process.env.PG_GATE_JUNIT_FORCE === "1";

  let overrideExists = false;
  if (override !== undefined && override.trim().length > 0) {
    try {
      await stat(override);
      overrideExists = true;
    } catch {
      overrideExists = false;
    }
  }

  const pathDecision = decideReportPath({
    override,
    force,
    exists: overrideExists,
    defaultPath: reportPathDefault,
  });
  if (!pathDecision.ok) {
    console.error(`[postgres-gate] FAIL (exit ${pathDecision.exitCode}): ${pathDecision.reason}`);
    process.exitCode = pathDecision.exitCode;
    return;
  }
  const reportPath = pathDecision.path;
  const ownedReportPath = pathDecision.owned;

  if (override !== undefined) {
    // A fixed path cannot be collision-free. The caller asked for it explicitly, so the
    // gate does not refuse, but it says so: two overlapping runs sharing one path would
    // each parse whatever the other wrote.
    console.error(
      `[postgres-gate] note: PG_GATE_JUNIT=${reportPath} is a fixed path. Concurrent gate ` +
        "runs must not share it; the default path (pid + UUID) is unique per run."
    );
  }

  // Clear the path only when this run is authorised to. For the default path the file is
  // ours by construction (pid + UUID); for an override it is only cleared when the caller
  // explicitly set PG_GATE_JUNIT_FORCE=1, which `decideReportPath` has already enforced.
  //
  // The removal exists so that a failure to write is detectable: otherwise a stale file
  // could stand in for a report this run never produced. Failure is fatal and is NOT
  // swallowed, for the same reason.
  if (pathDecision.clearExisting) {
    try {
      await rm(reportPath, { force: true });
    } catch (cleanupError) {
      console.error(
        `[postgres-gate] FAIL (exit 6): cannot clear the report path ${reportPath}: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. ` +
          "Refusing to run, because a report this gate did not write could be read as its result."
      );
      process.exitCode = EXIT.UNREADABLE_REPORT;
      return;
    }
  }

  const args = [
    "--import",
    "tsx",
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=${reportPath}`,
    "--test-concurrency=1",
    suite,
  ];

  const childExitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.on("close", (code, signal) => resolve(signal ? 128 : (code ?? 1)));
    child.on("error", () => resolve(1));
  });

  // Test seam for the crash-classification path (exit 5). See resolveRunnerExit().
  const seam = resolveRunnerExit(childExitCode, process.env.PG_GATE_SIMULATE_RUNNER_EXIT);
  const effectiveExitCode = seam.exitCode;
  if (seam.note) console.error(`[postgres-gate] ${seam.note}`);

  let reportReadable = true;
  let report: JunitReport = {
    wellFormed: false,
    counts: EMPTY_COUNTS,
    problem: "JUnit report could not be read.",
  };
  try {
    report = parseJunit(await readFile(reportPath, "utf8"));
  } catch {
    reportReadable = false;
  }

  const result = decide({
    hasDatabaseUrl,
    childExitCode: effectiveExitCode,
    reportReadable,
    report,
  });

  // Always remove the report, on every path (pass, fail, malformed, unreadable).
  //
  // Only the gate's own per-run file is deleted. A caller-supplied PG_GATE_JUNIT path
  // belongs to the caller: it is left in place so the operator can inspect it, and its
  // existence is never a reason to change a verdict.
  //
  // If removing our own file fails the verdict is PRESERVED — a temp-file problem must
  // not turn a passing suite red — but the failure is reported as a warning and the path
  // is printed, so a leftover file is never silently ignored.
  if (ownedReportPath) {
    try {
      await rm(reportPath, { force: true });
    } catch (cleanupError) {
      console.error(
        `[postgres-gate] warning: could not remove temporary report ${reportPath}: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. ` +
          "The gate result is unchanged; remove the file manually."
      );
    }
  } else {
    console.error(`[postgres-gate] note: PG_GATE_JUNIT report left at ${reportPath} for inspection.`);
  }

  const label = result.ok ? "PASS" : "FAIL";
  const counts = result.counts;
  console.error(
    `\n[postgres-gate] ${label} (exit ${result.exitCode}): ${result.reason}` +
      `\n[postgres-gate] testcases=${counts.testcases} skipped=${counts.skipped}` +
      ` failures=${counts.failures} errors=${counts.errors} runnerExit=${effectiveExitCode}` +
      ` reportWellFormed=${report.wellFormed}\n`
  );

  process.exitCode = result.exitCode;
}

// Only run when invoked directly, so the pure functions can be imported by tests.
// Wrapped in main() rather than using top-level await: this repository compiles to CJS.
if (process.argv[1] && process.argv[1].endsWith("postgres-gate.ts")) {
  main().catch((error: unknown) => {
    console.error("[postgres-gate] unexpected error:", error);
    process.exitCode = EXIT.RUNNER_CRASHED;
  });
}
