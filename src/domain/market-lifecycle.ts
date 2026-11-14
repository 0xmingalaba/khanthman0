/**
 * Market lifecycle — a pure state machine, deliberately free of I/O so every
 * transition is unit-testable and no route handler can invent its own rules.
 *
 *   draft -> pending_review -> open -> closed -> proposed -> resolved
 *                                       \-> disputed -> proposed | resolved | voided
 *   Any pre-final state may be voided by an admin (with a reason).
 *
 * Only `open` markets accept orders. `resolved` and `voided` are final.
 */

export type MarketStatus =
  | "draft"
  | "pending_review"
  | "open"
  | "closed"
  | "proposed"
  | "disputed"
  | "resolved"
  | "voided";

export type MarketActor =
  | "creator"
  | "resolver"
  | "moderator"
  | "admin"
  | "system";

export type Transition = {
  from: MarketStatus;
  to: MarketStatus;
  allowedActors: MarketActor[];
  requiresReason: boolean;
};

export const TRANSITIONS: readonly Transition[] = [
  { from: "draft", to: "pending_review", allowedActors: ["creator", "admin"], requiresReason: false },
  { from: "draft", to: "voided", allowedActors: ["admin"], requiresReason: true },
  { from: "pending_review", to: "open", allowedActors: ["moderator", "admin"], requiresReason: false },
  { from: "pending_review", to: "draft", allowedActors: ["moderator", "admin"], requiresReason: true },
  { from: "pending_review", to: "voided", allowedActors: ["moderator", "admin"], requiresReason: true },
  { from: "open", to: "closed", allowedActors: ["system", "resolver", "admin"], requiresReason: false },
  { from: "open", to: "voided", allowedActors: ["admin"], requiresReason: true },
  { from: "closed", to: "proposed", allowedActors: ["resolver", "admin"], requiresReason: false },
  { from: "closed", to: "voided", allowedActors: ["admin"], requiresReason: true },
  { from: "proposed", to: "disputed", allowedActors: ["creator", "moderator", "admin"], requiresReason: true },
  { from: "proposed", to: "resolved", allowedActors: ["resolver", "admin"], requiresReason: false },
  { from: "proposed", to: "voided", allowedActors: ["admin"], requiresReason: true },
  { from: "disputed", to: "proposed", allowedActors: ["moderator", "admin"], requiresReason: true },
  { from: "disputed", to: "resolved", allowedActors: ["admin"], requiresReason: false },
  { from: "disputed", to: "voided", allowedActors: ["admin"], requiresReason: true },
] as const;

export const FINAL_STATUSES: readonly MarketStatus[] = ["resolved", "voided"];

export type TransitionRequest = {
  from: MarketStatus;
  to: MarketStatus;
  actor: MarketActor;
  reason?: string;
};

export type TransitionResult =
  | { ok: true; requiresReason: false }
  | { ok: true; requiresReason: true }
  | { ok: false; code: "not_allowed" | "reason_required" | "terminal"; message: string };

export function canTransition(request: TransitionRequest): TransitionResult {
  if (FINAL_STATUSES.includes(request.from)) {
    return {
      ok: false,
      code: "terminal",
      message: `A ${request.from} market cannot change state.`,
    };
  }
  const transition = TRANSITIONS.find((t) => t.from === request.from && t.to === request.to);
  if (!transition) {
    return {
      ok: false,
      code: "not_allowed",
      message: `Cannot move a market from ${request.from} to ${request.to}.`,
    };
  }
  if (!transition.allowedActors.includes(request.actor)) {
    return {
      ok: false,
      code: "not_allowed",
      message: `A ${request.actor} cannot move a market from ${request.from} to ${request.to}.`,
    };
  }
  if (transition.requiresReason && !request.reason?.trim()) {
    return { ok: false, code: "reason_required", message: "A reason is required for this change." };
  }
  return { ok: true, requiresReason: transition.requiresReason };
}

/** Markets in these states accept new orders. */
export function isTradingAllowed(status: MarketStatus, closeAt: Date, now: Date): boolean {
  return status === "open" && now.getTime() < closeAt.getTime();
}

/** Order-book visibility: only markets past draft are publicly discoverable. */
export function isPubliclyVisible(status: MarketStatus): boolean {
  return status !== "draft" && status !== "pending_review";
}
