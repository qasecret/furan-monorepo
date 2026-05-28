"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";

import { TourProvider } from "@/components/tour/tour-context";
import { TourOverlay } from "@/components/tour/tour-overlay";
import { browserEnv } from "@/lib/env";
import { trpc } from "@/lib/trpc";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${browserEnv.NEXT_PUBLIC_API_URL}/trpc`,
          fetch: (url, opts) => fetch(url, { ...opts, credentials: "include" }),
        }),
      ],
    }),
  );

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="furan-theme"
      disableTransitionOnChange
    >
      <trpc.Provider client={client} queryClient={qc}>
        <QueryClientProvider client={qc}>
          <TourProvider>
            {children}
            <TourOverlay />
          </TourProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
