#!/usr/bin/env node
/**
 * Generates icons/icon{16,32,48,128}.png — a red rounded square with a white
 * "stop" block. Written by hand with zlib rather than pulling in an image
 * dependency, since this repo otherwise has none.
 *
 *   node scripts/make-icons.js
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

/** Coverage of a rounded rectangle at (x, y), supersampled 4x4 for smooth edges. */
function roundedRectCoverage(x, y, size, radius) {
  const inset = size * 0.06;
  const min = inset;
  const max = size - inset;
  let hits = 0;

  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4;
      const py = y + (sy + 0.5) / 4;
      if (px < min || px > max || py < min || py > max) continue;

      // Nearest corner centre; inside the straight edges dx/dy go to zero.
      const dx = Math.max(min + radius - px, px - (max - radius), 0);
      const dy = Math.max(min + radius - py, py - (max - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / 16;
}

function makePng(size) {
  const radius = size * 0.24;
  const barHalf = size * 0.17;
  const centre = size / 2;

  // Each scanline is a filter byte (0 = none) followed by RGBA pixels.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let offset = 0;

  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const coverage = roundedRectCoverage(x, y, size, radius);
      const inBar =
        Math.abs(x + 0.5 - centre) <= barHalf && Math.abs(y + 0.5 - centre) <= barHalf;

      const [r, g, b] = inBar ? [255, 255, 255] : [204, 0, 0];
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = Math.round(coverage * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10-12: compression, filter, interlace — all 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, makePng(size));
  console.log(`wrote ${file}`);
}
