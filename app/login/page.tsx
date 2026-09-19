import { redirect } from 'next/navigation';
import { db } from '../../db/client.ts';
import { authConfig, isSecureOrigin } from '../../src/auth/config.ts';
import { setupState } from '../../src/auth/passkeys.ts';
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
  if (await currentSession()) redirect(safeNext(searchParams.next));

  const state = await setupState(db());

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
          secureOrigin={isSecureOrigin(origin)}
          origin={origin}
          next={safeNext(searchParams.next)}
        />
      )}
    </div>
  );
}
