#!/usr/bin/env node
/**
 * Generates icons/icon{16,32,48,128}.png — a padlock with a play-triangle
 * cutout in its body, on a rounded indigo square: locked video, at a glance.
 * Written by hand with zlib rather than pulling in an image dependency, since
 * this repo otherwise has none.
 *
 *   node scripts/make-icons.js
 *
 * Every shape below is defined as a function of the icon size (0..1
 * fractions in ICON), so the same proportions hold at 16px and 128px alike.
 * Proportions were tuned by rendering at 16/32/48/128px and checking a raw
 * pixel dump at 16px — a padlock's thin parts (the shackle ring, the walls
 * either side of the triangle) disappear first at small sizes, so the body
 * and shackle are deliberately bold rather than to scale with a "real"
 * padlock.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
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

const SUPERSAMPLE = 4; // per axis, for antialiased edges

/** Coverage of a rounded rectangle at pixel (px, py), in absolute coordinates. */
function roundedRectCoverage(px, py, x0, y0, x1, y1, radius) {
  let hits = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const x = px + (sx + 0.5) / SUPERSAMPLE;
      const y = py + (sy + 0.5) / SUPERSAMPLE;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const dx = Math.max(x0 + radius - x, x - (x1 - radius), 0);
      const dy = Math.max(y0 + radius - y, y - (y1 - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

/**
 * The padlock's shackle: the upper half of a ring (an annulus restricted to
 * its own centre's y and above), so its flat-cut bottom edges sit flush
 * against the body — one shape, no separate "legs" to align by hand.
 */
function archCoverage(px, py, cx, cy, rInner, rOuter) {
  let hits = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const x = px + (sx + 0.5) / SUPERSAMPLE;
      const y = py + (sy + 0.5) / SUPERSAMPLE;
      if (y > cy) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d >= rInner && d <= rOuter) hits++;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

function edgeSign(ax, ay, bx, by, cx, cy) {
  return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
}

function triangleCoverage(px, py, x0, y0, x1, y1, x2, y2) {
  let hits = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const x = px + (sx + 0.5) / SUPERSAMPLE;
      const y = py + (sy + 0.5) / SUPERSAMPLE;
      const d1 = edgeSign(x, y, x0, y0, x1, y1);
      const d2 = edgeSign(x, y, x1, y1, x2, y2);
      const d3 = edgeSign(x, y, x2, y2, x0, y0);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) hits++;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

const ICON = {
  bg: { radiusFrac: 0.22, insetFrac: 0.03 },
  colors: {
    bg: [0x22, 0x2f, 0x6b], // deep indigo — distinct from the red/black most blockers use
    lock: [0xf5, 0xf5, 0xf7] // near-white
  },
  body: { x0: 0.24, y0: 0.44, x1: 0.76, y1: 0.80, radius: 0.06 },
  shackle: { cx: 0.5, overlap: 0.02, rInner: 0.11, rOuter: 0.205 },
  // A play triangle "cut" out of the body, tip pointing right.
  triangle: { x0: 0.40, y0: 0.50, x1: 0.40, y1: 0.74, x2: 0.62, y2: 0.62 }
};

function makePng(size) {
  const bgRadius = size * ICON.bg.radiusFrac;
  const bgInset = size * ICON.bg.insetFrac;

  const bodyX0 = size * ICON.body.x0;
  const bodyY0 = size * ICON.body.y0;
  const bodyX1 = size * ICON.body.x1;
  const bodyY1 = size * ICON.body.y1;
  const bodyRadius = size * ICON.body.radius;

  const shackleCx = size * ICON.shackle.cx;
  const shackleCy = bodyY0 + size * ICON.shackle.overlap;
  const shackleRInner = size * ICON.shackle.rInner;
  const shackleROuter = size * ICON.shackle.rOuter;

  const triX0 = size * ICON.triangle.x0, triY0 = size * ICON.triangle.y0;
  const triX1 = size * ICON.triangle.x1, triY1 = size * ICON.triangle.y1;
  const triX2 = size * ICON.triangle.x2, triY2 = size * ICON.triangle.y2;

  const bg = ICON.colors.bg;
  const lock = ICON.colors.lock;

  // Each scanline is a filter byte (0 = none) followed by RGBA pixels.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let offset = 0;

  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const outer = roundedRectCoverage(x, y, bgInset, bgInset, size - bgInset, size - bgInset, bgRadius);

      var lockCoverage = roundedRectCoverage(x, y, bodyX0, bodyY0, bodyX1, bodyY1, bodyRadius);
      lockCoverage = Math.min(1, lockCoverage + archCoverage(x, y, shackleCx, shackleCy, shackleRInner, shackleROuter));

      const hole = triangleCoverage(x, y, triX0, triY0, triX1, triY1, triX2, triY2);
      const lockFraction = lockCoverage * (1 - hole);

      raw[offset++] = mix(bg[0], lock[0], lockFraction);
      raw[offset++] = mix(bg[1], lock[1], lockFraction);
      raw[offset++] = mix(bg[2], lock[2], lockFraction);
      raw[offset++] = Math.round(outer * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12: compression, filter, interlace — all 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, makePng(size));
  console.log(`wrote ${file}`);
}
