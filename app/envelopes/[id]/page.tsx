import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../db/client.ts';
import { budgetMonth } from '../../../src/budget/budget.ts';
import { currentMonth, monthLabel } from '../../../src/budget/month.ts';
import { envelopeHistory } from '../../../src/envelopes/manage.ts';
import { transferOptions } from '../../../src/envelopes/transfer.ts';
import { requireUser } from '../../auth.ts';
import { Money } from '../../Money.tsx';
import Actions from './Actions.tsx';
import History from './History.tsx';

export const dynamic = 'force-dynamic';

export default async function EnvelopePage(props: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await props.params;
  const connection = db();
  const month = currentMonth();

  const budget = await budgetMonth(connection, month);
  const envelope = budget.rows.find((row) => row.envelopeId === id);
  if (!envelope) notFound();

  const [history, envelopes] = await Promise.all([
    envelopeHistory(connection, id),
    transferOptions(connection),
  ]);

  return (
    <>
      <div className="page-head">
        <div className="month-head">
          <h2>{envelope.name}</h2>
          <Link href="/" className="muted">
            All envelopes
          </Link>
        </div>
        <p className="muted">
          {envelope.groupName}
          {envelope.isUnallocated && ' · this is the pool income lands in'}
        </p>
      </div>

      <div className="callouts">
        <div className={`callout${envelope.balanceCents < 0 ? ' bad' : ''}`}>
          Balance <strong>{<Money cents={envelope.balanceCents} plain />}</strong>
        </div>
        <div className="callout">
          Planned <strong>{<Money cents={envelope.plannedCents} plain />}</strong>
        </div>
        <div className="callout">
          Allocated in {monthLabel(month)} <strong>{<Money cents={envelope.allocatedCents} plain />}</strong>
        </div>
        <div className={`callout${envelope.spentCents < 0 ? ' received' : ''}`}>
          {envelope.spentCents < 0 ? 'Received in ' : 'Spent in '}
          {monthLabel(month)}{' '}
          <strong>{<Money cents={Math.abs(envelope.spentCents)} plain />}</strong>
        </div>
      </div>

      <Actions
        envelopeId={id}
        envelopeName={envelope.name}
        overspent={envelope.balanceCents < 0}
        envelopes={envelopes}
      />

      <section className="panel">
        <div className="panel-head">
          <h3>History</h3>
          {/* A plain GET form, so searching this envelope needs no JavaScript and
              lands in the full transaction view with the envelope already
              filtered. The history below is not only transactions - allocations
              and transfers are here too - so filtering it in place would quietly
              drop the very records this page exists to show. */}
          <form action="/accounts" method="get" className="inline-search">
            <input type="hidden" name="env" value={id} />
            <input
              type="search"
              name="q"
              placeholder={`Search ${envelope.name}`}
              aria-label={`Search transactions in ${envelope.name}`}
            />
            <button type="submit">Search</button>
          </form>
        </div>
        <History events={history} month={month} isPool={envelope.isUnallocated} />
      </section>
    </>
  );
}
