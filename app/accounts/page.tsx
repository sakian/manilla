import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { accounts, envelopes, transactions, txnLines } from '../../db/schema.ts';
import { accountBalances } from '../../src/ledger/ledger.ts';
import { Money } from '../Money.tsx';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  const connection = db();
  const balances = await accountBalances(connection);

  const recent = await connection
    .select({
      id: transactions.id,
      date: transactions.date,
      payeeRaw: transactions.payeeRaw,
      amountCents: transactions.amountCents,
      status: transactions.status,
      accountName: accounts.name,
      envelopeName: envelopes.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(txnLines, eq(txnLines.transactionId, transactions.id))
    .leftJoin(envelopes, eq(txnLines.envelopeId, envelopes.id))
    .orderBy(desc(transactions.date), desc(transactions.createdAt))
    .limit(60);

  return (
    <>
      <div className="page-head">
        <h2>Accounts</h2>
        <p className="muted">Real money, as the bank sees it.</p>
      </div>

      <section className="panel">
        <h3>Balances</h3>
        {balances.length === 0 && <p className="muted">No accounts yet.</p>}
        {balances.map((account) => (
          <div key={account.accountId} className="row">
            <span>
              {account.name} <span className="muted">· {account.kind.replace('_', ' ')}</span>
            </span>
            <Money cents={account.balanceCents} />
          </div>
        ))}
      </section>

      <section className="panel">
        <h3>Recent transactions</h3>
        {recent.length === 0 && <p className="muted">Nothing recorded yet.</p>}
        {recent.map((row) => (
          <div key={row.id} className="txn">
            <span className="muted txn-date">{row.date}</span>
            <span className="txn-payee">{row.payeeRaw}</span>
            <span className="muted txn-env">
              {row.envelopeName ?? 'uncategorized'}
              {row.status === 'pending_review' && ' · pending'}
            </span>
            <Money cents={Number(row.amountCents)} />
          </div>
        ))}
      </section>
    </>
  );
}
