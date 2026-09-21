'use client';

/**
 * Make an overlay behave like a page you can back out of.
 *
 * A dialog is a state change, not a navigation, so the phone's back button walked
 * off the *page* underneath while a transaction's detail was open - you pressed
 * back to close it and lost the list you were reading. Pushing a history entry
 * when it opens makes back mean what it looks like it means.
 *
 * There is exactly one way out, and it is the browser's: `popstate` is the only
 * thing that calls `onClose`, and everything else - a Cancel button, a click on
 * the backdrop, Escape, a successful save - asks for `history.back()` and lets the
 * pop do the closing. That matters more than it sounds.
 *
 * The first version undid its own history entry from the effect's cleanup, which
 * broke the dialog outright under React's Strict Mode. Strict Mode mounts, cleans
 * up, and mounts again; the cleanup's `history.back()` resolved *after* the second
 * mount had installed its listener, so the dialog closed itself the instant it
 * opened. A flicker and nothing else. Cleanup now only removes listeners - it
 * touches no history at all - so there is no stray pop to catch.
 *
 * The cost is one dead history entry per overlay in development, where Strict Mode
 * pushes twice. In production it pushes once and the stack comes out even.
 */

import { useCallback, useEffect, useRef } from 'react';

/** Returns the function to call instead of `onClose`, from anywhere in the overlay. */
export function useOverlay(onClose: () => void): () => void {
  // In a ref so the effect never re-runs - and never re-pushes - just because the
  // parent handed down a fresh closure.
  const close = useRef(onClose);
  close.current = onClose;
  const pushed = useRef(false);

  const request = useCallback(() => {
    // Go back if we have an entry to go back through; the pop closes us. If the
    // push never happened, close directly rather than stealing someone's history.
    if (pushed.current) window.history.back();
    else close.current();
  }, []);

  useEffect(() => {
    window.history.pushState({ manillaOverlay: true }, '');
    pushed.current = true;

    const onPop = () => {
      pushed.current = false;
      close.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') request();
    };

    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
    };
  }, [request]);

  return request;
}
