/**
 * Icon generator — creates PNG icons for the Chrome extension.
 * Run with: node generate_icons.js
 * Requires: no external dependencies (uses built-in canvas via node-canvas
 * if available, otherwise falls back to writing minimal valid PNG binaries).
 */

const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, 'icons');
if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR);

// Try to use canvas if available
let canvas;
try {
  canvas = require('canvas');
} catch (e) {
  canvas = null;
}

function createIconWithCanvas(size) {
  const { createCanvas } = canvas;
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');

  // Background: deep navy
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, size, size);

  // Rounded rect background (simulate border-radius)
  const radius = size * 0.18;
  ctx.fillStyle = '#16213e';
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(size - radius, 0);
  ctx.quadraticCurveTo(size, 0, size, radius);
  ctx.lineTo(size, size - radius);
  ctx.quadraticCurveTo(size, size, size - radius, size);
  ctx.lineTo(radius, size);
  ctx.quadraticCurveTo(0, size, 0, size - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();

  // Gradient overlay
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, 'rgba(88,101,242,0.5)');
  grad.addColorStop(1, 'rgba(15,52,96,0.3)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Arrow symbol ← (RTL arrow)
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const fontSize = Math.round(size * 0.52);
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  ctx.fillText('←', size / 2, size / 2 + size * 0.03);

  return c.toBuffer('image/png');
}

/**
 * Minimal valid 1×1 PNG (transparent) as fallback.
 * We'll create a solid-color PNG manually using raw bytes for each size.
 */
function createMinimalPNG(size) {
  // We'll create a simple solid-color PNG using a pure JS implementation
  // This avoids any external dependency.

  function crc32(buf) {
    let crc = -1;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([typeBytes, data]);
    const crcVal = Buffer.alloc(4);
    crcVal.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, typeBytes, data, crcVal]);
  }

  function deflateSync(data) {
    // Use zlib (built into Node.js)
    return require('zlib').deflateSync(data, { level: 9 });
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);   // width
  ihdr.writeUInt32BE(size, 4);   // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Image data: each row = filter byte (0) + RGB per pixel
  // Draw a simple icon: dark bg with a white ← drawn as pixels
  const rows = [];
  const BG = [26, 26, 46];    // #1a1a2e
  const ACCENT = [88, 101, 242]; // #5865f2
  const FG = [255, 255, 255];  // white

  // Simple geometric arrow for small sizes
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    const row = [0]; // filter byte
    for (let x = 0; x < size; x++) {
      // Draw accent border ring
      const borderW = Math.max(1, Math.floor(size * 0.06));
      if (x < borderW || x >= size - borderW || y < borderW || y >= size - borderW) {
        row.push(...ACCENT);
        continue;
      }

      // Draw ← arrow shape as simple geometry
      const nx = (x - cx) / (size * 0.35); // normalized -1..1
      const ny = (y - cy) / (size * 0.35);

      // Arrow shaft: horizontal bar in middle third
      const isShaft = Math.abs(ny) < 0.15 && nx > -0.3 && nx < 0.7;
      // Arrowhead: two diagonal lines on the left
      const isHead = (Math.abs(ny + nx * 0.6) < 0.15 && nx > -0.9 && nx < -0.2)
                  || (Math.abs(ny - nx * 0.6) < 0.15 && nx > -0.9 && nx < -0.2);

      if (isShaft || isHead) {
        row.push(...FG);
      } else {
        row.push(...BG);
      }
    }
    rows.push(Buffer.from(row));
  }

  const rawData = Buffer.concat(rows);
  const compressed = deflateSync(rawData);

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return png;
}

const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  let pngData;
  if (canvas) {
    pngData = createIconWithCanvas(size);
    console.log(`✓ Generated icon${size}.png using canvas`);
  } else {
    pngData = createMinimalPNG(size);
    console.log(`✓ Generated icon${size}.png (geometric, no canvas)`);
  }
  fs.writeFileSync(path.join(ICONS_DIR, `icon${size}.png`), pngData);
}

console.log('Icons generated in ./icons/');
