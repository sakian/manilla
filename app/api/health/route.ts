/**
 * Liveness and integrity probe, used by the Docker healthcheck.
 *
 * It reports whether the ledger invariant (FR-37) holds as well as whether the
 * database answers, so a corrupted ledger is visible from `docker compose ps`
 * rather than only from inside the app. An unbalanced ledger is deliberately
 * *not* a failed health check: the container is still serving, and taking it
 * down would remove the one place the user could go to fix the problem.
 *
 * Whether, and not by how much. This route answers without a session - a
 * healthcheck has no cookie - so the size of the discrepancy, which is a figure
 * in dollars taken off someone's ledger, is left to the screens that do ask for
 * one. The probe needs a yes or no; anything more is an unauthenticated endpoint
 * volunteering how much money is involved.
 */

import { db } from '../../../db/client.ts';
import { checkInvariant } from '../../../src/ledger/ledger.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const invariant = await checkInvariant(db());
    return Response.json({ ok: true, ledgerBalanced: invariant.ok });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'unknown' },
      { status: 503 },
    );
  }
}
