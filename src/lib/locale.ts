/**
 * Locale plumbing.
 *
 * One place that knows how a URL maps to a locale and back, so links between
 * pages never silently drop the user's language (the prototype used a hard page
 * reload to switch locale, which lost the current view).
 */

export const LOCALES = ["my", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "my";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Replace, rather than prefix, the locale segment of a path. */
export function localePath(path: string, locale: Locale): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const segments = clean.split("/").filter(Boolean);
  if (isLocale(segments[0])) segments[0] = locale;
  else segments.unshift(locale);
  return `/${segments.join("/")}`;
}

/** The same page in the other language, preserving every other segment. */
export function otherLocaleOf(locale: Locale): Locale {
  return locale === "my" ? "en" : "my";
}

/** Strip the locale prefix to obtain the locale-independent path. */
export function stripLocale(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (isLocale(segments[0])) segments.shift();
  return `/${segments.join("/")}`;
}
