/**
 * Money primitives for Mingala.
 *
 * Hard rules (see docs/FINANCIAL-SPEC.md):
 *  - The atomic unit is the Pya. 1 MMK = 100 Pyas.
 *  - Every stored amount is an integer count of Pyas. No floats, ever.
 *  - Prices are integer Pyas in [1, 99]; quantities are positive integers.
 *  - A winning share pays exactly 100 Pyas; a losing share pays 0.
 *
 * Branded types are used so the compiler refuses to mix Pyas with shares or
 * with a raw MMK figure that has not been converted.
 */

declare const pyaBrand: unique symbol;
declare const sharesBrand: unique symbol;

/** An integer amount of Pyas. */
export type Pya = number & { readonly [pyaBrand]: true };
/** An integer number of shares. */
export type Shares = number & { readonly [sharesBrand]: true };

export const PYA_PER_MMK = 100;
export const PAYOUT_PER_SHARE_PYA = 100;
export const MIN_PRICE_PYA = 1;
export const MAX_PRICE_PYA = 99;

/** Largest amount we accept anywhere; keeps all arithmetic inside the safe-integer range. */
export const MAX_AMOUNT_PYA = 1_000_000_000_000; // 10 billion MMK
export const MAX_SHARES = 1_000_000_000;

export class MoneyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}

const isSafeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/** Assert an arbitrary value is a safe integer within [min, max]. */
export function assertIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  label: string
): number {
  if (!isSafeInt(value)) {
    throw new MoneyError("not_integer", `${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new MoneyError("out_of_range", `${label} must be between ${min} and ${max}`);
  }
  return value;
}

/** Construct a Pya amount from a validated integer. */
export function pya(value: number | bigint): Pya {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!isSafeInt(n)) throw new MoneyError("not_integer", "Pya amount must be a safe integer");
  if (n < 0) throw new MoneyError("negative_amount", "Pya amount must not be negative");
  if (n > MAX_AMOUNT_PYA) throw new MoneyError("out_of_range", "Pya amount is too large");
  return n as Pya;
}

/** Construct a signed Pya amount (ledger deltas may be negative). */
export function signedPya(value: number | bigint): Pya {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!isSafeInt(n)) throw new MoneyError("not_integer", "Pya amount must be a safe integer");
  if (n > MAX_AMOUNT_PYA || n < -MAX_AMOUNT_PYA) {
    throw new MoneyError("out_of_range", "Pya amount is too large");
  }
  return n as Pya;
}

export function shares(value: number | bigint): Shares {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!isSafeInt(n)) throw new MoneyError("not_integer", "Share quantity must be a safe integer");
  if (n < 1) throw new MoneyError("out_of_range", "Share quantity must be at least 1");
  if (n > MAX_SHARES) throw new MoneyError("out_of_range", "Share quantity is too large");
  return n as Shares;
}

/** Validate a limit price: integer Pyas within the inclusive tick range. */
export function price(value: number | bigint): Pya {
  const n = typeof value === "bigint" ? Number(value) : value;
  assertIntegerInRange(n, MIN_PRICE_PYA, MAX_PRICE_PYA, "Price");
  return n as Pya;
}

/** Convert an MMK amount (integer or up to two decimals) into Pyas. */
export function mmkToPya(input: string | number): Pya {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new MoneyError("not_finite", "MMK amount must be finite");
    if (input < 0) throw new MoneyError("negative_amount", "MMK amount must not be negative");
    // Round half-up on the exact decimal representation to avoid binary drift.
    const pyas = Math.round(Number(input.toFixed(2)) * PYA_PER_MMK);
    return pya(pyas);
  }

  const raw = input.trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
    throw new MoneyError("invalid_mmk", "MMK amount must be a positive number with at most 2 decimals");
  }
  const [whole, fraction = ""] = raw.split(".");
  const wholePyas = Number(whole) * PYA_PER_MMK;
  const fractionPyas = Number(fraction.padEnd(2, "0"));
  return pya(wholePyas + fractionPyas);
}

/** Convert Pyas to an exact MMK decimal string, e.g. 1234567 -> "12345.67". */
export function pyaToMmkString(amount: Pya | number): string {
  const n = Math.trunc(amount);
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / PYA_PER_MMK);
  const fraction = String(abs % PYA_PER_MMK).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** price * quantity with overflow and integer-safety checks. */
export function costOf(unitPrice: Pya | number, quantity: Shares | number): Pya {
  const result = (unitPrice as number) * (quantity as number);
  if (!Number.isSafeInteger(result)) throw new MoneyError("overflow", "Amount is too large");
  return pya(result);
}

/** A winning position pays 100 Pyas per share. */
export function payoutOf(quantity: Shares | number): Pya {
  const result = (quantity as number) * PAYOUT_PER_SHARE_PYA;
  if (!Number.isSafeInteger(result)) throw new MoneyError("overflow", "Payout is too large");
  return pya(result);
}

/**
 * Integer average price, rounded for display only.
 * Never use this value in further accounting; it exists to render a summary.
 */
export function displayAveragePrice(totalCost: number, quantity: number): number {
  if (!isSafeInt(quantity) || quantity <= 0) return 0;
  if (!isSafeInt(totalCost) || totalCost < 0) throw new MoneyError("invalid_cost", "Cost basis is invalid");
  return Math.round(totalCost / quantity);
}

/** Complement of a YES price is the NO price, and vice versa. */
export function complementPrice(unitPrice: Pya | number): Pya {
  return price(PAYOUT_PER_SHARE_PYA - (unitPrice as number));
}

const MYANMAR_DIGITS: Record<string, string> = {
  "0": "၀", "1": "၁", "2": "၂", "3": "၃", "4": "၄",
  "5": "၅", "6": "၆", "7": "၇", "8": "၈", "9": "၉",
};

export function localizeDigits(value: string, locale: "en" | "my"): string {
  return locale === "my" ? value.replace(/[0-9]/g, (digit) => MYANMAR_DIGITS[digit] ?? digit) : value;
}

export function groupThousands(integer: string): string {
  const negative = integer.startsWith("-");
  const body = negative ? integer.slice(1) : integer;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/** Format Pyas as MMK for display, with locale-appropriate digits and suffix. */
export function formatPya(amount: Pya | number, locale: "en" | "my"): string {
  const mmk = pyaToMmkString(amount);
  const [whole, fraction] = mmk.split(".");
  const grouped = `${groupThousands(whole)}.${fraction}`;
  const localized = localizeDigits(grouped, locale);
  return locale === "my" ? `${localized} ကျပ်` : `K ${localized}`;
}

/** Format a bare Pya price for display, e.g. "34 Pyas" / "၃၄ ပြား". */
export function formatPyaPrice(amount: Pya | number, locale: "en" | "my"): string {
  const localized = localizeDigits(String(Math.trunc(amount)), locale);
  return locale === "my" ? `${localized} ပြား` : `${localized} Pyas`;
}

export function formatShares(quantity: Shares | number, locale: "en" | "my"): string {
  return localizeDigits(groupThousands(String(Math.trunc(quantity))), locale);
}

/** Safe integer parse from an untrusted string (query params, form input). */
export function parseIntStrict(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?\d{1,16}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
