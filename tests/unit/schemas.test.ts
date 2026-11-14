import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelOrderSchema,
  loginSchema,
  placeOrderSchema,
  registerSchema,
} from "@/src/lib/schemas";

test("registration schema rejects short passwords and malformed emails", () => {
  assert.equal(registerSchema.safeParse({ email: "a@b.co", password: "short", displayName: "X" }).success, false);
  assert.equal(registerSchema.safeParse({ email: "nope", password: "a long enough pass", displayName: "X" }).success, false);
  assert.equal(registerSchema.safeParse({ email: "a@b.co", password: "a long enough pass", displayName: "" }).success, false);
  assert.equal(
    registerSchema.safeParse({ email: "a@b.co", password: "a long enough pass", displayName: "Ok" }).success,
    true
  );
});

test("login schema accepts any non-empty password but bounds its length", () => {
  assert.equal(loginSchema.safeParse({ email: "a@b.co", password: "" }).success, false);
  assert.equal(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(201) }).success, false);
  assert.equal(loginSchema.safeParse({ email: "a@b.co", password: "x" }).success, true);
});

test("order schema enforces integer price ticks and positive share counts", () => {
  const base = {
    marketId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    side: "YES",
    action: "BUY",
    idempotencyKey: "key-12345678",
  };
  assert.equal(placeOrderSchema.safeParse({ ...base, pricePya: 50, quantity: 10 }).success, true);
  for (const bad of [
    { pricePya: 0, quantity: 10 },
    { pricePya: 100, quantity: 10 },
    { pricePya: 50.5, quantity: 10 },
    { pricePya: 50, quantity: 0 },
    { pricePya: 50, quantity: -5 },
    { pricePya: 50, quantity: 1.5 },
    { pricePya: 50, quantity: 10, side: "MAYBE" },
    { pricePya: 50, quantity: 10, action: "SHORT" },
    { pricePya: 50, quantity: 10, marketId: "not-a-uuid" },
    { pricePya: 50, quantity: 10, idempotencyKey: "short" },
  ]) {
    assert.equal(placeOrderSchema.safeParse({ ...base, ...bad }).success, false, JSON.stringify(bad));
  }
});

test("order schema refuses unknown fields that could smuggle a user id", () => {
  const parsed = placeOrderSchema.safeParse({
    marketId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    side: "YES",
    action: "BUY",
    pricePya: 50,
    quantity: 10,
    idempotencyKey: "key-12345678",
    userId: "attacker-supplied",
    role: "admin",
  });
  assert.equal(parsed.success, true);
  // Zod strips unknown keys by default, so the server never sees them.
  assert.equal(Object.hasOwn(parsed.data as object, "userId"), false);
  assert.equal(Object.hasOwn(parsed.data as object, "role"), false);
});

test("cancel schema requires a uuid order id", () => {
  assert.equal(cancelOrderSchema.safeParse({ orderId: "nope", idempotencyKey: "key-12345678" }).success, false);
  assert.equal(
    cancelOrderSchema.safeParse({
      orderId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      idempotencyKey: "key-12345678",
    }).success,
    true
  );
});
