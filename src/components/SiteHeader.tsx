"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/src/lib/locale";
import { localePath, otherLocaleOf } from "@/src/lib/locale";
import type { Dictionary } from "@/src/i18n/dictionary";
import type { SessionUser } from "@/src/lib/api-client";
import { money } from "@/src/components/ui/format";
import { ThemeToggle } from "@/src/components/ThemeToggle";

type Props = {
  locale: Locale;
  t: Dictionary;
  user: SessionUser | null;
  availablePya: number | null;
  onLogout: () => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  showSearch?: boolean;
};

/**
 * Global header: brand, search, primary links, account actions and a locale
 * switch that preserves the current page instead of dumping the user on home.
 */
export function SiteHeader({
  locale,
  t,
  user,
  availablePya,
  onLogout,
  searchValue = "",
  onSearchChange,
  showSearch = true,
}: Props) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [menuOpen]);

  return (
    <header className="topbar">
      <Link className="brand" href={`/${locale}`} aria-label={t.brand.fullName}>
        <span className="brand-mark" aria-hidden="true">
          <span />
        </span>
        <span className="brand-word">{t.brand.name}</span>
      </Link>

      {showSearch && onSearchChange ? (
        <label className="top-search">
          <span className="search-glyph" aria-hidden="true">
            ⌕
          </span>
          <input
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t.nav.searchPlaceholder}
            aria-label={t.nav.search}
            type="search"
          />
        </label>
      ) : (
        <span className="top-search-spacer" />
      )}

      <nav className="header-links" aria-label={t.nav.moreNav}>
        <Link href={`/${locale}/how-it-works`} className="how-link">
          <span className="info-icon" aria-hidden="true">
            i
          </span>
          {t.nav.howItWorks}
        </Link>
      </nav>

      <div className="auth-actions">
        {user ? (
          <>
            <Link className="balance-pill" href={`/${locale}/portfolio`}>
              <span>{t.portfolio.available}</span>
              <strong>{availablePya === null ? "—" : money(availablePya, locale)}</strong>
            </Link>
            <Link className="login-button" href={`/${locale}/portfolio`}>
              {t.nav.portfolio}
            </Link>
            <button type="button" className="signup-button" onClick={onLogout}>
              {t.nav.logout}
            </button>
          </>
        ) : (
          <>
            <Link className="login-button" href={`/${locale}/login`}>
              {t.nav.login}
            </Link>
            <Link className="signup-button" href={`/${locale}/signup`}>
              {t.nav.signup}
            </Link>
          </>
        )}
        <ThemeToggle t={t} />
      </div>

      <div className="menu-wrap">
        <button
          ref={triggerRef}
          type="button"
          className="menu-trigger"
          aria-label={menuOpen ? t.nav.closeMenu : t.nav.openMenu}
          aria-expanded={menuOpen}
          aria-haspopup="true"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
        </button>
        {menuOpen && (
          <div ref={menuRef} className="nav-dropdown menu-dropdown" role="menu" aria-label={t.nav.moreNav}>
            <Link role="menuitem" href={`/${locale}`} onClick={() => setMenuOpen(false)}>
              {t.nav.explore}
            </Link>
            <Link role="menuitem" href={`/${locale}/portfolio`} onClick={() => setMenuOpen(false)}>
              {t.nav.portfolio}
            </Link>
            <Link role="menuitem" href={`/${locale}/how-it-works`} onClick={() => setMenuOpen(false)}>
              {t.nav.howItWorks}
            </Link>
            <Link
              role="menuitem"
              href={localePath(pathname || "/", otherLocaleOf(locale))}
              onClick={() => setMenuOpen(false)}
            >
              {t.nav.language}
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
