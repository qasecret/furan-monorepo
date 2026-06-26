"use client";

import { useEffect, useState } from "react";

import { browserEnv } from "@/lib/env";

/**
 * Fetches a storage object by its key through the authed image proxy and
 * returns an object-URL for it (null until loaded / on error). The batch-detail
 * step cards use this to render checkpoint thumbnails with the same credentialed
 * fetch the diff viewer uses. The blob URL is revoked on unmount, with a 10s
 * grace so async consumers can finish loading from it first.
 */
export function useAuthedImage(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    let active = true;
    let createdUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(
          `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/storage/${key}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          if (active) setUrl(null);
          return;
        }
        const blob = await res.blob();
        if (!active) return;
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
      } catch {
        if (active) setUrl(null);
      }
    })();
    return () => {
      active = false;
      if (createdUrl) {
        const toRevoke = createdUrl;
        setTimeout(() => URL.revokeObjectURL(toRevoke), 10_000);
      }
    };
  }, [key]);
  return url;
}
