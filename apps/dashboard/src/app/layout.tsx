import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export default function RootLayout({ children }: { children: ReactNode }) {
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
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('reveal-on')",
          }}
        />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
