'use client';

/**
 * Make an overlay behave like a page you can back out of.
 *
 * A dialog is a state change, not a navigation, so the phone's back button walked
 * off the *page* underneath while a transaction's detail was open - you pressed
 * back to close it and lost the list you were reading. Pushing a history entry
 * when it opens makes back mean what it looks like it means.
 *
 * Closing is funnelled through history so there is one path rather than two:
 * `popstate` is the only thing that actually calls `onClose`, and a Cancel button
 * unmounts the overlay, whose cleanup pops the entry it added. That keeps the
 * history stack the same length whichever way the overlay was shut, so a second
 * back press leaves the page rather than undoing a phantom entry.
 *
 * Escape is here too, for the same reason: it is what the other half of the world
 * presses to mean the same thing.
 */

import { useEffect, useRef } from 'react';

export function useOverlay(onClose: () => void): void {
  // Held in a ref so the effect does not re-run - and re-push history - every
  // time the parent renders a fresh closure.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const pushed = { current: true };
    window.history.pushState({ manillaOverlay: true }, '');

    const onPop = () => {
      pushed.current = false;
      close.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };

    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      // Closed some other way - a button, a click outside - so take the entry
      // back out. The listener is already gone, so this cannot loop.
      if (pushed.current) window.history.back();
    };
  }, []);
}
