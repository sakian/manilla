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

export const dynamic = 'force-dynamic';

function shortDate(date: string): string {
  const [year, month, day] = date.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(month) - 1]} ${Number(day)} ${year}`;
}

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
          <Link href="/envelopes" className="muted">
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
        <div className="callout">
          Spent in {monthLabel(month)} <strong>{<Money cents={envelope.spentCents} plain />}</strong>
        </div>
      </div>

      <Actions
        envelopeId={id}
        envelopeName={envelope.name}
        overspent={envelope.balanceCents < 0}
        envelopes={envelopes}
      />

      <section className="panel">
        <h3>History</h3>
        {history.length === 0 && <p className="muted">Nothing has happened here yet.</p>}
        {history.map((event) => (
          <div key={event.id} className="txn">
            <span className="muted txn-date">{shortDate(event.date)}</span>
            <span className="txn-payee">
              {event.description}
              {event.kind === 'allocation' && <span className="tag">allocation</span>}
              {event.kind === 'transfer' && <span className="tag">transfer</span>}
            </span>
            <span className="muted txn-env">
              {event.kind === 'transaction' ? event.accountName : ''}
              {event.pending && ' · pending review'}
            </span>
            <Money cents={event.amountCents} />
          </div>
        ))}
      </section>
    </>
  );
}
