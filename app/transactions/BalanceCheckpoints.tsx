/**
 * The bank's word against the ledger's, one statement at a time (FR-14).
 *
 * Every imported statement states what the account held on a day. Set beside
 * what the ledger says it held that same day, the first place the two part
 * company is where to look - and the change in the gap between two statements
 * says which weeks hold the mistake, rather than which years.
 */

import Link from 'next/link';
import type { BalanceCheckpoint } from '../../src/import/ofxImport.ts';
import { addDays } from '../../src/budget/month.ts';
import { Hint } from '../Hint.tsx';
import { Money } from '../Money.tsx';

export function BalanceCheckpoints({
  accountId,
  checkpoints,
}: {
  accountId: string;
  checkpoints: BalanceCheckpoint[];
}) {
  if (checkpoints.length === 0) {
    return (
      <p className="muted footnote checkpoints-none">
        No statement has stated a balance for this account yet. Each one imported from now on
        leaves one here to check against - and importing an old statement again adds nothing but
        its balance.
      </p>
    );
  }

  const latest = checkpoints[checkpoints.length - 1]!;
  // Newest first on screen, like the list below it.
  const shown = [...checkpoints].reverse();

  return (
    <details className="checkpoints" open={latest.differenceCents !== 0}>
      <summary>
        <span>
          Against the bank&rsquo;s statements{' '}
          <Hint label="What these figures mean">
            &ldquo;Here&rdquo; is this account&rsquo;s balance at the end of that day, reviewed or
            not, and the difference is here less the bank. A difference that stays the same from
            one statement to the next is one old mistake carried forward; one that moves happened
            between them.
          </Hint>
        </span>
        <span className={latest.differenceCents === 0 ? 'muted' : 'checkpoint-off'}>
          {latest.differenceCents === 0 ? (
            'agrees'
          ) : (
            <>
              off by <Money cents={latest.differenceCents} plain />
            </>
          )}
        </span>
      </summary>

      <div className="checkpoint-row checkpoint-head" aria-hidden="true">
        <span>As of</span>
        <span>Bank</span>
        <span>Here</span>
        <span>Difference</span>
      </div>
      {shown.map((checkpoint) => (
        <div key={`${checkpoint.asOf}:${checkpoint.statedCents}`} className="checkpoint">
          <div className="checkpoint-row">
            <span>{checkpoint.asOf}</span>
            <Money cents={checkpoint.statedCents} />
            <Money cents={checkpoint.ledgerCents} />
            {/* Plain, not green and red: a difference is neither money in nor
                money out, and colouring it said one or the other. */}
            {checkpoint.differenceCents === 0 ? (
              <span className="muted">agrees</span>
            ) : (
              <Money cents={checkpoint.differenceCents} plain />
            )}
          </div>
          {/* Where the gap moved is the window with the mistake in it. */}
          {checkpoint.changeCents !== null && checkpoint.changeCents !== 0 && (
            <p className="checkpoint-change">
              The gap moved by <Money cents={checkpoint.changeCents} plain /> since{' '}
              {checkpoint.previousAsOf}.{' '}
              <Link
                href={`/transactions?account=${accountId}&from=${addDays(
                  checkpoint.previousAsOf!,
                  1,
                )}&to=${checkpoint.asOf}&order=asc`}
              >
                Look between them
              </Link>
            </p>
          )}
        </div>
      ))}
    </details>
  );
}
