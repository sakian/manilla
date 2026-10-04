import { execFileSync } from 'node:child_process';
import type { NextConfig } from 'next';
import { securityHeaders } from './src/security-headers.ts';

/** One git answer, or null where there is no git or no repository to ask. */
function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Which commit this is, fixed into the build so Settings can say (#20, see
// src/version.ts). Modified means tracked files differ from it, untracked ones
// aside: a build of a working copy should not pass for the commit it started from.
const commit = git('rev-parse', '--short', 'HEAD');
const committed = commit ? git('log', '-1', '--format=%cs') : null;
const modified = commit ? Boolean(git('status', '--porcelain', '--untracked-files=no')) : false;

const config: NextConfig = {
  // The app runs behind its Tailscale node (docker-compose.yml), and is packaged
  // as a self-contained server bundle for the Docker image.
  output: 'standalone',
  poweredByHeader: false,

  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'production') },
      // Always checked for a newer copy, so a change to how notifications are
      // shown reaches phones on their next visit rather than whenever a cache
      // lets go.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },

  env: {
    MANILLA_COMMIT: commit ?? '',
    MANILLA_COMMITTED: committed ?? '',
    MANILLA_MODIFIED: modified ? '1' : '',
  },

  experimental: {
    // An OFX statement arrives as the body of a server action, and the default
    // ceiling of 1MB is below a long multi-year export. Nginx is already set to
    // 25M in front of it (deploy/nginx.conf.example).
    serverActions: { bodySizeLimit: '8mb' },
  },

  // `next dev` blocks cross-origin requests for dev assets from any hostname but
  // the one it started on, so browsing the dev server by LAN address needs that
  // address listed. It comes from the environment rather than the repo because it
  // is a fact about one machine, not about Manilla.
  allowedDevOrigins: (process.env.MANILLA_DEV_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

export default config;
