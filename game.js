// Rocket League's own packages (TAGame/CookedPCConsole), read-only, for the textures maps borrow from them. The game
// encrypts a package's header region (names, imports, exports and the chunk table) with AES-256-ECB and stores the
// objects in zlib-compressed chunks (as RLUPKTool, github.com/Martinii89/RLUPKT, reads them). openGame gives the
// package to ue3.js's Package as UDK would have saved it, uncompressed, inflating chunks only when an object's data
// is needed.
import { packInto, unpackFrom } from './bytes.js';
import { decodeTexture } from './looks.js';
import { nodeProps } from './kismet.js';
import { Package, unchunk } from './ue3.js';

// the key RLUPKTool ships with, which opens the game's map packages
const KEY = Uint8Array.from([0xC7, 0xDF, 0x6B, 0x13, 0x25, 0x2A, 0xCC, 0x71, 0x47, 0xBB, 0x51, 0xC9, 0x8A, 0xD7, 0xE3, 0x4B,
                             0x7F, 0xE5, 0x00, 0xB7, 0x7F, 0xA5, 0xFA, 0xB2, 0x93, 0xE2, 0xF2, 0x4E, 0x6B, 0x17, 0xE7, 0x79]);

// AES-ECB from WebCrypto's AES-CBC: CBC decryption gives D(C[i]) xor C[i-1], so xor C[i-1] back in. CBC wants valid
// padding at the end, so a block that decrypts to a full padding block (encrypted after the last one) goes last.
async function ecbDecrypt(data) {
  const key = await crypto.subtle.importKey('raw', KEY, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const last = data.subarray(data.length - 16);
  const pad = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, key, new Uint8Array(16).fill(16))).subarray(0, 16);
  const joined = new Uint8Array(data.length + 16);
  joined.set(data);
  joined.set(pad, data.length);
  const out = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, joined));
  for (let k = 16; k < out.length; k++) out[k] ^= data[k - 16];
  return out;
}

// A game package read through `read(offset, size)` (bytes of its file): {pkg, load}. The tables come at once;
// `load(i)` inflates the chunks holding object i, so pkg.data has its data.
export async function openGame(read) {
  const head = await read(0, 8192);               // the summary: about 1.5 KB
  let p = 0;
  const i32 = () => { const v = unpackFrom('<i', head, p)[0]; p += 4; return v; };
  const skipString = () => { const n = i32(); p += n < 0 ? -2 * n : n; };
  const [tag, , licensee] = unpackFrom('<IHH', head, 0);
  if (tag !== 0x9E2A83C1) throw new Error('not an Unreal package');
  p = 8;
  const headerSize = i32();
  skipString();
  p += 4;                                         // package flags
  const nameOffset = (p += 4, i32());
  p += 4 * 9 + 16;                                // export/import counts and offsets, depends, 4 more; guid
  const generations = i32();
  p += 12 * generations + 8;                      // engine and cooker versions
  const compressionAt = p, compression = i32(), chunkCount = i32();
  if (!compression) return { pkg: new Package(await read(0, Infinity)), load: async () => {} };   // as UDK saved it
  if (!(compression & 1)) throw new Error(`compression ${compression} is not zlib`);
  const wide = licensee >= 22;                    // chunk offsets are 64-bit
  p += chunkCount * (wide ? 24 : 16) + 4;
  const strings = i32();
  for (let k = 0; k < strings; k++) skipString();
  const allocations = i32();
  for (let k = 0; k < allocations; k++) { p += 20; const n = i32(); p += 4 * n; }
  const garbage = i32(), chunkInfoAt = i32();
  const encrypted = (headerSize - garbage - nameOffset + 15) & ~15;
  const header = await ecbDecrypt(await read(nameOffset, encrypted));

  // the chunk table ends the header; today's game adds 12 bytes to RLUPKTool's 24 per entry, so measure the stride
  const count = unpackFrom('<i', header, chunkInfoAt)[0], chunks = [];
  const stride = Math.floor((header.length - chunkInfoAt - 4) / count / 4) * 4;
  if (stride < (wide ? 24 : 16)) throw new Error('chunk table too short: wrong key?');
  for (let k = 0, q = chunkInfoAt + 4; k < count; k++, q += stride) {
    const [uOff, uSize, cOff, cSize] = wide ? unpackFrom('<qiqi', header, q).map(Number) : unpackFrom('<iiii', header, q);
    chunks.push({ uOff, uSize, cOff, cSize, done: false });
  }
  const tables = new Uint8Array(nameOffset + header.length);
  tables.set(head.subarray(0, nameOffset));
  tables.set(header, nameOffset);
  packInto('<ii', tables, compressionAt, 0, 0);   // uncompressed, as far as Package knows
  const pkg = new Package(tables), size = Math.max(tables.length, ...chunks.map(c => c.uOff + c.uSize));
  async function load(i) {
    const e = pkg.exports[i];
    if (pkg.data.length < size) { const all = new Uint8Array(size); all.set(pkg.data); pkg.data = all; }
    for (const c of chunks) {
      if (c.done || c.uOff >= e.off + e.size || e.off >= c.uOff + c.uSize) continue;
      pkg.data.set(await unchunk(await read(c.cOff, c.cSize)), c.uOff);
      c.done = true;
    }
  }
  return { pkg, load };
}

const pathOf = (pkg, i) => { const names = []; for (let r = i + 1; r > 0; r = pkg.exports[r - 1].outer) names.unshift(pkg.exports[r - 1].name); return names.join('.').toLowerCase(); };

// Where the game's textures and materials are: Map(object path, lower case -> package name), from the tables of the
// packages `names` (opened with `open`). Materials import textures by their original group (TiledPatterns.Hexagons_N),
// which is no file of its own: the game has it cooked into some other package.
/** @param {(k: number, n: number) => void} [progress] */
export async function gameIndex(names, open, progress = () => {}) {
  const index = new Map();
  for (const [k, name] of names.entries()) {
    progress(k, names.length);
    const g = await open(name).catch(() => null);
    if (!g) continue;
    g.pkg.exports.forEach((e, i) => {
      if (!/^(Texture2D|Material|MaterialInstanceConstant)$/.test(g.pkg.classOf(e))) return;
      const key = pathOf(g.pkg, i);
      if (!index.has(key)) index.set(key, name);
    });
  }
  return index;
}

// A texture of a game package as {width, height, rgba}: its biggest mip no wider than `max` that is in the package,
// or, with `cache` (async (name, offset, size) -> the bytes of the named .tfc file there), from the texture file
// cache it names. The game's bulk data headers: flags, count, size on disk, then a 64-bit offset only when the data
// is elsewhere (flag 1); flag 2 means zlib chunks as in packages.
export async function gameTexture(pkg, i, { max = 512, cache = null } = {}) {
  const e = pkg.exports[i], d = pkg.data, f = pkg.get(e, 'Format', '<i'), format = f && pkg.names[f[0]];
  const tfc = pkg.get(e, 'TextureFileCacheName', '<ii');
  let p = pkg.skipProperties(e);
  p += 12;                                        // the source art: empty
  const count = unpackFrom('<i', d, p)[0], mips = [];
  p += 4;
  for (let k = 0; k < count; k++) {
    const [flags, , size] = unpackFrom('<Iii', d, p);
    const away = flags & 1, offset = away ? Number(unpackFrom('<q', d, p + 12)[0]) : null;
    const at = p + 12 + (away ? 8 : 0), [w, h] = unpackFrom('<ii', d, at + (away ? 0 : size));
    mips.push({ w, h, flags, size, offset, at });
    p = at + (away ? 0 : size) + 8;
  }
  const fits = mips.filter(m => Math.max(m.w, m.h) <= max && m.size > 0 && !(m.flags & 1 && m.offset < 0));   // -1: not shipped
  for (const m of fits) {
    if (!(m.flags & 1)) return decodeTexture(d.subarray(m.at, m.at + m.size), m.w, m.h, format);
    if (!cache || !tfc) continue;
    try {
      const raw = await cache(pkg.names[tfc[0]], m.offset, m.size);
      return decodeTexture(m.flags & 2 ? await unchunk(raw) : raw, m.w, m.h, format);
    } catch { /* a cache that can't be read: a smaller mip in the package will do */ }
  }
  return null;
}

// What a game material looks like: {texture: {width, height, rgba} or null, color: linear [r, g, b] or null}, null
// when nothing is known. The game's shaders mix textures in ways a preview can't, so this takes one colour texture
// (a parameter or, for a plain Material, a texture it uses, named like one: not a normal map, mask, packed channels
// or reflection) and a tint (a Color-like vector parameter), following material instances to their parents. With
// no colour texture to be had, a mask or packed one does, in grey. `path` is the material's import path, its package
// first; `open(name)` gives a game package ({pkg, load}, openGame) or null; `cache` reads texture file caches
// (gameTexture); `index` (gameIndex) finds objects cooked into other packages.
const NOT_COLOUR = /normal|_n$|_n_|mask|pack|rgb|cube|env|spec|rough|metal|noise|_m$|_s$|lowquality|cheap|caustic/i;
const GREY_ONLY = /mask|pack|rgb/i, NEVER = /normal|_n$|_n_|cube|env|noise|caustic|curve/i;
const COLOUR = /diffuse|albedo|base_?colou?r|^colou?r|texture$|emissive|_d$|_t$|_diff|_col|_clr/i;
const TINT = /^(layer1_)?(diffuse_?|base_?)?colou?r$|^tint$/i;
export async function gameLook(open, cache, path, index = null) {
  let at = await find(open, path, index), color = null;
  const colour = [], grey = [];                   // texture candidates, {g, ref}, best first
  const add = (g, refs, byName) => {
    const named = refs.map(r => [r, textureName(g.pkg, r)]).filter(([, n]) => n && !NEVER.test(n));
    const good = named.filter(([, n]) => !NOT_COLOUR.test(n)), ranked = byName ? [...good.filter(([, n]) => COLOUR.test(n)), ...good.filter(([, n]) => !COLOUR.test(n))] : good;
    colour.push(...ranked.map(([ref]) => ({ g, ref })));
    grey.push(...named.filter(([, n]) => GREY_ONLY.test(n)).map(([ref]) => ({ g, ref })));
  };
  for (let hops = 0; at && hops < 8; hops++) {
    const { g, i } = at, e = g.pkg.exports[i], cls = g.pkg.classOf(e);
    await g.load(i);
    if (cls === 'MaterialInstanceConstant') {
      const p = nodeProps(g.pkg, e), values = (p.TextureParameterValues ?? []).filter(v => typeof v.ParameterValue === 'number');
      add(g, values.filter(v => !NOT_COLOUR.test(v.ParameterName) && COLOUR.test(v.ParameterName)).map(v => v.ParameterValue), false);
      add(g, values.filter(v => GREY_ONLY.test(v.ParameterName)).map(v => v.ParameterValue), false);
      color ??= (p.VectorParameterValues ?? []).find(v => TINT.test(v.ParameterName) && Array.isArray(v.ParameterValue))?.ParameterValue.slice(0, 3) ?? null;
      at = typeof p.Parent === 'number' && p.Parent ? await follow(open, g, p.Parent, index) : null;
    } else {
      if (cls === 'Material') add(g, texturesUsed(g.pkg, e), true);
      break;
    }
  }
  const image = await firstImage(open, cache, colour, index) ?? greyed(await firstImage(open, cache, grey, index));
  return image || color ? { texture: image ?? null, color } : null;
}

async function firstImage(open, cache, candidates, index) {
  for (const { g, ref } of candidates) {
    const found = await follow(open, g, ref, index);
    if (!found) continue;
    await found.g.load(found.i);
    const image = await gameTexture(found.g.pkg, found.i, { cache }).catch(() => null);
    if (image) return image;
  }
  return null;
}
function greyed(image) {                          // a mask's channels as one middling grey: the pattern, not its levels
  if (!image) return null;
  const px = image.rgba;
  for (let k = 0; k < px.length; k += 4) { px[k] = px[k + 1] = px[k + 2] = 64 + (px[k] + px[k + 1] + px[k + 2]) / 6; px[k + 3] = 255; }
  return image;
}

const textureName = (pkg, r) => r > 0 ? (r <= pkg.exports.length && pkg.classOf(pkg.exports[r - 1]) === 'Texture2D' ? pkg.exports[r - 1].name : null)
  : r < 0 && pkg.imports[-r - 1]?.cls === 'Texture2D' ? pkg.imports[-r - 1].name : null;
function texturesUsed(pkg, e) {                   // cooked materials keep no node graph: the texture references in their data
  const out = [];
  for (let q = e.off; q + 4 <= e.off + e.size; q++) {
    const r = unpackFrom('<i', pkg.data, q)[0];
    if (r !== 0 && textureName(pkg, r) && !out.includes(r)) out.push(r);
  }
  return out;
}
async function follow(open, g, ref, index) {      // {g, i} of an object a package refers to, in it or another package
  if (ref > 0) return { g, i: ref - 1 };
  const path = [];
  for (let r = ref; r < 0; r = g.pkg.imports[-r - 1].outer) path.unshift(g.pkg.imports[-r - 1].name);
  return find(open, path, index);
}
async function find(open, path, index) {         // the export at `path` (package first) in the game's packages
  const look = (g, want) => {
    const i = g.pkg.exports.findIndex((e, k) => e.name.toLowerCase() === path.at(-1).toLowerCase() && pathOf(g.pkg, k) === want);
    return i < 0 ? null : { g, i };
  };
  const g = await open(path[0]).catch(() => null), full = path.join('.').toLowerCase();
  const direct = g && look(g, path.slice(1).join('.').toLowerCase());
  if (direct || !index?.has(full)) return direct;
  const other = await open(index.get(full)).catch(() => null);
  return other && look(other, full);
}
