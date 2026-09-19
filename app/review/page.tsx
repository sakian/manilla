import { db } from '../../db/client.ts';
import { envelopeOptions, highConfidenceIds, pendingTransactions } from '../../src/queue/queue.ts';
import ReviewQueue from './ReviewQueue.tsx';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const connection = db();
  const [rows, envelopes, high] = await Promise.all([
    pendingTransactions(connection),
    envelopeOptions(connection),
    highConfidenceIds(connection),
  ]);

  return (
    <>
      <div className="page-head">
        <h2>Review</h2>
        <p className="muted">
          Imported transactions arrive here with a suggested envelope already applied, so the
          dashboard is accurate before you have finished. Confirming is what marks one settled.
        </p>
      </div>
      <ReviewQueue rows={rows} envelopes={envelopes} highCount={high.length} />
    </>
  );
}
