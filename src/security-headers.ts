/**
 * Response headers for every page (NF-4), applied in next.config.ts.
 *
 * On a tailnet these mattered little, because nobody who could frame the app or
 * downgrade its connection could reach it. With Funnel it is on the internet, so
 * a stranger's page could load it in a frame and dress up a click, or a café
 * network could offer plain HTTP first. These are the browser's half of stopping
 * that.
 *
 * The CSP is deliberately only the directives that do not touch scripts. A
 * `script-src` worth having needs a per-request nonce threaded through every
 * page Next renders, and one that allows 'unsafe-inline' protects nothing;
 * that is a change of its own, not a header to tack on.
 */

export type Header = { key: string; value: string };

export function securityHeaders(production: boolean): Header[] {
  const headers: Header[] = [
    {
      key: 'Content-Security-Policy',
      value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    },
    // For browsers too old for frame-ancestors.
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // Report links and transaction searches carry what someone was looking at
    // in the query string; nothing outside Manilla needs to see it.
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    // Nothing here uses them. WebAuthn's own permissions are left at their
    // defaults on purpose: listing them wrong is how passkeys stop working.
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ];

  // Only in production, where the origin is HTTPS by the boot check
  // (src/auth/config.ts). In development it would pin a LAN hostname like
  // manilla.lan to HTTPS for a year, on the strength of a self-signed CA.
  if (production) {
    headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000' });
  }
  return headers;
}
