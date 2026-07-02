"use client";

import { useEffect } from "react";

/**
 * Last-resort error boundary. Next.js renders this only when the ROOT layout
 * itself throws (segment-level `error.tsx` handles everything below it), so it
 * must provide its own <html>/<body>. Deliberately dependency-free — the app
 * shell and providers may be exactly what failed — so it uses inline styles
 * rather than Tailwind/components.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("global_error", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#09090b",
          color: "#e4e4e7",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem", maxWidth: 480 }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            The app failed to load
          </h1>
          <p style={{ fontSize: "0.875rem", color: "#a1a1aa" }}>
            An unexpected error occurred while starting the app. Please try
            again.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: "1.25rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "none",
              background: "#a8ff53",
              color: "#000",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
