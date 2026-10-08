import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/ui/theme-provider";

import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  // `template` makes per-page exports prefix the brand: a page exporting
  // `title: "Runs"` becomes the document title "Runs · Furan". Pages
  // without their own metadata fall back to the `default` below.
  title: {
    default: "Furan",
    template: "%s · Furan",
  },
  description: "Visual regression testing for small teams",
  icons: {
    icon: "/icon.svg",
  },
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Per-request CSP nonce from src/middleware.ts. Reading headers() also makes
  // every page render dynamically — required, since a prerendered page would
  // carry no (or a stale) nonce and the CSP would block its scripts.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        {/*
          Mark JS as available before first paint so scroll-reveal animations
          (.reveal) only hide content when they can actually un-hide it. No-JS
          visitors and non-rendering crawlers never get the class, so the
          landing renders fully visible for them instead of blank.
          suppressHydrationWarning: browsers hide a script's nonce attribute
          after load (it reads back as ""), which React's dev hydration check
          would otherwise report as an attribute mismatch.
        */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('reveal-on')",
          }}
        />
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
