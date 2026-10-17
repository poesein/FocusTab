// Original FocusTab artwork: a focus dot and a white leaf on a green tile.
// Generated locally from geometry; no external image or font is fetched.
import { deflateSync } from 'node:zlib';

const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}

export function makeIcon(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const samples = 4;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / size;
          const v = (y + (sy + 0.5) / samples) / size;
          const dx = Math.max(Math.abs(u - 0.5) - 0.29, 0);
          const dy = Math.max(Math.abs(v - 0.5) - 0.29, 0);
          if (dx * dx + dy * dy > 0.18 * 0.18) continue;
          let color = [37, 99, 72];
          const lx = (u - 0.53) * 0.8 + (v - 0.43) * 0.6;
          const ly = -(u - 0.53) * 0.6 + (v - 0.43) * 0.8;
          if ((lx * lx) / (0.24 * 0.24) + (ly * ly) / (0.13 * 0.13) < 1) color = [242, 248, 232];
          if ((u - 0.32) ** 2 + (v - 0.69) ** 2 < 0.063 ** 2) color = [221, 185, 105];
          const stem = Math.abs(v - (1.015 - 1.05 * u));
          if (u > 0.38 && u < 0.64 && stem < 0.014) color = [37, 99, 72];
          for (let c = 0; c < 3; c++) sum[c] += color[c];
          sum[3] += 255;
        }
      const count = samples * samples;
      const off = row + 1 + x * 4;
      if (sum[3]) for (let c = 0; c < 3; c++) pixels[off + c] = Math.round((sum[c] * 255) / sum[3]);
      pixels[off + 3] = Math.round(sum[3] / count);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
