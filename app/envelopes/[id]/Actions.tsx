'use client';

import { useState } from 'react';
import { CoverDialog, TransferDialog, type EnvelopeChoice } from '../MoveMoney.tsx';

/** The two money-moving buttons on one envelope's page (FR-34, FR-35). */
export default function Actions({
  envelopeId,
  envelopeName,
  overspent,
  envelopes,
}: {
  envelopeId: string;
  envelopeName: string;
  overspent: boolean;
  envelopes: EnvelopeChoice[];
}) {
  const [transferring, setTransferring] = useState(false);
  const [covering, setCovering] = useState(false);

  return (
    <>
      <div className="signin-actions">
        <button className="primary" onClick={() => setTransferring(true)}>
          Move money
        </button>
        {overspent && <button onClick={() => setCovering(true)}>Cover this</button>}
      </div>

      {transferring && (
        <TransferDialog
          envelopes={envelopes}
          fromEnvelopeId={envelopeId}
          onClose={() => setTransferring(false)}
        />
      )}

      {covering && (
        <CoverDialog
          envelopeId={envelopeId}
          envelopeName={envelopeName}
          onClose={() => setCovering(false)}
        />
      )}
    </>
  );
}
