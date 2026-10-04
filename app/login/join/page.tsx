import { authConfig } from '../../../src/auth/config.ts';
import { currentSession } from '../../auth.ts';
import Join from './Join.tsx';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Join · Manilla',
};

/**
 * Where an invitation link lands (NF-3). Public, under /login, like the rest of
 * signing in; the token is in the fragment, so this page is the same for
 * everybody and the browser is what reads it (src/auth/invites.ts).
 */
export default async function JoinPage() {
  let configError: string | null = null;
  try {
    authConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  // Opening a link meant for someone else, on your own device, is the likeliest
  // mistake here; joining would make a second person, not add to you.
  const session = await currentSession();

  return (
    <div className="signin-shell">
      {configError ? (
        <div className="signin">
          <h2>Sign-in is not configured</h2>
          <p className="muted">{configError}</p>
        </div>
      ) : (
        <Join signedInAs={session?.userName ?? null} />
      )}
    </div>
  );
}
