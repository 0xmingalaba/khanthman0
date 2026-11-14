/**
 * Password hashing with scrypt (Node's built-in KDF; no third-party dependency).
 *
 * Format: scrypt-v1$N$r$p$keylen$<salt base64>$<hash base64>
 *
 * Parameters are stored with the hash so they can be raised later without
 * invalidating existing credentials. Verification is timing-safe.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

export const PASSWORD_ALGO = "scrypt-v1";

/** OWASP-recommended baseline (N=2^15, r=8, p=3). Deliberately slow. */
const DEFAULT_PARAMS = { N: 2 ** 15, r: 8, p: 3, keylen: 64 } as const;
const SALT_BYTES = 16;
const MAX_MEMORY = 256 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordError";
  }
}

/**
 * Validate a password's shape. Length is the primary control (NIST 800-63B);
 * we do not impose composition rules, but we reject the obvious worst choices.
 */
export function validatePassword(password: unknown): string {
  if (typeof password !== "string") throw new PasswordError("Password must be text.");
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (!password.trim()) throw new PasswordError("Password must not be blank.");
  if (/^(.)\1+$/.test(password)) throw new PasswordError("Password is too repetitive.");
  return password;
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keylen } = DEFAULT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize("NFKC"), salt, keylen, {
    N,
    r,
    p,
    maxmem: MAX_MEMORY,
  });
  return [
    PASSWORD_ALGO,
    N,
    r,
    p,
    keylen,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

type ParsedHash = {
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: Buffer;
  hash: Buffer;
};

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== PASSWORD_ALGO) return null;
  const [, nRaw, rRaw, pRaw, keylenRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  const keylen = Number(keylenRaw);
  if (![N, r, p, keylen].every(Number.isSafeInteger)) return null;
  if (N < 2 ** 12 || N > 2 ** 20 || r < 1 || p < 1 || keylen < 32 || keylen > 128) return null;
  try {
    return {
      N,
      r,
      p,
      keylen,
      salt: Buffer.from(saltRaw, "base64"),
      hash: Buffer.from(hashRaw, "base64"),
    };
  } catch {
    return null;
  }
}

/** Constant-time verification. Returns false (never throws) on malformed input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const derived = await scrypt(password.normalize("NFKC"), parsed.salt, parsed.keylen, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAX_MEMORY,
  });
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/** True when a stored hash was produced with weaker parameters than current policy. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.N < DEFAULT_PARAMS.N || parsed.p < DEFAULT_PARAMS.p;
}

/**
 * Burn roughly the same time as a real verification when the account does not
 * exist, so login timing does not reveal which emails are registered.
 */
export async function dummyVerify(): Promise<void> {
  await scrypt("mingala-dummy-password", randomBytes(SALT_BYTES), DEFAULT_PARAMS.keylen, {
    N: DEFAULT_PARAMS.N,
    r: DEFAULT_PARAMS.r,
    p: DEFAULT_PARAMS.p,
    maxmem: MAX_MEMORY,
  });
}
