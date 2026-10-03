/**
 * Which code this install is running (#20).
 *
 * Read from git when the app is built - next.config.ts puts it in the
 * environment, where the build fixes it into the bundle - so it describes the
 * build, not whatever the checkout has moved on to since. The bug report form
 * asks for exactly this, and "I updated it on Tuesday" is not an answer to it.
 *
 * Empty when the build had no git to ask: a tarball, say. Then the screen says
 * so rather than inventing a version.
 */

export type Version = {
  /** Short commit hash. */
  commit: string;
  /** The commit's own date, `YYYY-MM-DD`. */
  committed: string | null;
  /** Built with tracked files changed from that commit. */
  modified: boolean;
};

export function readVersion(env: Record<string, string | undefined>): Version | null {
  const commit = env.MANILLA_COMMIT?.trim();
  if (!commit) return null;
  const committed = env.MANILLA_COMMITTED?.trim();
  return {
    commit,
    committed: committed && /^\d{4}-\d{2}-\d{2}$/.test(committed) ? committed : null,
    modified: env.MANILLA_MODIFIED === '1',
  };
}
