import type { NextConfig } from 'next';

const config: NextConfig = {
  // The app runs behind Nginx on a private Tailscale network, and is packaged
  // as a self-contained server bundle for the Docker image.
  output: 'standalone',
  poweredByHeader: false,
};

export default config;
