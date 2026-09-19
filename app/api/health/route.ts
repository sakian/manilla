/**
 * Liveness and integrity probe, used by the Docker healthcheck.
 *
 * It reports the ledger invariant (FR-37) as well as connectivity, so a
 * corrupted ledger is visible from `docker compose ps` rather than only from
 * inside the app. An unbalanced ledger is deliberately *not* a failed health
 * check: the container is still serving, and taking it down would remove the
 * one place the user could go to fix the problem.
 */

import { db } from '../../../db/client.ts';
import { checkInvariant } from '../../../src/ledger/ledger.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const invariant = await checkInvariant(db());
    return Response.json({
      ok: true,
      ledgerBalanced: invariant.ok,
      unexplainedCents: invariant.unexplainedCents,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'unknown' },
      { status: 503 },
    );
  }
}
