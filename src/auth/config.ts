/**
 * WebAuthn relying-party configuration (NF-3).
 *
 * A passkey is bound to an exact hostname. If the relying-party ID does not match
 * the host in the address bar, the browser refuses the ceremony; if it matches
 * something broader than intended, a credential is usable from somewhere it
 * should not be. Neither failure is subtle at the time and both are confusing
 * afterwards, so the values are checked once, loudly, rather than trusted.
 *
 * The check is strict in production and lenient about `localhost` in
 * development, because browsers treat `http://localhost` as a secure context and
 * nothing else over plain HTTP. On the home server the origin is
 * `https://manilla.your-tailnet.ts.net`, with the certificate from
 * `tailscale cert` - see deploy/nginx.conf.example.
 */

export class AuthConfigError extends Error {}

export type AuthConfig = {
  /** The relying-party ID: the bare hostname, no scheme and no port. */
  rpId: string;
  /** Shown by the browser and stored on the authenticator. */
  rpName: string;
  /** The exact origin the browser will report, scheme and port included. */
  origin: string;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLocal(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

/**
 * Read and validate the configuration.
 *
 * `production` defaults to `NODE_ENV === 'production'`, and is a parameter so the
 * tests can check both halves of the rule without touching the environment.
 */
export function authConfig(
  env: Record<string, string | undefined> = process.env,
  production: boolean = env.NODE_ENV === 'production',
): AuthConfig {
  const rpId = (env.MANILLA_RP_ID ?? '').trim();
  const rawOrigin = (env.MANILLA_ORIGIN ?? '').trim();
  const rpName = (env.MANILLA_RP_NAME ?? 'Manilla').trim() || 'Manilla';

  if (!rpId || !rawOrigin) {
    throw new AuthConfigError(
      'MANILLA_RP_ID and MANILLA_ORIGIN must both be set. Locally these are "localhost" and ' +
        '"http://localhost:3000"; on the server they are the Tailscale hostname you type, ' +
        'e.g. "manilla.your-tailnet.ts.net" and "https://manilla.your-tailnet.ts.net".',
    );
  }

  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new AuthConfigError(
      `MANILLA_ORIGIN is not a URL: ${rawOrigin}. It needs a scheme, for example ` +
        'https://manilla.your-tailnet.ts.net',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AuthConfigError(`MANILLA_ORIGIN must be http or https, got ${url.protocol}`);
  }

  // The origin the browser reports carries no trailing slash and no path.
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new AuthConfigError(
      `MANILLA_ORIGIN must be just the origin, with no path: ${url.origin} rather than ${rawOrigin}`,
    );
  }

  if (url.hostname !== rpId) {
    throw new AuthConfigError(
      `MANILLA_RP_ID (${rpId}) must be the hostname in MANILLA_ORIGIN (${url.hostname}). ` +
        'A passkey is bound to that exact host, so a mismatch means every sign-in fails.',
    );
  }

  if (production) {
    if (isLocal(rpId)) {
      throw new AuthConfigError(
        'MANILLA_RP_ID is still "' +
          rpId +
          '" in production. Passkeys registered against localhost cannot be used from another ' +
          'device, and a session issued for the wrong origin is worse than no session. Set it to ' +
          'the Tailscale hostname, e.g. manilla.your-tailnet.ts.net.',
      );
    }
    if (url.protocol !== 'https:') {
      throw new AuthConfigError(
        'MANILLA_ORIGIN must be https in production: WebAuthn requires a secure origin, and ' +
          '*.ts.net counts as secure only over TLS. Run `tailscale cert <host>` and point Nginx ' +
          'at the certificate (deploy/nginx.conf.example).',
      );
    }
  }

  return { rpId, rpName, origin: url.origin };
}

/** Whether the browser will treat this origin as secure, which passkeys require. */
export function isSecureOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || isLocal(url.hostname);
  } catch {
    return false;
  }
}
