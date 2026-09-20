import type { NextConfig } from 'next';

const config: NextConfig = {
  // The app runs behind Nginx on a private Tailscale network, and is packaged
  // as a self-contained server bundle for the Docker image.
  output: 'standalone',
  poweredByHeader: false,

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
