import type { Metadata, Viewport } from "next";
import "@fontsource/noto-sans-myanmar/400.css";
import "@fontsource/noto-sans-myanmar/500.css";
import "@fontsource/noto-sans-myanmar/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nan Htauk Prediction Market",
  description: "Explore questions about the future with Nan Htauk Prediction Market. Virtual credits only.",
  applicationName: "Nan Htauk",
};

export const viewport: Viewport = {
  themeColor: "#050912",
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
        <a className="skip-link" href="#markets">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
