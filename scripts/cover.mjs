// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a night-blue gradient, the
// front panel of a small managed switch (copper ports with their link LEDs,
// fibre cages), network cables rising from the connected ports, and rate
// bars. Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const NIGHT = [10, 20, 40];
const DUSK = [24, 52, 92];
const PANEL = [196, 202, 212];
const PANEL_DARK = [150, 158, 170];
const PORT = [28, 32, 40];
const DARK = [40, 48, 60];
const GREEN = [70, 220, 120];
const AMBER = [250, 176, 40];
const CYAN = [86, 210, 236];
const BLUE = [0, 111, 255];
const STEEL = [120, 132, 150];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** The ports: x of each copper port, and whether a cable is plugged in. */
const COPPER = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
  cx: 196 + i * 50,
  up: [0, 1, 2, 5].includes(i),
}));
const FIBRE = [0, 1, 2, 3].map((i) => 596 + i * 32);
const PANEL_Y = 330;

function pixel(x, y) {
  let color = mix(NIGHT, DUSK, y / HEIGHT);
  // Cables rising from the connected ports, curving away to the top.
  for (const [i, { cx, up }] of COPPER.entries()) {
    if (!up) continue;
    const t = (PANEL_Y - 20 - y) / 260;
    if (t >= 0 && t <= 1) {
      const px = cx + (i - 3.5) * 40 * t * t;
      color = mix(color, i % 2 ? CYAN : BLUE, smooth(4, Math.abs(x - px)));
    }
  }
  // The switch body, its shadow line and its front panel.
  color = mix(color, DARK, smooth(0, roundedBox(x, y, 400, PANEL_Y + 14, 330, 62, 10)));
  color = mix(
    color,
    mix(PANEL, PANEL_DARK, (y - PANEL_Y + 50) / 110),
    smooth(0, roundedBox(x, y, 400, PANEL_Y, 324, 56, 8)),
  );
  // Copper ports, a link LED above each: green when connected.
  for (const { cx, up } of COPPER) {
    color = mix(color, PORT, smooth(0, roundedBox(x, y, cx, PANEL_Y + 8, 18, 16, 3)));
    color = mix(color, PANEL_DARK, smooth(0, roundedBox(x, y, cx, PANEL_Y + 22, 7, 4, 1)));
    color = mix(color, up ? GREEN : STEEL, smooth(3.5, Math.hypot(x - cx, y - (PANEL_Y - 24))));
  }
  // Fibre cages, one lit amber.
  for (const [i, cx] of FIBRE.entries()) {
    color = mix(color, PORT, smooth(0, roundedBox(x, y, cx, PANEL_Y + 8, 13, 10, 2)));
    color = mix(color, i === 0 ? AMBER : STEEL, smooth(3, Math.hypot(x - cx, y - (PANEL_Y - 24))));
  }
  // Rate bars, bottom center.
  for (const [i, h] of [18, 34, 26, 46, 30].entries()) {
    const bx = 350 + i * 25;
    color = mix(
      color,
      i === 3 ? GREEN : CYAN,
      smooth(0, roundedBox(x, y, bx, 495 - h / 2, 8, h / 2, 2)),
    );
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
