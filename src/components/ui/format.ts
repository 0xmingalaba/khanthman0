"use client";

/**
 * Display formatting shared by every component.
 *
 * Everything renders through the integer-based helpers in src/lib/money.ts, so
 * the DOM can never show a cent glyph or a float artefact for a Pya amount.
 */

import { formatPya, formatPyaPrice, formatShares, localizeDigits } from "@/src/lib/money";
import type { Locale } from "@/src/lib/locale";

const MY_MONTHS = [
  "ဇန်နဝါရီ", "ဖေဖော်ဝါရီ", "မတ်", "ဧပြီ", "မေ", "ဇွန်",
  "ဇူလိုင်", "ဩဂုတ်", "စက်တင်ဘာ", "အောက်တိုဘာ", "နိုဝင်ဘာ", "ဒီဇင်ဘာ",
];
const EN_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Myanmar time is UTC+06:30 and is the product default. */
export const MYANMAR_OFFSET_MINUTES = 390;

function myanmarParts(iso: string, offsetMinutes = MYANMAR_OFFSET_MINUTES) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** Short date in the user's language, e.g. "ဒီဇင်ဘာ ၃၁" / "Dec 31". */
export function formatDate(iso: string, locale: Locale, includeYear = false): string {
  const parts = myanmarParts(iso);
  if (!parts) return iso;
  const month = locale === "my" ? MY_MONTHS[parts.month] : EN_MONTHS[parts.month];
  const day = localizeDigits(String(parts.day), locale);
  const year = includeYear ? ` ${localizeDigits(String(parts.year), locale)}` : "";
  return `${month} ${day}${year}`;
}

/** Date and time with an explicit timezone marker. */
export function formatDateTime(iso: string, locale: Locale): string {
  const parts = myanmarParts(iso);
  if (!parts) return iso;
  const time = localizeDigits(
    `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
    locale
  );
  return `${formatDate(iso, locale, true)} ${time}${locale === "my" ? " (မြန်မာစံတော်ချိန်)" : " MMT"}`;
}

/** "3 days left", "2 hours left", "Closed". */
export function formatTimeLeft(iso: string, locale: Locale, now = Date.now()): string {
  const close = new Date(iso).getTime();
  if (Number.isNaN(close)) return "";
  const diff = close - now;
  if (diff <= 0) return locale === "my" ? "ပိတ်ပြီး" : "Closed";

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const value = (n: number) => localizeDigits(String(n), locale);
  if (days >= 1) return locale === "my" ? `${value(days)} ရက်ကျန်` : `${value(days)}d left`;
  if (hours >= 1) return locale === "my" ? `${value(hours)} နာရီကျန်` : `${value(hours)}h left`;
  return locale === "my" ? `${value(Math.max(minutes, 1))} မိနစ်ကျန်` : `${value(Math.max(minutes, 1))}m left`;
}

export function money(pyas: number, locale: Locale): string {
  return formatPya(pyas, locale);
}

export function price(pyas: number, locale: Locale): string {
  return formatPyaPrice(pyas, locale);
}

export function shares(quantity: number, locale: Locale): string {
  return formatShares(quantity, locale);
}

/** Number with localized digits and thousands separators. */
export function number(value: number, locale: Locale): string {
  const grouped = Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return localizeDigits(grouped, locale);
}

export function probability(value: number | null, locale: Locale): string {
  if (value === null) return locale === "my" ? "ဈေးမရှိသေး" : "No price yet";
  return `${localizeDigits(String(value), locale)}%`;
}
