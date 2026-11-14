import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  isPubliclyVisible,
  isTradingAllowed,
  type MarketStatus,
} from "@/src/domain/market-lifecycle";

test("the documented happy path is allowed", () => {
  const path: MarketStatus[] = ["draft", "pending_review", "open", "closed", "proposed", "resolved"];
  const actors = ["creator", "moderator", "resolver", "resolver", "resolver"] as const;
  for (let i = 0; i < path.length - 1; i += 1) {
    const result = canTransition({ from: path[i], to: path[i + 1], actor: actors[i] });
    assert.equal(result.ok, true, `${path[i]} -> ${path[i + 1]} should be allowed`);
  }
});

test("a market cannot skip review to open", () => {
  const result = canTransition({ from: "draft", to: "open", actor: "admin" });
  assert.equal(result.ok, false);
});

test("only admins may void a market, and a reason is mandatory", () => {
  assert.equal(canTransition({ from: "open", to: "voided", actor: "resolver", reason: "x" }).ok, false);
  const missingReason = canTransition({ from: "open", to: "voided", actor: "admin" });
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.ok === false && missingReason.code, "reason_required");
  assert.equal(canTransition({ from: "open", to: "voided", actor: "admin", reason: "bad data" }).ok, true);
});

test("final states are terminal", () => {
  for (const from of ["resolved", "voided"] as MarketStatus[]) {
    const result = canTransition({ from, to: "proposed", actor: "admin", reason: "try" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "terminal");
  }
});

test("a creator cannot resolve their own market", () => {
  assert.equal(canTransition({ from: "proposed", to: "resolved", actor: "creator" }).ok, false);
  assert.equal(canTransition({ from: "proposed", to: "resolved", actor: "resolver" }).ok, true);
});

test("trading is only allowed while open and before close", () => {
  const close = new Date("2026-12-31T00:00:00Z");
  assert.equal(isTradingAllowed("open", close, new Date("2026-06-01T00:00:00Z")), true);
  assert.equal(isTradingAllowed("open", close, new Date("2027-01-01T00:00:00Z")), false);
  assert.equal(isTradingAllowed("closed", close, new Date("2026-06-01T00:00:00Z")), false);
  assert.equal(isTradingAllowed("proposed", close, new Date("2026-06-01T00:00:00Z")), false);
});

test("drafts and pending markets are not publicly visible", () => {
  assert.equal(isPubliclyVisible("draft"), false);
  assert.equal(isPubliclyVisible("pending_review"), false);
  assert.equal(isPubliclyVisible("open"), true);
  assert.equal(isPubliclyVisible("resolved"), true);
});
