'use client';

/**
 * An overlay whose open-ness lives in the URL.
 *
 * A dialog is a state change, so the phone's back button used to walk off the
 * *page* underneath it: you pressed back to close a transaction's detail and lost
 * the list you were reading. Putting the fact that it is open into the address
 * bar makes back mean what it looks like it means, and makes an open dialog a
 * thing you can link to.
 *
 * This is a *shallow* navigation: `window.history.pushState` with a URL, which
 * the App Router patches to update `useSearchParams` without fetching anything
 * from the server. That matters twice over - a dialog should not cost a round
 * trip, and the review queue holds a sitting's worth of staged decisions that a
 * re-render must not disturb.
 *
 * Two earlier attempts got this wrong in instructive ways. The first undid its
 * own history entry from an effect cleanup, which React's Strict Mode - mount,
 * clean up, mount again - turned into a dialog that shut the instant it opened.
 * The second pushed *state without a URL*, which is the shape the router's patch
 * ignores: no `useSearchParams` update, nothing driving the dialog, an entry on
 * the stack belonging to nobody. Passing the URL is the whole difference.
 *
 * Closing goes back rather than forward, so the entry we added leaves with it and
 * the stack comes out the length it started. A dialog opened by someone else's
 * link has no entry of ours to pop, so that one is replaced instead - pressing
 * back there should leave, not bounce.
 */

import { useCallback, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

export type Overlay = {
  /** The param's value, or null when the overlay is shut. */
  value: string | null;
  open: (value: string, extra?: Record<string, string>) => void;
  close: () => void;
};

export function useOverlay(name: string, extraNames: string[] = []): Overlay {
  const params = useSearchParams();
  const pathname = usePathname();
  const value = params.get(name);

  /** Whether the entry showing this overlay is one we put there. */
  const ours = useRef(false);
  useEffect(() => {
    if (value === null) ours.current = false;
  }, [value]);

  const urlWith = useCallback(
    (changes: Record<string, string | null>) => {
      const query = new URLSearchParams(params.toString());
      for (const [key, next] of Object.entries(changes)) {
        if (next === null) query.delete(key);
        else query.set(key, next);
      }
      const text = query.toString();
      return text ? `${pathname}?${text}` : pathname;
    },
    [params, pathname],
  );

  const open = useCallback(
    (next: string, extra: Record<string, string> = {}) => {
      ours.current = true;
      window.history.pushState(null, '', urlWith({ [name]: next, ...extra }));
    },
    [name, urlWith],
  );

  const close = useCallback(() => {
    if (ours.current) {
      ours.current = false;
      window.history.back();
      return;
    }
    const cleared: Record<string, null> = { [name]: null };
    for (const extra of extraNames) cleared[extra] = null;
    window.history.replaceState(null, '', urlWith(cleared));
    // A replace fires no popstate, so nothing else will notice; the router's
    // patched replaceState is what updates `useSearchParams` for us.
  }, [extraNames, name, urlWith]);

  // Escape is what the other half of the world presses to mean back.
  useEffect(() => {
    if (value === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, value]);

  return { value, open, close };
}
