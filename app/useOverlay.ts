'use client';

/**
 * Escape closes an overlay.
 *
 * This used to also make the phone's back button close one, by pushing a history
 * entry when it opened. Two attempts, two different failures: the first undid its
 * entry from the effect cleanup, which React's Strict Mode turned into a dialog
 * that shut the instant it opened; the second stopped touching history on cleanup
 * and stopped the dialog opening at all. The App Router patches `history.pushState`
 * to keep its own idea of the route in step, and hand-pushed entries do not fit
 * that - a modal it does not know about is not a thing it can be told to restore.
 *
 * So this does the part that works. Doing it properly means making the dialog a
 * *route* - `?txn=<id>` or an intercepting route - so back closes it because the
 * router knows it is there, rather than because we fought the router over the
 * history stack. Worth doing; not worth a third guess in the dark.
 */

import { useEffect, useRef } from 'react';

export function useOverlay(onClose: () => void): void {
  // In a ref so a fresh closure from the parent does not re-bind the listener.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
