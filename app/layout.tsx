import type { Metadata } from "next";
import "@fontsource/noto-sans-myanmar/400.css";
import "@fontsource/noto-sans-myanmar/500.css";
import "@fontsource/noto-sans-myanmar/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mingala — Myanmar Prediction Market",
  description: "Explore questions about the future with Mingala Prediction Market.",
  applicationName: "Mingala"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
