import Link from 'next/link';
import { db } from '../db/client.ts';
import { accountBalances, checkInvariant, envelopeBalances } from '../src/ledger/ledger.ts';
import { pendingCount } from '../src/queue/queue.ts';
import { Money } from './Money.tsx';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const connection = db();
  const [envelopes, accounts, invariant, waiting] = await Promise.all([
    envelopeBalances(connection),
    accountBalances(connection),
    checkInvariant(connection),
    pendingCount(connection),
  ]);

  if (envelopes.length === 0 && accounts.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontSize: 17 }}>Nothing here yet.</p>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Run <code>npm run seed</code> to create a starting set of envelopes and an account.
        </p>
      </div>
    );
  }

  const groups = new Map<string, typeof envelopes>();
  for (const envelope of envelopes) {
    const list = groups.get(envelope.groupName) ?? [];
    list.push(envelope);
    groups.set(envelope.groupName, list);
  }

  const overspent = envelopes.filter((envelope) => envelope.balanceCents < 0);
  const unallocated = envelopes.find((envelope) => envelope.isUnallocated);

  return (
    <>
      <div className="page-head">
        <h2>Dashboard</h2>
      </div>

      <div className="callouts">
        {waiting > 0 && (
          <Link href="/review" className="callout">
            <strong>{waiting}</strong> awaiting review
          </Link>
        )}
        {unallocated && unallocated.balanceCents !== 0 && (
          <div className="callout">
            <strong>
              <Money cents={unallocated.balanceCents} />
            </strong>{' '}
            unallocated
          </div>
        )}
        {overspent.length > 0 && (
          <div className="callout warn">
            <strong>{overspent.length}</strong> envelope{overspent.length === 1 ? '' : 's'}{' '}
            overspent
          </div>
        )}
        {!invariant.ok && (
          <div className="callout bad">
            Ledger out of balance by <Money cents={invariant.unexplainedCents} />
          </div>
        )}
      </div>

      <section className="panel">
        <h3>Envelopes</h3>
        {[...groups.entries()].map(([groupName, list]) => {
          const groupTotal = list.reduce((sum, envelope) => sum + envelope.balanceCents, 0);
          return (
            <div key={groupName} className="group">
              <div className="group-head">
                <span>{groupName}</span>
                <Money cents={groupTotal} />
              </div>
              {list.map((envelope) => (
                <div key={envelope.envelopeId} className="row">
                  <span>
                    {envelope.name}
                    {envelope.isUnallocated && <span className="tag">income pool</span>}
                  </span>
                  <Money cents={envelope.balanceCents} />
                </div>
              ))}
            </div>
          );
        })}
      </section>

      <section className="panel">
        <h3>Accounts</h3>
        {accounts.map((account) => (
          <div key={account.accountId} className="row">
            <span>
              {account.name} <span className="muted">· {account.kind.replace('_', ' ')}</span>
            </span>
            <Money cents={account.balanceCents} />
          </div>
        ))}
        <div className="row total">
          <span>Total</span>
          <Money cents={accounts.reduce((sum, account) => sum + account.balanceCents, 0)} />
        </div>
      </section>

      <p className="muted footnote">
        {invariant.ok ? (
          <>
            Envelopes and accounts agree
            {invariant.unassignedCents !== 0 && (
              <>
                , with <Money cents={invariant.unassignedCents} /> still unassigned in the review
                queue
              </>
            )}
            .
          </>
        ) : (
          <>
            Envelopes and accounts disagree by <Money cents={invariant.unexplainedCents} />, which
            should never happen. Recent imports are the place to look.
          </>
        )}
      </p>
    </>
  );
}
