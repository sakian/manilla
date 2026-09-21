/**
 * Everything that changed one envelope's balance, in one list (VW-5).
 *
 * An envelope's balance is its share of transactions plus what was moved in,
 * less what was moved out. The transactions list showed only the first of
 * those, so an envelope filled every month read as a column of spending with
 * nothing coming in - and the fills, the transfers and the reconciliation
 * adjustments sat on a separate screen. Here they are one history, in date
 * order, each row carrying the balance it left behind, so reading down the
 * list explains the number on the envelope's card.
 *
 * A transaction counts at the envelope's share of it: a $100 split with $60 in
 * Groceries moves the Groceries balance by $60, and that is the figure summed.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { transactionsById, type FoundTransaction } from '../transactions/search.ts';

export type EnvelopeMoveRow = {
  id: string;
  date: string;
  /** `allocation` is money from the pool, a fill or an adjustment; `transfer` is between envelopes. */
  kind: 'allocation' | 'transfer';
  /** Signed from this envelope's side: positive came in, negative went out. */
  amountCents: number;
  /** The envelope on the other end of the move. */
  otherEnvelopeName: string;
  otherIsPool: boolean;
  note: string | null;
};

export type EnvelopeActivityRow =
  | {
      type: 'transaction';
      transaction: FoundTransaction;
      /** This envelope's part of the transaction, which is what its balance moved by. */
      shareCents: number;
      balanceAfterCents: number;
    }
  | { type: 'move'; move: EnvelopeMoveRow; balanceAfterCents: number };

export type EnvelopeActivity = {
  rows: EnvelopeActivityRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export async function envelopeActivity(
  db: Database,
  envelopeId: string,
  options: { from?: string; to?: string; order?: 'asc' | 'desc'; limit?: number; offset?: number } = {},
): Promise<EnvelopeActivity> {
  const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
  const offset = Math.max(0, options.offset ?? 0);
  const descending = (options.order ?? 'desc') === 'desc';

  const within = sql`true
    ${options.from ? sql`and date >= ${options.from}::date` : sql``}
    ${options.to ? sql`and date <= ${options.to}::date` : sql``}`;

  // The balance is summed over the envelope's whole history before the date
  // window is applied: a row's balance is the envelope's, not the window's.
  const activity = sql`
    with activity as (
      select 'transaction' as type, l.transaction_id as id, t.date, t.created_at,
        sum(l.amount_cents) as amount
      from txn_lines l
      join transactions t on t.id = l.transaction_id
      where l.envelope_id = ${envelopeId}
      group by l.transaction_id, t.date, t.created_at
      union all
      select 'move' as type, m.id, m.date, m.created_at,
        case when m.to_envelope_id = ${envelopeId} then m.amount_cents else -m.amount_cents end
      from envelope_moves m
      where m.to_envelope_id = ${envelopeId} or m.from_envelope_id = ${envelopeId}
    ),
    running as (
      select *, sum(amount) over (
        order by date, created_at, id rows between unbounded preceding and current row
      ) as balance_after
      from activity
    )`;

  const [page, [counted]] = await Promise.all([
    db.execute<{ type: 'transaction' | 'move'; id: string; amount: string; balance_after: string }>(sql`
      ${activity}
      select type, id, amount, balance_after from running
      where ${within}
      order by ${descending ? sql`date desc, created_at desc, id desc` : sql`date, created_at, id`}
      limit ${limit} offset ${offset}
    `),
    db.execute<{ total: string }>(sql`
      ${activity}
      select count(*) as total from running where ${within}
    `),
  ]);

  const transactionIds = page.filter((row) => row.type === 'transaction').map((row) => row.id);
  const moveIds = page.filter((row) => row.type === 'move').map((row) => row.id);

  const [found, moves] = await Promise.all([
    transactionsById(db, transactionIds),
    moveIds.length === 0
      ? Promise.resolve([])
      : db.execute<{
          id: string;
          date: string;
          kind: 'allocation' | 'transfer';
          amount_cents: string;
          to_envelope_id: string;
          other_name: string;
          other_is_pool: boolean;
          note: string | null;
        }>(sql`
          select m.id, m.date::text as date, m.kind, m.amount_cents, m.to_envelope_id, m.note,
            other.name as other_name, other.is_unallocated as other_is_pool
          from envelope_moves m
          join envelopes other on other.id =
            case when m.to_envelope_id = ${envelopeId} then m.from_envelope_id else m.to_envelope_id end
          where m.id in (${sql.join(
            moveIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        `),
  ]);
  const moveById = new Map(moves.map((move) => [move.id, move]));

  const rows: EnvelopeActivityRow[] = [];
  for (const row of page) {
    const balanceAfterCents = Number(row.balance_after);
    if (row.type === 'transaction') {
      const transaction = found.get(row.id);
      if (!transaction) continue;
      rows.push({ type: 'transaction', transaction, shareCents: Number(row.amount), balanceAfterCents });
    } else {
      const move = moveById.get(row.id);
      if (!move) continue;
      rows.push({
        type: 'move',
        balanceAfterCents,
        move: {
          id: move.id,
          date: move.date,
          kind: move.kind,
          amountCents: Number(row.amount),
          otherEnvelopeName: move.other_name,
          otherIsPool: move.other_is_pool,
          note: move.note,
        },
      });
    }
  }

  const total = Number(counted?.total ?? 0);
  return { rows, total, limit, offset, hasMore: offset + page.length < total };
}
