import type { Database } from '../../db/client.ts';
import { migrationDate, reconcile } from '../../src/migrate/migrate.ts';
import type { ReconcileData } from './ReconcileBalances.tsx';

/**
 * The balances to reconcile, as of the last day the migrated history covers -
 * or null when there is no migration to reconcile against.
 */
export async function reconcileData(connection: Database): Promise<ReconcileData | null> {
  const asOf = await migrationDate(connection);
  if (!asOf) return null;

  const report = await reconcile(connection, {}, { asOf });
  return {
    asOf,
    envelopes: report.lines
      // The pool is what the adjustments come from, so it is not one to type.
      .filter((line) => !line.isUnallocated)
      .map((line) => ({
        id: line.envelopeId,
        name: line.name,
        groupName: line.groupName,
        computedCents: line.computedCents,
      })),
    accounts: report.accounts.map((line) => ({
      id: line.accountId,
      name: line.name,
      computedCents: line.computedCents,
    })),
  };
}
