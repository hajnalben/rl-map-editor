// What a map's surfaces look like, for drawing them: the textures stored in the map, decoded to RGBA, and for each
// surface the texture or colour it shows. Workshop maps make their surfaces as instances of the game's materials
// with a Diffuse (or Emissive, PaintTexture) texture or a Color; the game's own surfaces live in its encrypted
// packages, so for those only the name gives a hint.
import { unpackFrom } from './bytes.js';
import { bulkAt } from './compact.js';
import { nodeProps } from './kismet.js';

const TEXTURE_PARAMS = ['Diffuse', 'Emissive', 'PaintTexture', 'SourceTexture'];
const COLOR_PARAMS = ['Color', 'CollisionColor'];
const GUESSES = [[/glass|transparent|clear/i, '#cfe6ff'], [/lava|fire|magma/i, '#ff4a1c'], [/metal|steel|chrome/i, '#9aa0a8'],
                 [/concrete|cement|stone|rock|asphalt/i, '#a7a6a1'], [/ice|snow/i, '#dcefff'], [/grass/i, '#5f9a45'],
                 [/sand|dirt/i, '#c9a46c'], [/white/i, '#ececec'], [/black/i, '#2a2a2a'], [/boost|orange/i, '#ff9a2e']];
const SEE_THROUGH = /glass|transparent|clear|collision/i;

const hex = rgb => '#' + rgb.slice(0, 3).map(c => Math.round(255 * Math.min(1, Math.max(0, c)) ** (1 / 2.2)).toString(16).padStart(2, '0')).join('');
const params = (list) => new Map((Array.isArray(list) ? list : []).map(v => [v.ParameterName, v.ParameterValue]));

// {name, texture (export index or null), color (CSS colour or null), emissive, opacity} of surface `ref`
// (a 1-based export or negative import reference); nothing known gives all nulls.
export function surfaceLook(pkg, ref) {
  const name = ref ? pkg.ref(ref) : '';
  let texture = null, color = null, emissive = false;
  for (let r = ref, hops = 0; r > 0 && hops < 8 && texture === null && color === null; hops++) {
    const e = pkg.exports[r - 1];
    if (pkg.classOf(e) !== 'MaterialInstanceConstant') break;
    const p = nodeProps(pkg, e), textures = params(p.TextureParameterValues), vectors = params(p.VectorParameterValues);
    const param = TEXTURE_PARAMS.find(n => textures.get(n) > 0 && pkg.classOf(pkg.exports[textures.get(n) - 1]) === 'Texture2D');
    if (param) [texture, emissive] = [textures.get(param) - 1, param === 'Emissive'];
    const tint = COLOR_PARAMS.map(n => vectors.get(n)).find(Array.isArray);
    if (tint && texture === null) color = hex(tint);
    r = p.Parent;
  }
  if (texture === null && color === null) color = GUESSES.find(([re]) => re.test(name))?.[1] ?? null;
  return { name, texture, color, emissive, opacity: SEE_THROUGH.test(name) ? 0.35 : 1 };
}

const BLOCK = { PF_DXT1: 8, PF_DXT3: 16, PF_DXT5: 16 }, PIXEL = { PF_A8R8G8B8: 4, PF_G8: 1 };
const UNREADABLE = 0x01 | 0x02 | 0x10 | 0x20 | 0x80;   // bulk data elsewhere, compressed, or unused

// {width, height, rgba} of texture `i`'s largest stored mip no bigger than `max` (else its smallest), or null when
// it can't be read
export function textureImage(pkg, i, max = 1024) {
  const e = pkg.exports[i], f = pkg.get(e, 'Format', '<i'), format = f && pkg.names[f[0]];
  const bytes = (w, h) => BLOCK[format] ? Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * BLOCK[format] : w * h * PIXEL[format];
  if (!BLOCK[format] && !PIXEL[format]) return null;
  let p = pkg.skipProperties(e), pick = null;
  const source = bulkAt(pkg, p);
  if (source === null) return null;
  p += 16 + source;
  const count = unpackFrom('<i', pkg.data, p)[0];
  p += 4;
  for (let k = 0; k < count && !(pick && Math.max(pick.w, pick.h) <= max); k++) {   // mips go from big to small
    const size = bulkAt(pkg, p);
    if (size === null) break;
    const flags = unpackFrom('<I', pkg.data, p)[0], [w, h] = unpackFrom('<ii', pkg.data, p + 16 + size);
    if (!(flags & UNREADABLE) && size === bytes(w, h)) pick = { w, h, src: pkg.data.subarray(p + 16, p + 16 + size) };
    p += 16 + size + 8;
  }
  if (!pick) return null;
  const { w, h, src } = pick;
  return { width: w, height: h, rgba: BLOCK[format] ? decodeBlocks(src, w, h, format) : decodePixels(src, w, h, format) };
}

function decodePixels(src, w, h, format) {
  const out = new Uint8Array(4 * w * h);
  for (let k = 0; k < w * h; k++) {
    if (format === 'PF_G8') out.set([src[k], src[k], src[k], 255], 4 * k);
    else out.set([src[4 * k + 2], src[4 * k + 1], src[4 * k], src[4 * k + 3]], 4 * k);   // stored B G R A
  }
  return out;
}

function decodeBlocks(src, w, h, format) {        // S3TC (DXT1/3/5): 4x4 pixel blocks
  const out = new Uint8Array(4 * w * h), size = BLOCK[format], bw = Math.max(1, Math.ceil(w / 4));
  const palette = new Uint8Array(16), alpha = new Uint8Array(16), ramp = new Uint8Array(8);
  for (let b = 0; b * size < src.length; b++) {
    const at = b * size, c = at + size - 8;
    const c0 = src[c] | src[c + 1] << 8, c1 = src[c + 2] | src[c + 3] << 8, four = c0 > c1 || format !== 'PF_DXT1';
    for (const [k, v] of [[0, c0], [1, c1]]) palette.set([(v >> 11 & 31) * 255 / 31, (v >> 5 & 63) * 255 / 63, (v & 31) * 255 / 31, 255], 4 * k);
    for (let ch = 0; ch < 3; ch++) {
      palette[8 + ch] = four ? (2 * palette[ch] + palette[4 + ch]) / 3 : (palette[ch] + palette[4 + ch]) / 2;
      palette[12 + ch] = four ? (palette[ch] + 2 * palette[4 + ch]) / 3 : 0;
    }
    palette[11] = 255;
    palette[15] = four ? 255 : 0;                 // DXT1's 3-colour blocks: index 3 is see-through black
    if (format === 'PF_DXT3') for (let k = 0; k < 16; k++) alpha[k] = (src[at + (k >> 1)] >> 4 * (k & 1) & 15) * 17;
    if (format === 'PF_DXT5') {
      const a0 = src[at], a1 = src[at + 1];
      ramp[0] = a0; ramp[1] = a1;
      for (let k = 0; k < 6; k++) ramp[k + 2] = a0 > a1 ? ((6 - k) * a0 + (k + 1) * a1) / 7 : k < 4 ? ((4 - k) * a0 + (k + 1) * a1) / 5 : k === 4 ? 0 : 255;
      const lo = src[at + 2] | src[at + 3] << 8 | src[at + 4] << 16, hi = src[at + 5] | src[at + 6] << 8 | src[at + 7] << 16;
      for (let k = 0; k < 16; k++) alpha[k] = ramp[(k < 8 ? lo >> 3 * k : hi >> 3 * (k - 8)) & 7];
    }
    const bx = 4 * (b % bw), by = 4 * Math.floor(b / bw);
    for (let k = 0; k < 16; k++) {
      const x = bx + (k & 3), y = by + (k >> 2);
      if (x >= w || y >= h) continue;
      const i = 4 * ((src[c + 4 + (k >> 2)] >> 2 * (k & 3)) & 3), o = 4 * (y * w + x);
      out[o] = palette[i]; out[o + 1] = palette[i + 1]; out[o + 2] = palette[i + 2];
      out[o + 3] = format === 'PF_DXT1' ? palette[i + 3] : alpha[k];
    }
  }
  return out;
}
