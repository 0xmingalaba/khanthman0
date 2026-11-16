import type { Metadata, Viewport } from "next";
import "@fontsource/noto-sans-myanmar/400.css";
import "@fontsource/noto-sans-myanmar/500.css";
import "@fontsource/noto-sans-myanmar/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Khant Hman Prediction Market",
  description: "Explore questions about the future with Khant Hman Prediction Market. Virtual credits only.",
  applicationName: "Khant Hman",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1514" },
  ],
  width: "device-width",
  initialScale: 1,
};

/**
 * The root layout does not declare a language: each locale segment sets `lang`
 * on its own wrapper so `/en` is never served as Burmese.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="my">
      <body>
        {/* Pre-paint theme stamp (Phase 2A, roadmap 2A.5 no-flash). Reads the
            device-local persisted choice, falling back to the OS preference,
            and sets data-theme before first paint. Persistence mechanism is
            D-08 (PARKED) — currently the spec's non-binding localStorage
            placeholder; it may be swapped when D-08 is answered. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var d=window.localStorage.getItem('khanthman-theme');" +
              "if(d!=='light'&&d!=='dark'){d=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}" +
              "document.documentElement.dataset.theme=d;}catch(e){}})();",
          }}
        />
        <a className="skip-link" href="#markets">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
