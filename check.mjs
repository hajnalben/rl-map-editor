// node check.mjs [--update] [map.udk ...]: the terrain collision-tree self-check, a picture made into a surface of the
// blank map (texture.js, surfaces.upk) read back, the editor's own change sets (fixtures/, recorded from the editor)
// built, then every mesh of each map written back byte for byte, its textures decoded, and an edited copy (terrain,
// both checkpoint and lava types) built and re-read. Every map built is hashed against check.golden.json, so a change
// that alters what gets saved shows; --update takes the new hashes.
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename } from 'path';
import { packInto } from './bytes.js';
import { build, describe } from './map.js';
import { read, selfcheck, write } from './mesh.js';
import { Package } from './ue3.js';
import { surfaceLook, textureImage } from './looks.js';
import { blankMap } from './blank.js';
import { BUILT_IN, asMeshInput } from './shapes.js';

// GUIDs from a seeded generator: then a build is the same bytes every time
let seed = 0;
crypto.getRandomValues = array => {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let k = 0; k < bytes.length; k++) {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    bytes[k] = (t ^ t >>> 14) >>> 24;
  }
  return array;
};
const seeded = fn => { seed = 1; return fn(); };

const GOLDEN = new URL('check.golden.json', import.meta.url), update = process.argv.includes('--update');
let golden = {};
try { golden = JSON.parse(readFileSync(GOLDEN, 'utf8')); } catch { /* none yet */ }
const differ = [];
function hashed(name, bytes) {
  const h = createHash('sha256').update(bytes).digest('hex');
  if (golden[name] && golden[name] !== h && !update) differ.push(name);
  else golden[name] = h;
  return bytes;
}

selfcheck();
console.log('terrain tile: kDOP tree decodes around every triangle');
const donor = new Package(new Uint8Array(readFileSync(new URL('surfaces.upk', import.meta.url))));
const blank = seeded(blankMap);
{
  const W = 64, rgba = new Uint8Array(4 * W * W), floorOf = p => describe(p).actors.find(a => a.mesh === 'Floor');
  for (let k = 0; k < W * W; k++) rgba.set([4 * (k % W), 4 * Math.floor(k / W), ((k % W >> 3) + (k / W >> 3)) & 1 ? 230 : 30, 255], 4 * k);
  const out = new Package(hashed('blank: picture floor', seeded(() => build(blank, { surfaces: [{ i: floorOf(new Package(blank)).i, material: 'image:1' }], images: { 'image:1': { name: 'Check', width: W, height: W, rgba } } }, donor))));
  const back = textureImage(out, surfaceLook(out, floorOf(out).materials[0]).texture, W);
  const off = rgba.reduce((n, v, k) => n + (k % 4 === 3 ? 0 : Math.abs(v - back.rgba[k])), 0) / (3 * W * W);
  if (!(off < 4)) throw new Error(`a picture surface reads back ${off.toFixed(1)} off per colour`);
  console.log(`picture surface: reads back ${off.toFixed(1)} off per colour`);
}
// fixtures/<name>.json: {source: 'blank' or another fixture's name, changes: what the editor handed build()}
const built = { blank };
function fixture(name) {
  if (built[name]) return built[name];
  const { source, changes } = JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));
  for (const img of Object.values(changes.images ?? {})) img.rgba = Uint8Array.from(Object.values(img.rgba));
  changes.shapeGeometry = Object.fromEntries((changes.shapes ?? []).map(s => [s.key, asMeshInput(BUILT_IN[s.key.slice(4)]())]));
  const on = fixture(source);
  built[name] = hashed(`fixture: ${name}`, seeded(() => build(on, changes, donor)));
  console.log(`fixture ${name}: built on ${source} and verified`);
  return built[name];
}
for (const file of readdirSync(new URL('fixtures/', import.meta.url)).filter(f => f.endsWith('.json'))) fixture(file.slice(0, -5));
for (const path of process.argv.slice(2).filter(a => a !== '--update')) {
  const source = new Uint8Array(readFileSync(path)), pkg = new Package(source);
  let meshes = 0;
  pkg.exports.forEach((e, i) => {
    if (pkg.classOf(e) !== 'StaticMesh') return;
    const [blob, rawAt] = write(read(pkg, i));
    packInto('<i', blob, rawAt + 12, e.off + rawAt + 16);
    const orig = pkg.objectBytes(i);
    if (blob.length !== orig.length || blob.some((b, k) => b !== orig[k])) throw new Error(`${path}: ${e.name} does not write back`);
    meshes += 1;
  });
  const textures = pkg.exports.map((e, i) => pkg.classOf(e) === 'Texture2D' ? textureImage(pkg, i, 64) : undefined).filter(t => t !== undefined);
  const info = describe(pkg), apron = [];
  for (let j = -1; j <= 33; j++) for (let i = -1; i <= 33; i++) apron.push(Math.max(0, 500 - 30 * Math.hypot(i - 16, j - 16)));
  const edits = {
    terrain: info.materials.length ? { base: 0, material: info.materials[0].ref, tiles: [{ tx: 9, ty: 9, heights: apron }] } : null,
    checkpoints: info.zone ? [{ loc: [0, 0, 300], rot: [0, 0, 0], scale3d: [1, 1, 1] }, { loc: [0, 2000, 300], rot: [0, 16384, 0], scale3d: [1, 1, 1], ball: true },
                               { loc: [0, 0, 0], rot: [0, 0, 0], scale3d: [20, 20, 0.1], lava: true, ball: true },
                               { loc: [0, 0, 0], rot: [0, 0, 0], scale3d: [20, 20, 0.1], lava: true },
                               { loc: [0, 0, -50], rot: [0, 0, 0], scale3d: [20, 20, 0.1], lava: true, car: true, ball: true }] : [],
  };
  hashed(`${basename(path)}: edits`, seeded(() => build(source, edits)));   // throws when the saved copy does not read back as intended
  console.log(`${path}: ${meshes} meshes written back byte for byte; ${textures.filter(Boolean).length} of ${textures.length} textures decode; edited copy built and verified`);
}
writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n');
if (differ.length) throw new Error(`saved bytes changed (node check.mjs --update takes them): ${differ.join(', ')}`);
