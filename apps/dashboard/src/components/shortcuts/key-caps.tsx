import { Fragment, type JSX } from "react";

import { cn } from "@/lib/cn";

/**
 * Key caps, as the `?` sheet and the palette show a command's keys. One
 * component for both, so the two can't drift apart.
 */

/** `formatKeys`' word between the steps of a sequence ("G then I"). */
const SEQUENCE_WORD = "then";

const KEY_CAP =
  "min-w-6 rounded border border-edge bg-sunken px-1.5 py-0.5 text-center font-mono text-xs";

/** One key, as `formatKeys` gives its tokens. */
export interface ShownKey {
  tokens: string[];
  /** It does nothing right now (single-key shortcuts are off): muted. */
  off?: boolean;
}

/** One key: each token on its own cap, "then" as plain text between them. */
export function KeyCaps({ tokens, off = false }: ShownKey): JSX.Element {
  return (
    <kbd className="inline-flex items-center gap-1">
      {tokens.map((token, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          {token === SEQUENCE_WORD ? (
            <span className="font-sans text-fg-muted">{token}</span>
          ) : (
            <kbd className={cn(KEY_CAP, off ? "text-fg-muted" : "text-fg")}>
              {token}
            </kbd>
          )}
        </Fragment>
      ))}
    </kbd>
  );
}

/**
 * A command's keys, "/" between the alternatives. `offNote` follows each key
 * that is off.
 */
export function KeyChoices({
  keys,
  offNote,
}: {
  keys: ShownKey[];
  offNote?: string;
}): JSX.Element {
  return (
    <>
      {keys.map((key, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span aria-hidden="true" className="text-fg-muted">
              /
            </span>
          )}
          <span className="inline-flex flex-wrap items-center gap-1">
            <KeyCaps tokens={key.tokens} off={key.off ?? false} />
            {key.off && offNote ? (
              <span className="text-fg-muted">{offNote}</span>
            ) : null}
          </span>
        </Fragment>
      ))}
    </>
  );
}
