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
import { localToday } from '../../src/budget/month.ts';
import { requireUser } from '../auth.ts';

export type Failure = { ok: false; error: string };

function failed(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refreshed(): void {
  revalidatePath('/migrate');
  revalidatePath('/envelopes');
  revalidatePath('/accounts');
  revalidatePath('/budget');
  revalidatePath('/');
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
    const plan = planMigration(files, { from: sourceFrom(from) });
    const result = await commitMigration(db(), plan, mapping, meta);
    refreshed();
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
    const removed = await revertMigration(db(), batchId);
    refreshed();
    return { ok: true, removed };
  } catch (error) {
    return failed(error);
  }
}
