"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Gives the focus on when the button holding it goes away with its card: a
 * deleted component's layout cleanup runs before its DOM is removed, so the
 * button still has the focus there, if it had it. The latest `onFocusLost` is
 * the one called.
 */
export function useFocusHandoff(
  button: RefObject<HTMLButtonElement | null>,
  onFocusLost?: () => void,
): void {
  const focusLost = useRef(onFocusLost);
  useLayoutEffect(() => {
    focusLost.current = onFocusLost;
  });
  useLayoutEffect(() => {
    const el = button.current;
    return () => {
      if (el !== null && el === document.activeElement) focusLost.current?.();
    };
  }, [button]);
}
