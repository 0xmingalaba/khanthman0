import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

/**
 * Windows 11 starters cannot run POSIX shell syntax (`VAR=x cmd && other`),
 * which the previous `dev:pglite` script used. These tests pin the
 * cross-platform contract: the script must delegate to a Node runner that
 * spawns children without a shell and with plain argument arrays.
 */

const root = process.cwd();

describe("dev:pglite cross-platform contract", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  test("package.json dev:pglite delegates to a Node runner, not shell syntax", () => {
    const script = pkg.scripts["dev:pglite"];
    assert.equal(script, "node scripts/dev-pglite.mjs");
    // No POSIX env-var prefix (VAR=value cmd) and no shell chaining.
    assert.doesNotMatch(script, /(^|\s)[A-Za-z_][A-Za-z0-9_]*=\S/);
    assert.doesNotMatch(script, /&&|\|\||;/);
  });

  test("the runner uses process.execPath with argument arrays and no shell", () => {
    const runner = readFileSync(resolve(root, "scripts/dev-pglite.mjs"), "utf8");
    assert.match(runner, /process\.execPath/);
    // No shell-mode spawn and no OS-specific path separator assumptions.
    assert.doesNotMatch(runner, /shell:\s*true/);
    assert.doesNotMatch(runner, /"next\s+dev"/); // "next" resolved via node_modules path
    assert.match(runner, /next["'],\s*["']dist["'],\s*["']bin["'],\s*["']next["']/);
    // Seed must run before the dev server and abort on failure.
    assert.match(runner, /cli\.ts["'],\s*["']seed["']/);
  });
});
