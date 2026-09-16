// Renders the PWA PNG icons from the same motif as icons/icon.svg.
// Dependency-free: a tiny software rasteriser plus a minimal PNG encoder.
// Run: node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [0x0f, 0x11, 0x15];
const LINE = [0x2b, 0x30, 0x38];
const ACCENT = [0xd2, 0x79, 0x5a];
const MUTED = [0x8b, 0x93, 0xa1];

const NODES = [
  { x: 256, y: 150, r: 30, c: ACCENT },
  { x: 146, y: 300, r: 24, c: ACCENT },
  { x: 366, y: 300, r: 24, c: ACCENT },
  { x: 256, y: 300, r: 20, c: ACCENT },
  { x: 256, y: 378, r: 14, c: MUTED },
];
const EDGES = [[0, 1], [0, 2], [1, 2], [0, 3], [3, 4]];

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function render(size) {
  const s = size / 512;
  const px = Buffer.alloc(size * size * 4);
  const radius = 96 * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = (x + 0.5) / s, cy = (y + 0.5) / s;
      let color = BG, alpha = 255;

      // rounded-rectangle mask
      const qx = Math.max(radius / s - cx, cx - (512 - radius / s), 0);
      const qy = Math.max(radius / s - cy, cy - (512 - radius / s), 0);
      if (Math.hypot(qx, qy) > radius / s) alpha = 0;

      for (const [i, j] of EDGES) {
        if (distToSegment(cx, cy, NODES[i], NODES[j]) <= 5) color = LINE;
      }
      for (const n of NODES) {
        if (Math.hypot(cx - n.x, cy - n.y) <= n.r) color = n.c;
      }

      const o = (y * size + x) * 4;
      px[o] = color[0]; px[o + 1] = color[1]; px[o + 2] = color[2]; px[o + 3] = alpha;
    }
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), png(size, render(size)));
  console.log(`icons/icon-${size}.png`);
}
