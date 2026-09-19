'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import type { RegisteredDevice } from '../../src/auth/passkeys.ts';
import {
  beginAddDeviceAction,
  finishAddDeviceAction,
  regenerateRecoveryCodesAction,
  removeDeviceAction,
  renameDeviceAction,
} from './actions.ts';

function when(date: Date | null): string {
  if (!date) return 'never used';
  return new Date(date).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function Devices({
  devices,
  unusedRecoveryCodes,
}: {
  devices: RegisteredDevice[];
  unusedRecoveryCodes: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  const addDevice = useCallback(() => {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const begun = await beginAddDeviceAction();
      if (!begun.ok) {
        setError(begun.error);
        return;
      }

      let response;
      try {
        response = await startRegistration({ optionsJSON: begun.options });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(
          /InvalidStateError/i.test(message)
            ? 'This device already has a passkey for Manilla.'
            : /NotAllowedError|abort|cancel/i.test(message)
              ? 'That was cancelled.'
              : message,
        );
        return;
      }

      const finished = await finishAddDeviceAction({
        challengeId: begun.challengeId,
        response,
        label,
      });
      if (!finished.ok) {
        setError(finished.error);
        return;
      }
      setLabel('');
      setNote('Passkey registered.');
      router.refresh();
    });
  }, [label, router]);

  const rename = useCallback(
    (credentialId: string, current: string | null) => {
      const next = window.prompt('What should this device be called?', current ?? '');
      if (next === null) return;
      startTransition(async () => {
        const result = await renameDeviceAction(credentialId, next);
        if (!result.ok) setError(result.error);
        router.refresh();
      });
    },
    [router],
  );

  const remove = useCallback(
    (credentialId: string, current: string | null) => {
      if (!window.confirm(`Remove ${current ?? 'this passkey'}? It will no longer sign you in.`)) {
        return;
      }
      startTransition(async () => {
        const result = await removeDeviceAction(credentialId);
        if (!result.ok) setError(result.error);
        else setNote('Passkey removed.');
        router.refresh();
      });
    },
    [router],
  );

  const newCodes = useCallback(() => {
    if (
      !window.confirm(
        'Generate a new set of recovery codes? The codes you have now will stop working.',
      )
    ) {
      return;
    }
    startTransition(async () => {
      const result = await regenerateRecoveryCodesAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCodes(result.codes);
      router.refresh();
    });
  }, [router]);

  return (
    <>
      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      <section className="panel">
        <h3>Passkeys</h3>
        {devices.length === 0 && <p className="muted">No passkeys registered.</p>}
        {devices.map((device) => (
          <div key={device.id} className="row device-row">
            <span>
              {device.label ?? 'Passkey'}
              <span className="muted"> · added {when(device.createdAt)}</span>
              <span className="muted"> · last used {when(device.lastUsedAt)}</span>
            </span>
            <span className="device-actions">
              <button onClick={() => rename(device.id, device.label)} disabled={pending}>
                Rename
              </button>
              <button onClick={() => remove(device.id, device.label)} disabled={pending}>
                Remove
              </button>
            </span>
          </div>
        ))}

        <div className="add-device">
          <input
            value={label}
            placeholder="Name for this device, e.g. Pixel 9"
            onChange={(event) => setLabel(event.target.value)}
          />
          <button className="primary" onClick={addDevice} disabled={pending}>
            {pending ? 'Waiting for your device…' : 'Add a passkey'}
          </button>
        </div>
        <p className="muted footnote">
          Register the devices you actually use. A second passkey is what stops a lost phone turning
          into a lost ledger, and the last one cannot be removed.
        </p>
      </section>

      <section className="panel">
        <h3>Recovery codes</h3>
        {codes ? (
          <>
            <p className="muted">
              Save these now: they are stored hashed, so this is the only time they can be shown.
            </p>
            <ul className="codes">
              {codes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">
            {unusedRecoveryCodes} unused{' '}
            {unusedRecoveryCodes === 1 ? 'code' : 'codes'} left. Each one signs you in once, and
            generating a new set replaces every one of them.
          </p>
        )}
        <div className="signin-actions">
          <button onClick={newCodes} disabled={pending}>
            Generate new codes
          </button>
        </div>
      </section>
    </>
  );
}
