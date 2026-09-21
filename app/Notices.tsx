/**
 * What needs attention, at the top of every main screen.
 *
 * One line each. A notice is a thing to notice, not a paragraph about it - what to
 * do is on the screen it links to, or in a button beside the thing itself. Ranked
 * by how much it matters rather than by where the number came from, and a quiet
 * screen shows nothing at all, which is the useful part.
 *
 * The wording lives here and the figures come from `src/notices`, so a notice
 * reads the same whether it appears on the envelopes screen, the accounts screen,
 * or after an import.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Attention, AttentionReport } from '../src/notices/notices.ts';
import { Money } from './Money.tsx';

const RANK = { bad: 0, warn: 1, info: 2 } as const;

function describe(notice: Attention): { text: ReactNode; href?: string } {
  const count = notice.count ?? 0;
  const cents = notice.cents ?? 0;

  switch (notice.kind) {
    case 'ledger_mismatch':
      return {
        text: (
          <>
            Envelopes and accounts disagree by <Money cents={cents} plain />
          </>
        ),
      };
    case 'pool_overdrawn':
      return {
        text: (
          <>
            Available overdrawn by <Money cents={cents} plain />
          </>
        ),
      };
    case 'envelopes_overspent':
      return { text: `${count} envelope${count === 1 ? '' : 's'} overspent` };
    case 'statement_mismatch':
      return notice.account
        ? {
            text: (
              <>
                {notice.account.name} is <Money cents={Math.abs(cents)} plain />{' '}
                {cents > 0 ? 'over' : 'under'} its last statement
              </>
            ),
            href: `/transactions?account=${notice.account.id}`,
          }
        : { text: `${count} accounts disagree with their last statement`, href: '/accounts' };
    case 'awaiting_review':
      return { text: `${count} to review`, href: '/review' };
    case 'unallocated':
      return {
        text: (
          <>
            <Money cents={cents} plain /> in Available
          </>
        ),
      };
    case 'plan_exceeds_income':
      return {
        text: (
          <>
            Plans add up to <Money cents={cents} plain /> a month against{' '}
            <Money cents={notice.againstCents ?? 0} plain /> coming in
          </>
        ),
      };
    case 'rules_to_suggest':
      return {
        text: `${count} rule${count === 1 ? '' : 's'} Manilla could write for you`,
        href: '/settings#rules',
      };
    case 'nothing_recorded':
      return { text: 'Nothing recorded yet — bring your history in', href: '/migrate' };
  }
}

export function Notices({ report }: { report: AttentionReport }) {
  if (report.notices.length === 0) return null;

  const ordered = [...report.notices].sort(
    (left, right) => RANK[left.severity] - RANK[right.severity],
  );

  return (
    <ul className="notices">
      {ordered.map((notice) => {
        const { text, href } = describe(notice);
        return (
          <li key={notice.kind} className={`notice ${notice.severity}`}>
            {href ? <Link href={href}>{text}</Link> : text}
          </li>
        );
      })}
    </ul>
  );
}
