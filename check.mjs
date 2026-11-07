// node check.mjs [map.udk ...]: the terrain collision-tree self-check, then every mesh of each map written back
// byte for byte, its textures decoded, and an edited copy (terrain, both checkpoint and lava types) built and re-read.
// Also a picture made into a surface of the blank map (texture.js, surfaces.upk) reads back as it went in.
import { readFileSync } from 'fs';
import { packInto } from './bytes.js';
import { build, describe } from './map.js';
import { read, selfcheck, write } from './mesh.js';
import { Package } from './ue3.js';
import { surfaceLook, textureImage } from './looks.js';
import { blankMap } from './blank.js';

selfcheck();
console.log('terrain tile: kDOP tree decodes around every triangle');
{
  const W = 64, rgba = new Uint8Array(4 * W * W), floorOf = p => describe(p).actors.find(a => a.mesh === 'Floor');
  for (let k = 0; k < W * W; k++) rgba.set([4 * (k % W), 4 * Math.floor(k / W), ((k % W >> 3) + (k / W >> 3)) & 1 ? 230 : 30, 255], 4 * k);
  const src = blankMap(), donor = new Package(new Uint8Array(readFileSync(new URL('surfaces.upk', import.meta.url))));
  const out = new Package(build(src, { surfaces: [{ i: floorOf(new Package(src)).i, material: 'image:1' }], images: { 'image:1': { name: 'Check', width: W, height: W, rgba } } }, donor));
  const back = textureImage(out, surfaceLook(out, floorOf(out).materials[0]).texture, W);
  const off = rgba.reduce((n, v, k) => n + (k % 4 === 3 ? 0 : Math.abs(v - back.rgba[k])), 0) / (3 * W * W);
  if (!(off < 4)) throw new Error(`a picture surface reads back ${off.toFixed(1)} off per colour`);
  console.log(`picture surface: reads back ${off.toFixed(1)} off per colour`);
}
for (const path of process.argv.slice(2)) {
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
  build(source, edits);                           // throws when the saved copy does not read back as intended
  console.log(`${path}: ${meshes} meshes written back byte for byte; ${textures.filter(Boolean).length} of ${textures.length} textures decode; edited copy built and verified`);
}
