/**
 * A path on this site to send someone to, from a value someone else could have
 * written: the sign-in page's `next`, and `/open`'s `to`.
 *
 * Anything that is not plainly a path here becomes the home screen. Starting
 * with "/" is not enough: "//evil.example" is another site, and so is
 * "/\evil.example", because browsers read a backslash there as a slash. So
 * the value is resolved against a placeholder origin, and kept only if it is
 * still on it.
 */

const HERE = 'http://manilla.invalid';

export function safePath(value: string | string[] | null | undefined): string {
  const path = Array.isArray(value) ? value[0] : value;
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  let url: URL;
  try {
    url = new URL(path, HERE);
  } catch {
    return '/';
  }
  if (url.origin !== HERE) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A link that opens `path` in a particular ledger (see app/open/route.ts), for
 * a notification about one ledger that may be tapped while another is open.
 */
export function openInLedger(ledgerKey: string, path: string): string {
  return `/open?${new URLSearchParams({ ledger: ledgerKey, to: path }).toString()}`;
}
