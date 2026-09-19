'use client';

/**
 * The sign-in screen (NF-3).
 *
 * Three states, decided by the server: first-run setup, ordinary sign-in, and the
 * recovery-code way back in. The WebAuthn calls have to happen here, in the
 * browser, because only the browser can talk to the authenticator - everything
 * either side of `startRegistration` / `startAuthentication` is a server action.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import {
  beginSetupAction,
  beginSignInAction,
  finishSetupAction,
  finishSignInAction,
  recoveryCodeSignInAction,
} from './actions.ts';

type Mode = 'passkey' | 'recovery';

/**
 * A WebAuthn ceremony the user cancelled is not an error worth shouting about;
 * anything else is. Two of these are worth translating, because the browser's own
 * wording sends people looking in the wrong place:
 *
 *  - `SecurityError` ("the operation is insecure") on an HTTPS page almost always
 *    means the certificate is not trusted. Browsers turn WebAuthn off entirely
 *    when the connection is not authenticated, and clicking through the warning
 *    does not count - `isSecureContext` is still true, so the page looks fine
 *    right up to the moment the authenticator is asked for anything.
 *  - "not a registrable domain suffix" means the hostname itself cannot be a
 *    passkey domain, which is a different fix: a different hostname.
 */
function readableError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  if (/registrable domain/i.test(message)) {
    return (
      'This hostname cannot be used as a passkey domain. Use a name under a real ' +
      'domain you own - a private suffix like .lan is not always accepted - and ' +
      'set MANILLA_RP_ID to it.'
    );
  }
  if (name === 'SecurityError' || /insecure/i.test(message)) {
    return (
      'The browser will not use a passkey on this connection, which almost always ' +
      'means the certificate is not trusted on this device. Accepting a warning is ' +
      'not enough: the CA has to be installed and switched on. On iOS that is ' +
      'Settings, General, About, Certificate Trust Settings.'
    );
  }
  if (/InvalidStateError/i.test(message)) {
    return 'This device already has a passkey for Manilla. Sign in with it instead.';
  }
  if (/NotAllowedError|abort|cancel/i.test(message)) {
    return 'That was cancelled. Try again when you are ready.';
  }
  return message;
}

export default function SignIn({
  needsSetup,
  secureOrigin,
  origin,
  next,
}: {
  needsSetup: boolean;
  secureOrigin: boolean;
  origin: string;
  next: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>('passkey');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  /**
   * What the browser makes of this page, which is not always what the server was
   * configured for. Reaching the app by LAN address gives an origin that is
   * neither HTTPS nor localhost, so the browser will not do WebAuthn at all - and
   * even over HTTPS a passkey is only offered when the host matches the
   * relying-party ID. Both are worth saying plainly instead of letting the
   * authenticator call fail with something cryptic.
   */
  const [browser, setBrowser] = useState<{
    origin: string;
    secure: boolean;
    hostMatches: boolean;
    supportsWebAuthn: boolean;
    platformAuthenticator: boolean | null;
  } | null>(null);

  useEffect(() => {
    let expectedHost = '';
    try {
      expectedHost = new URL(origin).host;
    } catch {
      expectedHost = '';
    }

    const probe = {
      origin: window.location.origin,
      secure: window.isSecureContext && browserSupportsWebAuthn(),
      hostMatches: expectedHost === '' || expectedHost === window.location.host,
      supportsWebAuthn: browserSupportsWebAuthn(),
      platformAuthenticator: null as boolean | null,
    };
    setBrowser(probe);

    // Whether the device has a built-in authenticator at all. It says nothing
    // about certificate trust, which is why it is reported next to the rest.
    void platformAuthenticatorIsAvailable()
      .then((available) => setBrowser({ ...probe, platformAuthenticator: available }))
      .catch(() => setBrowser({ ...probe, platformAuthenticator: false }));
  }, [origin]);

  const go = useCallback(() => {
    router.replace(next);
    router.refresh();
  }, [router, next]);

  const setUp = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const begun = await beginSetupAction(name);
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

      const finished = await finishSetupAction({
        challengeId: begun.challengeId,
        response,
        name,
      });
      if (!finished.ok) {
        setError(finished.error);
        return;
      }

      // Shown once, then never again: the codes only exist hashed after this.
      setCodes(finished.recoveryCodes);
    });
  }, [name]);

  const signIn = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const begun = await beginSignInAction();
      if (!begun.ok) {
        setError(begun.error);
        return;
      }

      let response;
      try {
        response = await startAuthentication({ optionsJSON: begun.options });
      } catch (caught) {
        setError(readableError(caught));
        return;
      }

      const finished = await finishSignInAction({
        challengeId: begun.challengeId,
        response,
      });
      if (!finished.ok) {
        setError(finished.error);
        return;
      }
      go();
    });
  }, [go]);

  const useRecoveryCode = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const finished = await recoveryCodeSignInAction(code);
      if (!finished.ok) {
        setError(finished.error);
        return;
      }
      router.replace('/settings');
      router.refresh();
    });
  }, [code, router]);

  if (codes) {
    return (
      <div className="signin">
        <h2>Save these recovery codes</h2>
        <p className="muted">
          Each one signs you in once if you lose your device, and is the only way back in without
          your passkey. They are stored hashed, so this is the only time they can be shown. Print
          them or put them in your password manager.
        </p>
        <ul className="codes">
          {codes.map((recovery) => (
            <li key={recovery}>{recovery}</li>
          ))}
        </ul>
        <div className="signin-actions">
          <button className="primary" onClick={go}>
            I have saved them
          </button>
        </div>
      </div>
    );
  }

  // `browser` is null until the effect has run; until then trust the server's view.
  const insecure = !secureOrigin || (browser !== null && !browser.secure);
  const wrongHost = browser !== null && browser.hostMatches === false;

  if (insecure || wrongHost) {
    const here = browser?.origin ?? origin;
    return (
      <div className="signin">
        <h2>{insecure ? 'Passkeys need a secure origin' : 'Passkeys are bound to another host'}</h2>
        {insecure ? (
          <p className="muted">
            You are viewing this at <code>{here}</code>, and browsers only allow passkeys over
            HTTPS or on localhost - a LAN address is neither.
          </p>
        ) : (
          <p className="muted">
            You are viewing this at <code>{here}</code>, but the passkeys here are bound to{' '}
            <code>{origin}</code>. A credential is tied to one exact host, so none would be offered.
          </p>
        )}
        <p className="muted">
          To look around from another machine right now, forward the port over SSH and use
          localhost, which counts as secure:
        </p>
        <pre className="snippet">ssh -L 3000:localhost:3000 {'<this-host>'}</pre>
        <p className="muted">
          For the real thing, run <code>tailscale cert</code> for the Tailscale hostname, point
          Nginx at the certificate, and set <code>MANILLA_RP_ID</code> and{' '}
          <code>MANILLA_ORIGIN</code> to it - <code>deploy/nginx.conf.example</code> has both
          halves.
        </p>
      </div>
    );
  }

  if (needsSetup) {
    return (
      <div className="signin">
        <h2>Set up Manilla</h2>
        <p className="muted">
          Nobody has registered yet, so this first passkey becomes the way in. Your device will ask
          for a fingerprint, face or PIN; nothing leaves it but a public key.
        </p>
        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            placeholder="Mark"
            autoComplete="name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && <p className="signin-error">{error}</p>}
        <div className="signin-actions">
          <button className="primary" onClick={setUp} disabled={pending || name.trim().length === 0}>
            {pending ? 'Waiting for your device…' : 'Create a passkey'}
          </button>
        </div>
        <Diagnostics browser={browser} rpOrigin={origin} />
      </div>
    );
  }

  if (mode === 'recovery') {
    return (
      <div className="signin">
        <h2>Use a recovery code</h2>
        <p className="muted">
          One of the codes from setup. Each works once, and signing in this way takes you straight to
          Settings so you can register a new passkey.
        </p>
        <label className="field">
          <span>Recovery code</span>
          <input
            value={code}
            placeholder="A1B2-C3D4-E5F6"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        {error && <p className="signin-error">{error}</p>}
        <div className="signin-actions">
          <button
            className="primary"
            onClick={useRecoveryCode}
            disabled={pending || code.trim().length < 8}
          >
            {pending ? 'Checking…' : 'Sign in'}
          </button>
          <button
            onClick={() => {
              setMode('passkey');
              setError(null);
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="signin">
      <h2>Sign in</h2>
      <p className="muted">
        Your passkey is bound to this hostname, so there is nothing to type and nothing to phish.
      </p>
      {error && <p className="signin-error">{error}</p>}
      <div className="signin-actions">
        <button className="primary" onClick={signIn} disabled={pending}>
          {pending ? 'Waiting for your device…' : 'Sign in with a passkey'}
        </button>
        <button
          onClick={() => {
            setMode('recovery');
            setError(null);
          }}
        >
          Lost your device?
        </button>
      </div>
      <Diagnostics browser={browser} rpOrigin={origin} />
    </div>
  );
}

/**
 * What this browser thinks, on the screen where it matters.
 *
 * Passkey failures are nearly always environmental - the wrong origin, an
 * untrusted certificate, a device with no authenticator - and reading that off a
 * phone beats guessing at it from a laptop.
 */
function Diagnostics({
  browser,
  rpOrigin,
}: {
  browser: {
    origin: string;
    secure: boolean;
    hostMatches: boolean;
    supportsWebAuthn: boolean;
    platformAuthenticator: boolean | null;
  } | null;
  rpOrigin: string;
}) {
  if (!browser) return null;

  const rows: [string, string][] = [
    ['This page', browser.origin],
    ['Expected origin', rpOrigin],
    ['Hostname matches', browser.hostMatches ? 'yes' : 'no'],
    ['Secure context', browser.secure ? 'yes' : 'no'],
    ['WebAuthn available', browser.supportsWebAuthn ? 'yes' : 'no'],
    [
      'Built-in authenticator',
      browser.platformAuthenticator === null
        ? 'checking…'
        : browser.platformAuthenticator
          ? 'yes'
          : 'no',
    ],
  ];

  return (
    <details className="diagnostics">
      <summary className="muted">What this browser reports</summary>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">
        All yes and it still fails? Then the certificate is not trusted: browsers
        switch passkeys off when the connection is not authenticated, and a warning
        you clicked through still counts as untrusted.
      </p>
    </details>
  );
}
