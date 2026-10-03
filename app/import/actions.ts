'use server';

/**
 * Importing a statement from the browser (FR-7 to FR-14).
 *
 * The two-phase shape of the pipeline is kept intact: the preview decides what
 * every row is and writes nothing, and the commit writes only what was accepted.
 * What the browser holds between the two is the *file*, not the preview, and the
 * commit re-runs the preview server-side before applying the decisions.
 *
 * That costs one extra pass over a few dozen rows and buys two things: the rows
 * that get written are always ones the server classified, never ones a client
 * handed back, and there is no half-finished import parked in a table waiting for
 * someone who closed the tab.
 */

import { revalidatePath } from 'next/cache';
import { homeDb } from '../../db/client.ts';
import { ledgerDb } from '../ledger.ts';
import { parseOfx } from '../../src/ofx/parse.ts';
import {
  commitImport,
  decisionsFor,
  MATCHED,
  previewImport,
  rememberAccountMapping,
  resolveAccount,
  revertImport,
  type Refusal,
} from '../../src/import/ofxImport.ts';
import { bandOf, type Band } from '../../src/categorize/pipeline.ts';
import { envelopes, transactions } from '../../db/schema.ts';
import { inArray } from 'drizzle-orm';
import { requireUser } from '../auth.ts';

export type Failure = { ok: false; error: string };

function failed(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refreshed(): void {
  revalidatePath('/import');
  revalidatePath('/review');
  revalidatePath('/accounts');
  revalidatePath('/');
}

export type PreviewRow = {
  index: number;
  date: string;
  payee: string;
  amountCents: number;
  memo: string | null;
  verdict: 'new' | 'duplicate' | 'possible_duplicate' | 'transfer_half' | 'entered_ahead';
  reason: string;
  /** The transaction it matched, when it matched one. */
  existingId?: string;
  /** What that transaction says, so a person can tell whether it is the same one. */
  matched?: { payee: string; date: string };
  envelopeName?: string;
  confidence?: number;
  band?: Band;
  suggestionReason?: string;
  /** Set when a standing rule makes this row a transfer rather than spending. */
  transferToName?: string;
};

export type PreviewResult =
  | {
      ok: true;
      /** The statement's own account number, which is what maps it to an account. */
      statementAccountId: string;
      accountId: string;
      accountName: string;
      rows: PreviewRow[];
      counts: {
        new: number;
        duplicate: number;
        possible_duplicate: number;
        transfer_half: number;
        entered_ahead: number;
      };
      balance?: { statedCents: number; projectedCents: number; matches: boolean; asOf?: string };
      warnings: string[];
      /** Why the AI layer did not run, or stopped part way (NF-10). */
      aiNote?: string;
    }
  /** FR-7: the file is for an account Manilla does not know yet. */
  | { ok: false; needsAccount: true; statementAccountId: string; error: string }
  | Failure;

/**
 * Read a statement and say what would happen, writing nothing (FR-9).
 *
 * `accountId` is only needed the first time a bank account is seen; after that
 * the mapping is remembered on the account itself (FR-7).
 */
export async function previewImportAction(
  fileText: string,
  accountId?: string,
): Promise<PreviewResult> {
  try {
    await requireUser();
    const connection = await ledgerDb();
    const document = parseOfx(fileText);
    const statement = document.statements[0];

    if (!statement) {
      return { ok: false, error: 'No statement in that file. Is it an OFX or QFX export?' };
    }
    if (document.statements.length > 1) {
      document.warnings.push(
        `The file holds ${document.statements.length} statements; only the first is imported here.`,
      );
    }

    const mapped = accountId ? { id: accountId } : await resolveAccount(connection, statement);
    if (!mapped) {
      return {
        ok: false,
        needsAccount: true,
        statementAccountId: statement.accountId,
        error: `No account is mapped to bank account ${statement.accountId} yet.`,
      };
    }

    // The AI budget is the account's, whichever ledger this lands in.
    const preview = await previewImport(connection, statement, mapped.id, { account: homeDb() });

    // Every suggested envelope's name in one query, rather than one per row: a
    // statement proposes the same handful of envelopes over and over.
    const suggested = [
      ...new Set(
        preview.rows
          .map((row) => row.suggestion?.envelope)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const names = new Map<string, string>();
    if (suggested.length > 0) {
      const rows = await connection
        .select({ id: envelopes.id, name: envelopes.name })
        .from(envelopes)
        .where(inArray(envelopes.id, suggested));
      for (const row of rows) names.set(row.id, row.name);
    }

    // What each matched row was matched to, likewise in one query.
    const matchedIds = preview.rows
      .filter((row) => MATCHED.has(row.verdict) && row.existingId)
      .map((row) => row.existingId!);
    const matched = new Map<string, NonNullable<PreviewRow['matched']>>();
    if (matchedIds.length > 0) {
      const rows = await connection
        .select({
          id: transactions.id,
          payeeRaw: transactions.payeeRaw,
          date: transactions.date,
        })
        .from(transactions)
        .where(inArray(transactions.id, matchedIds));
      for (const row of rows) {
        matched.set(row.id, { payee: row.payeeRaw, date: row.date });
      }
    }

    return {
      ok: true,
      statementAccountId: statement.accountId,
      accountId: preview.accountId,
      accountName: preview.accountName,
      counts: preview.counts,
      warnings: document.warnings,
      ...(preview.aiNote ? { aiNote: preview.aiNote } : {}),
      ...(preview.balanceCheck
        ? {
            balance: {
              statedCents: preview.balanceCheck.statedCents,
              projectedCents: preview.balanceCheck.projectedCents,
              matches: preview.balanceCheck.matches,
              ...(preview.balanceCheck.asOf ? { asOf: preview.balanceCheck.asOf } : {}),
            },
          }
        : {}),
      rows: preview.rows.map((row): PreviewRow => {
        const envelopeId = row.suggestion?.envelope;
        return {
          index: row.index,
          date: row.transaction.posted,
          payee: row.transaction.name || row.transaction.memo || '(no description)',
          amountCents: row.transaction.amountCents,
          memo: row.transaction.memo ?? null,
          verdict: row.verdict,
          reason: row.reason,
          ...(row.existingId ? { existingId: row.existingId } : {}),
          ...(row.existingId && matched.has(row.existingId)
            ? { matched: matched.get(row.existingId)! }
            : {}),
          ...(row.transferTo ? { transferToName: row.transferTo.name } : {}),
          ...(envelopeId && row.suggestion
            ? {
                envelopeName: names.get(envelopeId) ?? 'an envelope',
                confidence: row.suggestion.confidence,
                band: bandOf(row.suggestion.confidence),
                suggestionReason: row.suggestion.reason,
              }
            : {}),
        };
      }),
    };
  } catch (error) {
    return failed(error);
  }
}

export type CommitResult =
  | { ok: true; added: number; linked: number; skipped: number; batchId: string }
  | Failure;

/**
 * Write the accepted rows (FR-10 to FR-12).
 *
 * Every row takes the default the preview proposed - new rows are added,
 * transfer halves and entries made ahead are linked, look-alikes are skipped -
 * except the matches a person refused, which are added as their own. A refusal
 * is all the browser can say: it never names a row to write of its own.
 */
export async function commitImportAction(
  fileText: string,
  accountId: string,
  refusals: Refusal[],
  meta: { filename?: string; rememberMapping?: boolean } = {},
): Promise<CommitResult> {
  try {
    await requireUser();
    const connection = await ledgerDb();
    const statement = parseOfx(fileText).statements[0];
    if (!statement) return { ok: false, error: 'No statement in that file.' };

    // FR-7: the mapping is remembered, so the next statement needs no answer.
    if (meta.rememberMapping) {
      await rememberAccountMapping(connection, accountId, statement.accountId);
    }

    const preview = await previewImport(connection, statement, accountId, { account: homeDb() });

    const result = await commitImport(connection, preview, decisionsFor(preview, refusals), {
      ...(meta.filename ? { filename: meta.filename } : {}),
    });

    refreshed();
    return { ok: true, ...result };
  } catch (error) {
    return failed(error);
  }
}

/** FR-13: undo a whole import. */
export async function revertImportAction(
  batchId: string,
): Promise<{ ok: true; removed: number } | Failure> {
  try {
    await requireUser();
    const removed = await revertImport(await ledgerDb(), batchId);
    refreshed();
    return { ok: true, removed };
  } catch (error) {
    return failed(error);
  }
}
