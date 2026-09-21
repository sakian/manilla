import type { MetadataRoute } from 'next';

/**
 * What a phone needs to treat Manilla as an installed app rather than a
 * bookmark (VW-3's "usable on a phone", taken literally).
 *
 * `standalone` is the point of it: added to a home screen, it opens without
 * browser chrome, which on a small screen is two rows of pixels back and one
 * less thing between you and the envelopes.
 *
 * Nothing here is public. The app only resolves on the tailnet, so this is
 * metadata for the one household that can reach it.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Manilla',
    short_name: 'Manilla',
    description: 'Envelope budgeting',
    start_url: '/',
    display: 'standalone',
    background_color: '#fbfaf8',
    theme_color: '#fbfaf8',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Cropped to whatever shape the launcher fancies, so it is padded harder.
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
