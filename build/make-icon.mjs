// 生成应用图标：黑色圆角方块 + 白色音符（纯色、无渐变），输出 build/icon.png
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const SS = 4; // 超采样抗锯齿
const BG = [0, 0, 0];

const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inEllipse = (x, y, cx, cy, rx, ry, rot) => {
  const dx = x - cx, dy = y - cy;
  const c = Math.cos(rot), s = Math.sin(rot);
  const u = dx * c + dy * s, v = -dx * s + dy * c;
  return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
};
// 双音符：两个符头 + 两根符干 + 一条横梁
const inNote = (x, y) =>
  inEllipse(x, y, 0.335, 0.705, 0.095, 0.072, -0.4) ||
  inEllipse(x, y, 0.635, 0.645, 0.095, 0.072, -0.4) ||
  (x >= 0.405 && x <= 0.44 && y >= 0.3 && y <= 0.7) ||
  (x >= 0.705 && x <= 0.74 && y >= 0.24 && y <= 0.64) ||
  (x >= 0.405 && x <= 0.74 && y >= 0.24 + (0.74 - x) * 0.18 && y <= 0.33 + (0.74 - x) * 0.18);

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let py = 0; py < SIZE; py++) {
  raw[py * (SIZE * 4 + 1)] = 0;
  for (let px = 0; px < SIZE; px++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) / SIZE;
      const y = (py + (sy + 0.5) / SS) / SIZE;
      if (inRoundRect(x, y, 0.225)) { bg++; if (inNote(x, y)) fg++; }
    }
    const n = SS * SS;
    const a = bg / n, w = bg ? fg / bg : 0;
    const o = py * (SIZE * 4 + 1) + 1 + px * 4;
    raw[o] = Math.round(BG[0] + (255 - BG[0]) * w);
    raw[o + 1] = Math.round(BG[1] + (255 - BG[1]) * w);
    raw[o + 2] = Math.round(BG[2] + (255 - BG[2]) * w);
    raw[o + 3] = Math.round(a * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out);
