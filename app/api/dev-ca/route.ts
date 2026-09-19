import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Hands the development CA certificate to a phone, in development only.
 *
 * Getting a file onto a phone is the fiddliest step in making a LAN certificate
 * trusted, and it is a step you cannot do from the browser you are trying to fix.
 * This route closes that loop: open it on the phone, accept the certificate
 * warning once - a download is not WebAuthn, so an untrusted connection is fine
 * for this - and the phone offers to install it.
 *
 * Only the certificate is served, never the key: a CA certificate is public by
 * design, while its key could mint a certificate for any site a trusting device
 * visits. And only in development, because in production the certificate comes
 * from `tailscale cert` and there is no private CA to distribute.
 *
 * The media type and the `.crt` filename matter: they are what make iOS offer a
 * profile to install and Android offer a CA to trust, rather than showing the
 * PEM as text.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    return new Response('Not found', { status: 404 });
  }

  const path = join(process.cwd(), 'certs', 'dev-ca.pem');
  const certificate = await readFile(path).catch(() => null);

  if (!certificate) {
    return new Response(
      'No development CA here. Run `npm run dev:cert` to create one.\n',
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  return new Response(new Uint8Array(certificate), {
    headers: {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="manilla-dev-ca.crt"',
      'cache-control': 'no-store',
    },
  });
}
