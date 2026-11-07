// Images as textures of a map: Texture2D objects with DXT1 mips stored in the package, as UDK saves them.
import { concat, pack } from './bytes.js';

const MAX = 1024;
const pow2 = n => Math.max(4, Math.min(MAX, 2 ** Math.round(Math.log2(n))));
export const textureSize = (w, h) => [pow2(w), pow2(h)];   // a picture's size as a texture: powers of two, 4 to 1024

function half({ w, h, rgba }) {                   // the next mip: 2x2 pixels averaged
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1), out = new Uint8Array(4 * W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let c = 0; c < 4; c++) {
      const at = (sx, sy) => rgba[4 * (Math.min(sy, h - 1) * w + Math.min(sx, w - 1)) + c];
      out[4 * (y * W + x) + c] = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1) + 2) >> 2;
    }
  }
  return { w: W, h: H, rgba: out };
}

const to565 = ([r, g, b]) => (r >> 3) << 11 | (g >> 2) << 5 | b >> 3;
const from565 = v => [(v >> 11 & 31) * 255 / 31, (v >> 5 & 63) * 255 / 63, (v & 31) * 255 / 31];

// DXT1 of an RGBA image: per 4x4 block the two corners of its colours' bounding box, pulled in a little, and each
// pixel's nearest of the four colours between them. Always four-colour blocks: no see-through pixels.
export function dxt1({ w, h, rgba }) {
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), out = new Uint8Array(8 * bw * bh), px = new Uint8Array(48);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (let k = 0; k < 16; k++) {
      const p = 4 * (Math.min(4 * by + (k >> 2), h - 1) * w + Math.min(4 * bx + (k & 3), w - 1));
      for (let c = 0; c < 3; c++) {
        px[3 * k + c] = rgba[p + c];
        lo[c] = Math.min(lo[c], rgba[p + c]);
        hi[c] = Math.max(hi[c], rgba[p + c]);
      }
    }
    for (let c = 0; c < 3; c++) { const inset = (hi[c] - lo[c]) >> 4; lo[c] += inset; hi[c] -= inset; }
    let c0 = to565(hi), c1 = to565(lo);
    if (c0 < c1) [c0, c1] = [c1, c0];
    const a = from565(c0), b = from565(c1), colours = [a, b, a.map((v, c) => (2 * v + b[c]) / 3), a.map((v, c) => (v + 2 * b[c]) / 3)];
    const o = 8 * (by * bw + bx);
    out.set([c0 & 255, c0 >> 8, c1 & 255, c1 >> 8], o);
    if (c0 === c1) continue;                      // one colour: index 0 everywhere
    for (let k = 0; k < 16; k++) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < 4; i++) {
        const d = (px[3 * k] - colours[i][0]) ** 2 + (px[3 * k + 1] - colours[i][1]) ** 2 + (px[3 * k + 2] - colours[i][2]) ** 2;
        if (d < bestD) [best, bestD] = [i, d];
      }
      out[o + 4 + (k >> 2)] |= best << 2 * (k & 3);
    }
  }
  return out;
}

// A Texture2D of `img` ({width, height, rgba}, power-of-two sides) added to `add` (ue3.js Additions); its 1-based
// reference. Mips go down to 1x1, the ones under 4 pixels stored as 4x4 blocks with the size 4, as UDK does.
export function addTexture(add, name, { width, height, rgba }) {
  const guid = () => crypto.getRandomValues(new Uint8Array(16)), int = (prop, v) => add.tag(prop, 'IntProperty', pack('<i', v));
  const mips = [{ w: width, h: height, rgba }];
  while (mips.at(-1).w > 1 || mips.at(-1).h > 1) mips.push(half(mips.at(-1)));
  const parts = [pack('<i', 0), int('SizeX', width), int('SizeY', height), int('OriginalSizeX', width), int('OriginalSizeY', height),
    add.tag('Format', 'ByteProperty', add.fname('PF_DXT1'), 'EPixelFormat'), int('MipTailBaseIdx', mips.length - 1),
    add.tag('LightingGuid', 'StructProperty', guid(), 'Guid'), add.fname('None')];
  const bulk = [], at = () => parts.reduce((n, p) => n + p.length, 0);
  const header = size => { bulk.push(at()); parts.push(pack('<Iiii', 0, size, size, 0)); };   // inline bulk data; its file offset is filled in on save
  header(0);                                      // no source picture
  parts.push(pack('<i', mips.length));
  for (const m of mips) {
    const data = dxt1(m);
    header(data.length);
    parts.push(data, pack('<ii', Math.max(4, m.w), Math.max(4, m.h)));
  }
  parts.push(guid(), pack('<3i', 0, 0, 0));       // texture file cache id, no PVRTC mips, Flash size, no ATITC mips
  header(0);                                      // no Flash mips
  parts.push(pack('<i', 0));                      // no ETC mips
  return add.addObject(add.classRef('Texture2D', 'Engine'), 0, name, concat(...parts), 0x000F000400000000n, bulk) + 1;
}
