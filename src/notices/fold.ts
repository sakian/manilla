import type { Attention } from './notices.ts';

const RANK = { bad: 0, warn: 1, info: 2 } as const;

/**
 * Which notices sit at the top of the screen, and which wait behind "N alerts".
 *
 * People open Manilla to see envelope balances, and next most often to
 * categorize what came in. With every notice on its own line, a phone showed a
 * screen of notices and the envelopes started after a scroll. So what is up
 * front is what is usually wanted, and the rest is one press away:
 *
 * - The review queue, because it is the other reason to open the app.
 * - Anything bad. Envelopes and accounts disagreeing is the one thing the home
 *   screen must say (FR-37); folding a broken ledger under a count would be
 *   hiding it.
 *
 * Everything else - an overspend the envelope list shows anyway, an unusual
 * charge, a statement that disagrees - folds, ranked by how much it matters. A
 * single one is not folded: a line that only counts it takes the room the notice
 * would.
 */
export function foldNotices<T extends Pick<Attention, 'kind' | 'severity'>>(
  notices: T[],
): { shown: T[]; folded: T[] } {
  const ordered = [...notices].sort((left, right) => RANK[left.severity] - RANK[right.severity]);
  const upFront = (notice: T) => notice.severity === 'bad' || notice.kind === 'awaiting_review';
  const folded = ordered.filter((notice) => !upFront(notice));
  if (folded.length <= 1) return { shown: ordered, folded: [] };
  return { shown: ordered.filter(upFront), folded };
}
