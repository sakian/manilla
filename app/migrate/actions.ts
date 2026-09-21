'use server';

/**
 * The migration, from the browser (MG-1 to MG-7).
 *
 * The plan for a six-year export holds seven thousand transactions, so what
 * crosses to the browser is a *summary* of it - counts, the envelopes and
 * accounts to decide about, and everything the export cannot represent. The file
 * itself stays in the browser and comes back with the decisions, and the commit
 * re-plans it server-side. Same shape as the OFX import, for the same two
 * reasons: what gets written is always what the server read, and nothing is left
 * half-finished in a table if someone closes the tab.
 */

import { revalidatePath } from 'next/cache';
import { db } from '../../db/client.ts';
import {
  applyReconciliation,
  commitMigration,
  planMigration,
  reconcile,
  revertMigration,
  type MigrationMapping,
  type Unrepresentable,
} from '../../src/migrate/migrate.ts';
import { isMigrationSource, type MigrationSourceId } from '../../src/migrate/sources.ts';
import { refreshRuleSuggestionCount } from '../../src/rules/rules.ts';
import { localToday } from '../../src/budget/month.ts';
import { requireUser } from '../auth.ts';

export type Failure = { ok: false; error: string };

function failed(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refreshed(): void {
  revalidatePath('/migrate');
  revalidatePath('/accounts');
  revalidatePath('/transactions');
  revalidatePath('/');
}

/**
 * The rule-suggestion count is cached, because working it out is one of the two
 * heaviest queries the notices run and they run on every screen. Whoever writes
 * confirmed transactions owns invalidating it.
 *
 * A migration is the largest writer of confirmed transactions there is - six
 * years of them in one go - and so the single biggest producer of "this payee
 * always goes to one envelope" evidence. Without this, the app finished the one
 * operation that fills the suggestion list and then said nothing about it until
 * the next review sitting happened to refresh the count.
 */
async function countedAgain(connection: ReturnType<typeof db>): Promise<void> {
  await refreshRuleSuggestionCount(connection);
  revalidatePath('/review');
  revalidatePath('/settings');
}

export type PlanSummary = {
  dateFormat: string;
  dateEvidence: string;
  dateRange: { from: string; to: string } | null;
  envelopes: { name: string; group: string | null; uses: number }[];
  accounts: { name: string; uses: number }[];
  counts: Record<string, number>;
  /** What will actually be written, as opposed to what was read. */
  willWrite: { transactions: number; lines: number; moves: number; transfers: number };
  unrepresentable: Unrepresentable[];
  needsDefaultAccount: boolean;
  rowsWithoutAccount: number;
  warnings: string[];
};

/**
 * The chosen app, checked here rather than trusted: it arrives from the browser
 * and decides how the files are read.
 */
function sourceFrom(value: string): MigrationSourceId {
  if (!isMigrationSource(value)) {
    throw new Error(`Manilla cannot migrate from "${value}".`);
  }
  return value;
}

export async function planMigrationAction(
  files: string[],
  from: string,
): Promise<{ ok: true; summary: PlanSummary } | Failure> {
  try {
    await requireUser();
    const plan = planMigration(files, { from: sourceFrom(from) });

    return {
      ok: true,
      summary: {
        dateFormat: plan.dateFormat,
        dateEvidence: plan.dateEvidence,
        dateRange: plan.dateRange,
        envelopes: plan.envelopes,
        accounts: plan.accounts,
        counts: plan.counts,
        willWrite: {
          transactions: plan.transactions.length,
          lines: plan.transactions.reduce((total, row) => total + row.lines.length, 0),
          moves: plan.moves.length,
          transfers: plan.transfers.length,
        },
        // A six-year export can produce a long list; the screen shows the first
        // of them and says how many more there are.
        unrepresentable: plan.unrepresentable.slice(0, 200),
        needsDefaultAccount: plan.needsDefaultAccount,
        rowsWithoutAccount: plan.rowsWithoutAccount,
        warnings: plan.warnings,
      },
    };
  } catch (error) {
    return failed(error);
  }
}

export async function commitMigrationAction(
  files: string[],
  mapping: MigrationMapping,
  from: string,
  meta: { filename?: string } = {},
): Promise<
  | {
      ok: true;
      batchId: string;
      added: number;
      duplicates: number;
      moves: number;
      transfers: number;
      envelopesCreated: number;
      accountsCreated: number;
    }
  | Failure
> {
  try {
    await requireUser();
    const connection = db();
    const plan = planMigration(files, { from: sourceFrom(from) });
    const result = await commitMigration(connection, plan, mapping, meta);
    refreshed();
    await countedAgain(connection);
    return { ok: true, ...result };
  } catch (error) {
    return failed(error);
  }
}

export async function reconcileAction(
  expected: Record<string, number> = {},
): Promise<
  | {
      ok: true;
      lines: Awaited<ReturnType<typeof reconcile>>['lines'];
      differenceCents: number;
      unanswered: number;
    }
  | Failure
> {
  try {
    await requireUser();
    const report = await reconcile(db(), expected);
    return { ok: true, ...report };
  } catch (error) {
    return failed(error);
  }
}

export async function applyReconciliationAction(
  adjustments: { envelopeId: string; differenceCents: number }[],
  date?: string,
): Promise<{ ok: true; written: number } | Failure> {
  try {
    await requireUser();
    const written = await applyReconciliation(db(), adjustments, {
      date: date ?? localToday(),
    });
    refreshed();
    return { ok: true, written };
  } catch (error) {
    return failed(error);
  }
}

export async function revertMigrationAction(
  batchId: string,
): Promise<{ ok: true; removed: number } | Failure> {
  try {
    await requireUser();
    const connection = db();
    const removed = await revertMigration(connection, batchId);
    refreshed();
    // Taking the history back out removes the evidence too, so a suggestion the
    // migration earned must stop being offered.
    await countedAgain(connection);
    return { ok: true, removed };
  } catch (error) {
    return failed(error);
  }
}
