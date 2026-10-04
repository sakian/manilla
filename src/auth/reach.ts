/**
 * Where a request came from, as far as the app can know it - and what that
 * means for the one action that should never be open to the internet: claiming
 * an install that has no passkey yet (NF-3).
 *
 * The app listens only on the Tailscale sidecar's loopback (docker-compose.yml),
 * so every request reaching it in production has passed through `tailscale
 * serve`. That proxy deletes any `Tailscale-User-Login` or
 * `Tailscale-Funnel-Request` a client sent and writes its own: a Funnel request
 * gets `Tailscale-Funnel-Request: ?1`, a tailnet user gets their login, and a
 * tagged node gets neither. So in that arrangement both headers are facts, not
 * claims. Behind anything else - Nginx, a published port - they are whatever the
 * sender wrote, which is why `unknown` is treated like the internet below.
 */

export type Reach = 'tailnet' | 'funnel' | 'unknown';

type HeaderSource = { get(name: string): string | null };

export function requestReach(headers: HeaderSource): Reach {
  // Funnel first: Tailscale never sets both, but if something upstream did, the
  // public answer is the safe one.
  if (headers.get('tailscale-funnel-request') !== null) return 'funnel';
  if (headers.get('tailscale-user-login')) return 'tailnet';
  return 'unknown';
}

export type SetupGate = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether a request may register the first passkey, which makes its sender the
 * owner of every record in the install.
 *
 * On the open internet that is a race with strangers, and the race reopens if
 * the database ever comes back empty - a restore gone wrong, a fresh volume - so
 * in production it takes a tailnet user. `MANILLA_ALLOW_SETUP=1` is the way
 * through for a deployment that has no Tailscale identity to show (Nginx, a
 * tagged device), and is meant to be removed again once the passkey exists.
 * Even that does not open setup to Funnel: anyone who can turn Funnel on can
 * reach the node over the tailnet instead.
 *
 * `production` defaults as in `authConfig`, and is a parameter for the tests.
 */
export function firstSetupGate(
  reach: Reach,
  env: Record<string, string | undefined> = process.env,
  production: boolean = env.NODE_ENV === 'production',
): SetupGate {
  if (!production) return { allowed: true };

  if (reach === 'funnel') {
    return {
      allowed: false,
      reason:
        'This Manilla has no passkey yet, and setting one up is not possible from the public ' +
        'internet. Open it from a device on your tailnet to register the first passkey.',
    };
  }
  if (reach === 'tailnet') return { allowed: true };
  if (env.MANILLA_ALLOW_SETUP?.trim() === '1') return { allowed: true };

  return {
    allowed: false,
    reason:
      'This Manilla has no passkey yet, and this request did not come from a signed-in tailnet ' +
      'user, so it cannot claim it. Open it from a device on your tailnet, or set ' +
      'MANILLA_ALLOW_SETUP=1 until the first passkey is registered.',
  };
}

/**
 * Whether a recovery code may be tried from here.
 *
 * A code is 60 bits and the throttle makes guessing hopeless, but it is still
 * a secret that can be guessed at, where a passkey is not. With invitations
 * nobody needs a code to get in for the first time, so the only thing they are
 * for - a lost device - can wait until you are on the tailnet, and the open
 * internet gets nothing to guess at. Only Funnel is refused: behind Nginx there
 * is no telling, and refusing `unknown` would take recovery away from that
 * arrangement altogether.
 */
export function recoveryAllowed(reach: Reach): boolean {
  return reach !== 'funnel';
}

export const RECOVERY_NEEDS_TAILNET =
  'Recovery codes only work from a device on your tailnet. Sign in with a passkey, or connect ' +
  'to Tailscale and try again.';
