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
import { DismissInsight } from './DismissInsight.tsx';
import { displayDate } from '../src/budget/month.ts';
import { jumpShare } from '../src/insights/insights.ts';
import { SignInActivityNotice } from './SignInActivityNotice.tsx';
import { foldNotices } from '../src/notices/fold.ts';

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
                {/* Inside the notice's link, which cannot hold a copy button. */}
                {notice.account.name} is <Money cents={Math.abs(cents)} plain copy={false} />{' '}
                {cents > 0 ? 'over' : 'under'} its last statement
              </>
            ),
            href: `/transactions?account=${notice.account.id}`,
          }
        : { text: `${count} accounts disagree with their last statement`, href: '/accounts' };
    case 'awaiting_review':
      // RQ-7: what was handed to the person looking, said as theirs.
      if (notice.view === 'mine') return { text: `${count} for you to review`, href: '/review?view=mine' };
      return {
        text: `${count} to review${notice.mine ? `, ${notice.mine} for you` : ''}`,
        href: '/review',
      };
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
        href: '/settings/sorting#rules',
      };
    case 'bank_login_needed':
      return {
        text:
          count > 1
            ? `${count} banks want you to sign in again`
            : `${notice.institution ?? 'Your bank'} wants you to sign in again`,
        href: '/settings/ledgers#bank-feeds',
      };
    case 'sync_held':
      return {
        text: `${count} from your bank feed need${count === 1 ? 's' : ''} a decision`,
        href: '/import#held',
      };
    case 'disk_nearly_full':
      return { text: `The server's disk is ${count}% full; Docker's build cache is the usual cause` };
    case 'nothing_recorded':
      return { text: 'Nothing recorded yet — bring your history in', href: '/migrate' };
    case 'unusual_charge': {
      // AI-2: what was found, the numbers behind it, and what to do about it.
      // Inside the notice's link, so no amount here can be a copy button.
      const insight = notice.insight!;
      const href = `/transactions?txn=${insight.transactionId}`;
      if (insight.kind === 'charge_jumped') {
        return {
          text: (
            <>
              {insight.payee} charged <Money cents={insight.cents} plain copy={false} /> on{' '}
              {displayDate(insight.date)}, {Math.round(jumpShare(insight.cents, insight.usualCents) * 100)}%
              above its usual <Money cents={insight.usualCents} plain copy={false} />. Worth checking
              the bill.
            </>
          ),
          href,
        };
      }
      return {
        text: (
          <>
            First charge from {insight.payee}: <Money cents={insight.cents} plain copy={false} /> on{' '}
            {displayDate(insight.date)}, bigger than 95% of your charges this past year. Recognise it?
          </>
        ),
        href,
      };
    }
  }
}

function NoticeLine({ notice }: { notice: Attention }) {
  const { text, href } = describe(notice);
  const insight = notice.insight;
  return (
    <li className={`notice ${notice.severity}${insight ? ' with-action' : ''}`}>
      {href ? <Link href={href}>{text}</Link> : text}
      {insight && <DismissInsight transactionId={insight.transactionId} payee={insight.payee} />}
    </li>
  );
}

const keyOf = (notice: Attention) =>
  notice.insight ? `${notice.kind}-${notice.insight.transactionId}` : notice.kind;

export async function Notices({ report }: { report: AttentionReport }) {
  // First, and outside the ranking: someone else's way in changing outranks
  // anything about money.
  const signIn = await SignInActivityNotice();
  if (report.notices.length === 0 && !signIn) return null;

  const { shown, folded } = foldNotices(report.notices);
  // Ranked, so the first folded is the most serious, and its colour is the line's.
  const worst = folded[0];

  return (
    <ul className="notices">
      {signIn}
      {shown.map((notice) => (
        <NoticeLine key={keyOf(notice)} notice={notice} />
      ))}
      {/* A <details>, so it opens before any script has loaded. Closed again on
          the next visit: what is folded is what can wait. */}
      {worst && (
        <li className="notices-more">
          <details>
            <summary className={`notice ${worst.severity}`}>{folded.length} alerts</summary>
            <ul className="notices">
              {folded.map((notice) => (
                <NoticeLine key={keyOf(notice)} notice={notice} />
              ))}
            </ul>
          </details>
        </li>
      )}
    </ul>
  );
}
