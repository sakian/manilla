import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { homeDb } from '../../db/client.ts';
import { authConfig, isSecureOrigin } from '../../src/auth/config.ts';
import { setupState } from '../../src/auth/passkeys.ts';
import {
  RECOVERY_NEEDS_TAILNET,
  firstSetupGate,
  recoveryAllowed,
  requestReach,
} from '../../src/auth/reach.ts';
import { currentSession } from '../auth.ts';
import SignIn from './SignIn.tsx';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in · Manilla',
};

/** `next` is where the proxy was sending them before it asked who they are. */
function safeNext(value: string | string[] | undefined): string {
  const path = Array.isArray(value) ? value[0] : value;
  // Only same-site paths: an open redirect on the sign-in page would be a gift.
  if (!path || !path.startsWith('/') || path.startsWith('//')) return '/';
  return path;
}

export default async function LoginPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;

  // Already signed in: nothing to do here. This is the authoritative check, which
  // is why the proxy does not make it - a cookie that only looks like a session
  // would send the browser round in circles.
  //
  // Except in the re-render that follows this page's own sign-in actions. Setting
  // the session cookie makes Next render the page again in the same response, and
  // redirecting there took setup straight past the recovery codes - shown once,
  // never again - and sent a recovery-code sign-in to `next` rather than to
  // Settings to replace the code it spent. Each of those actions navigates on the
  // client when it is ready, so the page just stays put.
  const request = await headers();
  const rerenderAfterAction = request.has('next-action');
  if (!rerenderAfterAction && (await currentSession())) redirect(safeNext(searchParams.next));

  const state = await setupState(homeDb());
  // The actions refuse on their own; this only saves showing a form that cannot work.
  const gate = state.needsSetup ? firstSetupGate(requestReach(request)) : { allowed: true as const };

  // A misconfigured relying party is the difference between "sign in" and "every
  // sign-in fails for no visible reason", so it is reported here rather than
  // thrown.
  let origin = '';
  let configError: string | null = null;
  try {
    origin = authConfig().origin;
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="signin-shell">
      {configError ? (
        <div className="signin">
          <h2>Sign-in is not configured</h2>
          <p className="muted">{configError}</p>
        </div>
      ) : (
        <SignIn
          needsSetup={state.needsSetup}
          setupBlocked={gate.allowed ? null : gate.reason}
          recoveryBlocked={recoveryAllowed(requestReach(request)) ? null : RECOVERY_NEEDS_TAILNET}
          secureOrigin={isSecureOrigin(origin)}
          origin={origin}
          next={safeNext(searchParams.next)}
        />
      )}
    </div>
  );
}
