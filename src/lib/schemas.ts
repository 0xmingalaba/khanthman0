/**
 * Zod schemas for every request body.
 *
 * These are the only place that untrusted input shapes are declared. Domain
 * services additionally re-validate financial integers, so a schema change can
 * never weaken the money invariants.
 */

import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/src/auth/password";

export const registerSchema = z.object({
  email: z.string().trim().min(3).max(254).email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  displayName: z.string().trim().min(1).max(60),
  locale: z.enum(["my", "en"]).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().min(3).max(254).email(),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

/** Idempotency keys are client-generated; we only constrain their shape. */
const idempotencyKey = z.string().trim().min(8).max(100);

export const placeOrderSchema = z.object({
  marketId: z.string().uuid(),
  side: z.enum(["YES", "NO"]),
  action: z.enum(["BUY", "SELL"]),
  pricePya: z.number().int().min(1).max(99),
  quantity: z.number().int().min(1).max(1_000_000_000),
  idempotencyKey,
});

export const cancelOrderSchema = z.object({
  orderId: z.string().uuid(),
  idempotencyKey,
});

export const updatePreferencesSchema = z.object({
  locale: z.enum(["my", "en"]).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type PlaceOrderBody = z.infer<typeof placeOrderSchema>;
export type CancelOrderBody = z.infer<typeof cancelOrderSchema>;
