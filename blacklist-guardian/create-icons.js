/**
 * Generates the three PNG icon files required by the extension.
 * Run once with: node create-icons.js
 *
 * Uses only Node.js built-in modules — no npm packages needed.
 * The icons are solid-colored squares with a shield symbol drawn using
 * simple geometry. (For a more polished icon, replace the generated files
 * with your own design using any image editor.)
 */

'use strict';

const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');

// ── CRC32 (required by the PNG format) ─────────────────────────────────────

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ────────────────────────────────────────────────────────

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len     = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crcVal  = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcVal]);
}

// ── Draw a simple shield icon into a pixel buffer ────────────────────────────
// The icon is a red background with a white shield silhouette.

function drawIcon(size) {
  // RGBA pixel buffer, initially transparent / background colour
  const pixels = new Uint8Array(size * size * 4);

  // Background: deep red  #991b1b  (rgb 153, 27, 27)
  const [bgR, bgG, bgB] = [153, 27, 27];

  // Foreground (shield): white
  const [fgR, fgG, fgB] = [255, 255, 255];

  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i]   = r;
    pixels[i+1] = g;
    pixels[i+2] = b;
    pixels[i+3] = a;
  }

  // Fill background
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      setPixel(x, y, bgR, bgG, bgB);

  // Draw a simplified shield shape in white.
  // Shield: arched top half, pointed bottom.
  // We use normalised coordinates [0,1] and scale to `size`.
  const margin = size * 0.15;
  const left   = Math.round(margin);
  const right  = size - 1 - Math.round(margin);
  const top    = Math.round(size * 0.12);
  const bottom = size - 1 - Math.round(size * 0.08);
  const midX   = Math.round(size / 2);
  const midY   = Math.round(size * 0.55); // where the arch transitions to the point

  // For each pixel inside the shield shape, paint it white.
  for (let y = top; y <= bottom; y++) {
    const t = (y - top) / (bottom - top); // 0 at top, 1 at bottom

    let xLeft, xRight;
    if (t < 0.5) {
      // Upper half: straight sides
      xLeft  = left;
      xRight = right;
    } else {
      // Lower half: converge to a point at the bottom
      const s = (t - 0.5) / 0.5; // 0..1 from midpoint to bottom
      xLeft  = Math.round(left  + s * (midX - left));
      xRight = Math.round(right - s * (right - midX));
    }

    for (let x = xLeft; x <= xRight; x++) {
      setPixel(x, y, fgR, fgG, fgB);
    }
  }

  // Draw the arched top: a semi-circle cap
  const radius = (right - left) / 2;
  const cx     = midX;
  const cy     = top + Math.round(radius * 0.6);
  for (let y = Math.max(0, top - Math.round(radius)); y <= top + Math.round(radius); y++) {
    for (let x = left; x <= right; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius * 1.1 && y <= cy) {
        setPixel(x, y, fgR, fgG, fgB);
      }
    }
  }

  return pixels;
}

// ── Build a valid PNG file from raw RGBA pixels ──────────────────────────────

function buildPNG(size, pixels) {
  // IHDR: width, height, bit depth 8, colour type 6 (RGBA), compression 0, filter 0, interlace 0
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData.writeUInt8(8,  8);  // bit depth
  ihdrData.writeUInt8(6,  9);  // colour type: RGBA
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);

  // Raw image data: one filter byte (0 = None) per row, then RGBA values
  const rowSize = 1 + size * 4;
  const raw     = Buffer.alloc(size * rowSize);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const pi = (y * size + x) * 4;
      const ri = y * rowSize + 1 + x * 4;
      raw[ri]   = pixels[pi];   // R
      raw[ri+1] = pixels[pi+1]; // G
      raw[ri+2] = pixels[pi+2]; // B
      raw[ri+3] = pixels[pi+3]; // A
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  const PNG_SIG  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const IEND_DATA = Buffer.alloc(0);
  const iendType = Buffer.from('IEND');
  const iendCrc  = Buffer.alloc(4); iendCrc.writeUInt32BE(crc32(iendType), 0);
  const IEND     = Buffer.concat([Buffer.alloc(4), iendType, iendCrc]);

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdrData),
    chunk('IDAT', compressed),
    IEND
  ]);
}

// ── Generate icons ────────────────────────────────────────────────────────────

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const pixels  = drawIcon(size);
  const pngData = buildPNG(size, pixels);
  const file    = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(file, pngData);
  console.log(`Created icons/icon${size}.png  (${pngData.length} bytes)`);
}

console.log('\nDone! Icons are in the icons/ folder.');
