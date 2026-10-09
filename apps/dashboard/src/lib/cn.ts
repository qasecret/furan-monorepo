import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's default scale. Teach it the token
 * utilities from tokens.css, or it misfiles them: `shadow-raised` would read
 * as a shadow colour (so a later `shadow-black/10` drops the elevation and a
 * later `shadow-none` doesn't replace it) and `rounded-overlay` as an unknown
 * class (so `rounded-md` doesn't replace it). Colour tokens (`bg-raised`,
 * `text-fg-muted`, ...) already merge as colours and need nothing here.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [{ shadow: ["raised", "overlay", "brand-edge"] }],
      rounded: [{ rounded: ["overlay"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
