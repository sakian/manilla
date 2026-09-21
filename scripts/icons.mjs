/**
 * Generate every icon from the one logo (design/manilla-logo.png).
 *
 *   node scripts/icons.mjs
 *
 * Committed as generated files rather than built at deploy time, because a
 * favicon is not worth a build step - but the source and this script are here so
 * the set can be made again rather than being a folder of PNGs nobody can
 * reproduce.
 *
 * Everything sits on the app's own paper colour rather than transparency. The
 * mark's right half is charcoal, which disappears against a dark background, and
 * an icon has no control over what it is dropped onto - a home screen, a browser
 * tab, a task switcher. A tile is legible everywhere; a transparent mark is not.
 */

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const SRC = 'design/manilla-logo.png';
const PAPER = '#fbfaf8';

/** The mark alone, found by where the ink is rather than by hand-measured numbers. */
const MARK = { left: 543, top: 188, width: 322, height: 273 };

/** A rounded square the size of the canvas, to cut the corners with. */
const rounded = (size, radius) =>
  Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );

/**
 * The mark on a tile. `padding` is the share of the tile left around it: a
 * maskable icon needs enough that a circular crop cannot bite into the letter.
 */
async function tile(size, { padding = 0.16, radius = 0 } = {}) {
  const inner = Math.round(size * (1 - padding * 2));
  const mark = await sharp(SRC)
    .extract(MARK)
    .resize(inner, inner, { fit: 'contain', background: PAPER })
    .toBuffer();

  let image = sharp({
    create: { width: size, height: size, channels: 4, background: PAPER },
  }).composite([{ input: mark, gravity: 'center' }]);

  if (radius > 0) {
    image = sharp(await image.png().toBuffer()).composite([
      { input: rounded(size, radius), blend: 'dest-in' },
    ]);
  }
  return image.png();
}

await mkdir('public', { recursive: true });

// Next serves app/icon.png and app/apple-icon.png as the favicon and the iOS
// icon, and writes the link tags itself.
await (await tile(256, { padding: 0.14 })).toFile('app/icon.png');
await (await tile(180, { padding: 0.14 })).toFile('app/apple-icon.png');

// The manifest's own set. The maskable one is padded harder: Android crops it to
// whatever shape the launcher feels like.
await (await tile(192, { padding: 0.14 })).toFile('public/icon-192.png');
await (await tile(512, { padding: 0.14 })).toFile('public/icon-512.png');
await (await tile(512, { padding: 0.24 })).toFile('public/icon-maskable-512.png');

// The one in the top bar, at twice its rendered size for a sharp screen.
await (await tile(64, { padding: 0.08, radius: 14 })).toFile('public/logo.png');

console.log('icons: app/icon.png, app/apple-icon.png, public/icon-{192,512}.png,');
console.log('       public/icon-maskable-512.png, public/logo.png');
