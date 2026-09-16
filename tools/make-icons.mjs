// Renders the PWA PNG icons from the same motif as icons/icon.svg.
// Dependency-free: a tiny software rasteriser plus a minimal PNG encoder.
// Run: node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG     = [0x0f, 0x11, 0x15];
const PAPER  = [0xe6, 0xe8, 0xec];
const SPINE  = [0xd2, 0x79, 0x5a];
const RULE   = [0xa8, 0xb0, 0xbc];

// Painted in order, later shapes over earlier ones. Coordinates are in a
// 512x512 space and scaled to whatever size is being rendered.
const SHAPES = [
  { x: 0,   y: 0,   w: 512, h: 512, r: 96, color: BG },
  { x: 116, y: 96,  w: 280, h: 320, r: 26, color: PAPER },
  { x: 116, y: 96,  w: 44,  h: 320, r: 22, color: SPINE },
  { x: 188, y: 168, w: 164, h: 18,  r: 9,  color: RULE },
  { x: 188, y: 232, w: 164, h: 18,  r: 9,  color: RULE },
  { x: 188, y: 296, w: 108, h: 18,  r: 9,  color: RULE },
];

// Signed-distance test for a rounded rectangle.
function inside(px, py, s) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const qx = Math.max(Math.abs(px - cx) - (s.w / 2 - s.r), 0);
  const qy = Math.max(Math.abs(py - cy) - (s.h / 2 - s.r), 0);
  return Math.hypot(qx, qy) <= s.r;
}

function render(size) {
  const scale = size / 512;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = (x + 0.5) / scale;
      const cy = (y + 0.5) / scale;

      let color = null;
      for (const shape of SHAPES) if (inside(cx, cy, shape)) color = shape.color;

      const o = (y * size + x) * 4;
      if (color) {
        px[o] = color[0]; px[o + 1] = color[1]; px[o + 2] = color[2]; px[o + 3] = 255;
      }
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
