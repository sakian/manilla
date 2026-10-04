'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import { beginJoinAction, finishJoinAction, lookUpInviteAction } from '../actions.ts';
import { SignInMark, readableError } from '../SignIn.tsx';

type State =
  | { step: 'reading' }
  | { step: 'refused'; reason: string }
  | { step: 'form'; token: string; invitedBy: string }
  | { step: 'codes'; codes: string[] };

export default function Join({ signedInAs }: { signedInAs: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<State>({ step: 'reading' });
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The token is the part after #, which only the browser ever sees.
  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (!token) {
      setState({
        step: 'refused',
        reason: 'This link is missing its invitation. Copy the whole link and try again.',
      });
      return;
    }
    lookUpInviteAction(token).then((found) => {
      if (!found.ok) {
        setState({ step: 'refused', reason: found.error });
        return;
      }
      setName(found.invite.name);
      setState({ step: 'form', token, invitedBy: found.invite.invitedBy });
    });
  }, []);

  const join = useCallback(() => {
    if (state.step !== 'form') return;
    setError(null);
    startTransition(async () => {
      const begun = await beginJoinAction(state.token, name);
      if (!begun.ok) {
        setError(begun.error);
        return;
      }

      let response;
      try {
        response = await startRegistration({ optionsJSON: begun.options });
      } catch (caught) {
        setError(readableError(caught));
        return;
      }

      const finished = await finishJoinAction({
        token: state.token,
        challengeId: begun.challengeId,
        response,
        name,
      });
      if (!finished.ok) {
        setError(finished.error);
        return;
      }
      setState({ step: 'codes', codes: finished.recoveryCodes });
    });
  }, [state, name]);

  if (state.step === 'reading') {
    return (
      <div className="signin">
        <SignInMark />
        <h2>Join Manilla</h2>
        <p className="muted">Checking your invitation…</p>
      </div>
    );
  }

  if (state.step === 'refused') {
    return (
      <div className="signin">
        <SignInMark />
        <h2>This invitation will not work</h2>
        <p className="muted">{state.reason}</p>
      </div>
    );
  }

  if (state.step === 'codes') {
    return (
      <div className="signin">
        <SignInMark />
        <h2>Save these recovery codes</h2>
        <p className="muted">
          Each one signs you in once if you lose this device, and they are yours alone. They are
          stored hashed, so this is the only time they can be shown. Print them or put them in your
          password manager.
        </p>
        <ul className="codes">
          {state.codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="signin-actions">
          <button
            className="primary"
            onClick={() => {
              router.replace('/');
              router.refresh();
            }}
          >
            I have saved them
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="signin">
      <SignInMark />
      <h2>Join Manilla</h2>
      <p className="muted">
        {state.invitedBy} has invited you to share their budget. Create a passkey to sign in: your
        device will ask for a fingerprint, face or PIN, and nothing leaves it but a public key.
      </p>
      {signedInAs && (
        <p className="muted">
          This browser is signed in as {signedInAs}. Joining here adds a new person; to add this
          device for {signedInAs}, use Settings instead.
        </p>
      )}
      <label className="field">
        <span>Your name</span>
        <input value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} />
      </label>
      {error && <p className="signin-error">{error}</p>}
      <div className="signin-actions">
        <button className="primary" onClick={join} disabled={pending || name.trim().length === 0}>
          {pending ? 'Waiting for your device…' : 'Create a passkey'}
        </button>
      </div>
    </div>
  );
}
