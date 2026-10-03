/**
 * The URL arithmetic behind `app/useOverlay.ts`: an overlay's open-ness lives in
 * the query string, so opening and closing one is a matter of which params to
 * set and which to drop, while leaving every other param - a search, a filter,
 * a second overlay's state - exactly as it was.
 *
 * Here rather than in the hook because the hook has been got wrong three ways
 * already (see its own comment), and only src/ is reachable by the test runner
 * (#16). The parts that went wrong before were React's lifecycle and the
 * router's patch of `pushState`, which need a browser; this is the part that
 * does not.
 */

/** `pathname` with `search` changed as `changes` says: a string sets, null removes. */
export function overlayUrl(
  pathname: string,
  search: string,
  changes: Record<string, string | null>,
): string {
  const query = new URLSearchParams(search);
  for (const [key, next] of Object.entries(changes)) {
    if (next === null) query.delete(key);
    else query.set(key, next);
  }
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
}

/** The changes that open an overlay, along with whatever travels with it. */
export function openingChanges(
  name: string,
  value: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { [name]: value, ...extra };
}

/**
 * The changes that shut one: its own param and every param that only means
 * something while it is open, so a closed overlay leaves nothing behind.
 */
export function closingChanges(name: string, extraNames: string[] = []): Record<string, null> {
  const cleared: Record<string, null> = { [name]: null };
  for (const extra of extraNames) cleared[extra] = null;
  return cleared;
}
