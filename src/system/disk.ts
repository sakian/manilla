/**
 * How full the server's disk is.
 *
 * A full disk stops Postgres writing, and with it every change in the app and
 * the nightly backup - and nothing in a quiet week says it is coming. Docker
 * filled this one: every `docker compose up --build` left its build cache and
 * the previous image behind, 64 GB of it before anyone looked.
 *
 * Read from inside the app's container, where `/` is the overlay Docker keeps
 * on the host's own disk, so the figure is the host's.
 */

import { statfs } from 'node:fs/promises';

/** The share in use, 0 to 1, counted as `df` counts it; null when it cannot be read. */
export async function diskUsedShare(path = '/'): Promise<number | null> {
  try {
    const stats = await statfs(path);
    const used = stats.blocks - stats.bfree;
    const usable = used + stats.bavail;
    return usable > 0 ? used / usable : null;
  } catch {
    return null;
  }
}
