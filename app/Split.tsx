'use client';

/**
 * A list beside the transactions of whatever is chosen in it (#35).
 *
 * On a wide screen the envelopes and accounts screens are two columns: the list
 * on the left, narrow enough that a name and its balance sit together, and on the
 * right the transactions screen filtered to the row last chosen - or to nothing,
 * so the right half is never empty. Choosing a row changes the address rather
 * than the page, so back steps through what you looked at and a bookmark keeps
 * it.
 *
 * On a phone there is no room for two columns, so the pane is not shown and a
 * row's link goes where it always did: the transactions screen, as a page of its
 * own. That is why the links keep their /transactions href and the pane is
 * reached by intercepting the click, not by changing where they point - a link
 * that is middle-clicked, copied or followed without JavaScript still lands on a
 * page that makes sense by itself.
 */

import { useCallback, type MouseEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/** Where the two columns start. The same width as `.split` in globals.css. */
const WIDE = '(min-width: 900px)';

export function Split({ pane, children }: { pane?: ReactNode; children: ReactNode }) {
  // The list stays in the same place in the tree with or without a pane, so
  // switching Edit on and off does not reopen every group someone had folded.
  return (
    <div className={pane ? 'split' : undefined}>
      <div className="split-list">{children}</div>
      {pane && <div className="split-pane">{pane}</div>}
    </div>
  );
}

/**
 * An onClick for a link to `/transactions?…` that, on a wide screen, shows the
 * same query in the pane of `path` instead. A modified click is left alone, so
 * opening one in a new tab still opens the full page.
 */
export function usePaneLink(path: '/' | '/accounts') {
  const router = useRouter();
  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (!window.matchMedia(WIDE).matches) return;
      const href = event.currentTarget.getAttribute('href');
      if (!href?.startsWith('/transactions?')) return;
      event.preventDefault();
      router.push(path + href.slice('/transactions'.length), { scroll: false });
    },
    [path, router],
  );
}
