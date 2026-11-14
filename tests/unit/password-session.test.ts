import test from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD_MIN_LENGTH,
  PasswordError,
  hashPassword,
  needsRehash,
  validatePassword,
  verifyPassword,
} from "@/src/auth/password";
import { createSessionToken, hashToken } from "@/src/auth/session";

test("password policy rejects short, blank and repeat-only passwords", () => {
  assert.throws(() => validatePassword("short"), PasswordError);
  assert.throws(() => validatePassword(" ".repeat(PASSWORD_MIN_LENGTH + 2)), PasswordError);
  assert.throws(() => validatePassword("a".repeat(PASSWORD_MIN_LENGTH)), PasswordError);
  assert.throws(() => validatePassword(12345678901 as unknown), PasswordError);
  assert.equal(validatePassword("a much better passphrase"), "a much better passphrase");
});

test("hashing is salted, slow-parameterised and verifies correctly", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.notEqual(first, second, "two hashes of the same password must differ (unique salt)");
  assert.ok(first.startsWith("scrypt-v1$"));
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password entirely", first), false);
  assert.ok(!first.includes("correct horse"), "hash must not contain the plaintext");
});

test("verification fails closed on malformed or downgraded hashes", async () => {
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", "scrypt-v1$1$1$1$64$aaaa$bbbb"), false);
  assert.equal(await verifyPassword("x", "bcrypt$whatever"), false);
  // Weak parameters must be flagged for upgrade, not silently accepted as strong.
  assert.equal(needsRehash("scrypt-v1$4096$8$1$64$YWJj$ZGVm"), true);
});

test("session tokens are 256-bit, unique and stored only as a hash", () => {
  const a = createSessionToken();
  const b = createSessionToken();
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 43);
  assert.equal(a.tokenHash.length, 32);
  assert.ok(a.tokenHash.equals(hashToken(a.token)));
  assert.ok(!a.tokenHash.toString("utf8").includes(a.token));
  assert.equal(hashToken(a.token).equals(hashToken(b.token)), false);
});
