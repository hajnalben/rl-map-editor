// Rocket League's own packages (TAGame/CookedPCConsole), read-only, for the textures maps borrow from them. The game
// encrypts a package's header region (names, imports, exports and the chunk table) with AES-256-ECB and stores the
// objects in zlib-compressed chunks; this returns the package as UDK would have saved it, uncompressed, which
// ue3.js's Package then reads (as RLUPKTool, github.com/Martinii89/RLUPKT, does).
import { packInto, unpackFrom } from './bytes.js';
import { decodeTexture } from './looks.js';
import { nodeProps } from './kismet.js';

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

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The package in `bytes` (a game .upk) decrypted and uncompressed; its summary says uncompressed, as Package expects.
export async function gamePackage(bytes) {
  let p = 0;
  const i32 = () => { const v = unpackFrom('<i', bytes, p)[0]; p += 4; return v; };
  const skipString = () => { const n = i32(); p += n < 0 ? -2 * n : n; };
  const [tag, , licensee] = unpackFrom('<IHH', bytes, 0);
  if (tag !== 0x9E2A83C1) throw new Error('not an Unreal package');
  p = 8;
  const headerSize = i32();
  skipString();
  p += 4;                                         // package flags
  const nameOffset = (p += 4, i32());
  p += 4 * 9 + 16;                                // export/import counts and offsets, depends, 4 more; guid
  const generations = i32();
  p += 12 * generations + 8;                      // engine and cooker versions
  const compressionAt = p, compression = i32(), chunkCountAt = p, chunkCount = i32();
  if (!compression) return bytes;                 // a package UDK saved
  if (!(compression & 1)) throw new Error(`compression ${compression} is not zlib`);
  const wide = licensee >= 22;                    // chunk offsets are 64-bit
  p += chunkCount * (wide ? 24 : 16) + 4;
  const strings = i32();
  for (let k = 0; k < strings; k++) skipString();
  const allocations = i32();
  for (let k = 0; k < allocations; k++) { p += 20; const n = i32(); p += 4 * n; }
  const garbage = i32(), chunkInfoAt = i32();
  const encrypted = (headerSize - garbage - nameOffset + 15) & ~15;
  const header = await ecbDecrypt(bytes.subarray(nameOffset, nameOffset + encrypted));

  // the chunk table ends the header; today's game adds 12 bytes to RLUPKTool's 24 per entry, so measure the stride
  const count = unpackFrom('<i', header, chunkInfoAt)[0], chunks = [];
  const stride = Math.floor((header.length - chunkInfoAt - 4) / count / 4) * 4;
  if (stride < (wide ? 24 : 16)) throw new Error('chunk table too short: wrong key?');
  for (let k = 0, q = chunkInfoAt + 4; k < count; k++, q += stride) {
    const [uOff, uSize, cOff, cSize] = wide ? unpackFrom('<qiqi', header, q).map(Number) : unpackFrom('<iiii', header, q);
    chunks.push({ uOff, uSize, cOff, cSize });
  }
  const size = Math.max(nameOffset + header.length, ...chunks.map(c => c.uOff + c.uSize));
  const out = new Uint8Array(size);
  out.set(bytes.subarray(0, Math.min(bytes.length, size)));
  out.set(header, nameOffset);
  for (const c of chunks) {                        // a chunk: tag, block size, total sizes, then per block sizes, then the blocks
    let r = c.cOff + 8;
    const [, total] = unpackFrom('<ii', bytes, r);
    r += 8;
    const blocks = [];
    for (let got = 0; got < total;) { const [cs, us] = unpackFrom('<ii', bytes, r); blocks.push(cs); got += us; r += 8; }
    let w = c.uOff;
    for (const cs of blocks) {
      const data = await inflate(bytes.subarray(r, r + cs));
      out.set(data, w);
      w += data.length;
      r += cs;
    }
  }
  packInto('<ii', out, compressionAt, 0, 0);       // uncompressed now, no chunks
  if (chunkCountAt !== compressionAt + 4) throw new Error('summary layout');
  return out;
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

async function unchunk(bytes) {                   // one compressed chunk: tag, block size, totals, block sizes, blocks
  const [, , , total] = unpackFrom('<iiii', bytes, 0), sizes = [];
  let r = 16;
  for (let got = 0; got < total; r += 8) { const [cs, us] = unpackFrom('<ii', bytes, r); sizes.push(cs); got += us; }
  const parts = [];
  for (const cs of sizes) { parts.push(await inflate(bytes.subarray(r, r + cs))); r += cs; }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  parts.reduce((at, x) => (out.set(x, at), at + x.length), 0);
  return out;
}

// What a game material looks like: {texture: {width, height, rgba} or null, color: linear [r, g, b] or null}, null
// when nothing is known. The game's shaders mix textures in ways a preview can't, so this takes one colour texture
// (a parameter or, for a plain Material, a texture it uses, named like one: not a normal map, mask, packed channels
// or reflection) and a tint (a Color-like vector parameter), following material instances to their parents.
// `path` is the material's import path, its package first; `open(name)` gives a game package's Package or null;
// `cache` reads texture file caches (gameTexture).
const NOT_COLOUR = /normal|_n$|_n_|mask|pack|rgb|cube|env|spec|rough|metal|noise|_m$|_s$|lowquality|cheap/i;
const COLOUR = /diffuse|albedo|base_?colou?r|^colou?r|texture$|emissive|_d$|_t$|_diff|_col/i;
const TINT = /^(layer1_)?(diffuse_?|base_?)?colou?r$|^tint$/i;
export async function gameLook(open, cache, path) {
  let at = await find(open, path), texture = null, color = null;
  for (let hops = 0; at && hops < 8; hops++) {
    const { pkg, i } = at, e = pkg.exports[i], cls = pkg.classOf(e);
    if (cls === 'MaterialInstanceConstant') {
      const p = nodeProps(pkg, e);
      const params = (p.TextureParameterValues ?? []).filter(v => typeof v.ParameterValue === 'number' && !NOT_COLOUR.test(v.ParameterName) && COLOUR.test(v.ParameterName));
      texture ??= colourTexture(pkg, params.map(v => v.ParameterValue), false);
      color ??= (p.VectorParameterValues ?? []).find(v => TINT.test(v.ParameterName) && Array.isArray(v.ParameterValue))?.ParameterValue.slice(0, 3) ?? null;
      at = typeof p.Parent === 'number' && p.Parent ? await follow(open, pkg, p.Parent) : null;
    } else {
      if (cls === 'Material') texture ??= colourTexture(pkg, texturesUsed(pkg, e), true);
      break;
    }
  }
  const found = texture && await follow(open, texture.pkg, texture.ref);
  const image = found && await gameTexture(found.pkg, found.i, { cache }).catch(() => null);
  return image || color ? { texture: image ?? null, color } : null;
}

const textureName = (pkg, r) => r > 0 ? (r <= pkg.exports.length && pkg.classOf(pkg.exports[r - 1]) === 'Texture2D' ? pkg.exports[r - 1].name : null)
  : r < 0 && pkg.imports[-r - 1]?.cls === 'Texture2D' ? pkg.imports[-r - 1].name : null;
function colourTexture(pkg, refs, byName) {      // the first of `refs` that is a colour texture: {pkg, ref} or null
  const ok = refs.filter(r => { const n = textureName(pkg, r); return n && !NOT_COLOUR.test(n); });
  const ref = (byName ? ok.find(r => COLOUR.test(textureName(pkg, r))) : undefined) ?? ok[0];
  return ref ? { pkg, ref } : null;
}
function texturesUsed(pkg, e) {                   // cooked materials keep no node graph: the texture references in their data
  const out = [];
  for (let q = e.off; q + 4 <= e.off + e.size; q++) {
    const r = unpackFrom('<i', pkg.data, q)[0];
    if (r !== 0 && textureName(pkg, r) && !out.includes(r)) out.push(r);
  }
  return out;
}
async function follow(open, pkg, ref) {           // {pkg, i} of an object a package refers to, in it or another package
  if (ref > 0) return { pkg, i: ref - 1 };
  const path = [];
  for (let r = ref; r < 0; r = pkg.imports[-r - 1].outer) path.unshift(pkg.imports[-r - 1].name);
  return find(open, path);
}
async function find(open, path) {                // the export at `path` (package first) in the game's packages
  const pkg = await open(path[0]);
  if (!pkg) return null;
  const want = path.slice(1).map(n => n.toLowerCase()).join('.');
  const chain = i => { const names = []; for (let r = i + 1; r > 0; r = pkg.exports[r - 1].outer) names.unshift(pkg.exports[r - 1].name); return names.join('.').toLowerCase(); };
  const i = pkg.exports.findIndex((e, k) => e.name.toLowerCase() === path.at(-1).toLowerCase() && chain(k) === want);
  return i < 0 ? null : { pkg, i };
}
