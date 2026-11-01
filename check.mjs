// node check.mjs [map.udk ...]: the terrain collision-tree self-check, then every mesh of each map written back
// byte for byte and an edited copy (terrain, both checkpoint and lava types) built and re-read.
import { readFileSync } from 'fs';
import { packInto } from './bytes.js';
import { build, describe } from './map.js';
import { read, selfcheck, write } from './mesh.js';
import { Package } from './ue3.js';

selfcheck();
console.log('terrain tile: kDOP tree decodes around every triangle');
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
  const info = describe(pkg), apron = [];
  for (let j = -1; j <= 33; j++) for (let i = -1; i <= 33; i++) apron.push(Math.max(0, 500 - 30 * Math.hypot(i - 16, j - 16)));
  const edits = {
    terrain: info.materials.length ? { base: 0, material: info.materials[0].ref, tiles: [{ tx: 9, ty: 9, heights: apron }] } : null,
    checkpoints: info.zone ? [{ loc: [0, 0, 300], rot: [0, 0, 0], scale3d: [1, 1, 1] }, { loc: [0, 2000, 300], rot: [0, 16384, 0], scale3d: [1, 1, 1], ball: true },
                               { loc: [0, 0, 0], rot: [0, 0, 0], scale3d: [20, 20, 0.1], lava: true, ball: true },
                               { loc: [0, 0, 0], rot: [0, 0, 0], scale3d: [20, 20, 0.1], lava: true }] : [],
  };
  build(source, edits);                           // throws when the saved copy does not read back as intended
  console.log(`${path}: ${meshes} meshes written back byte for byte; edited copy built and verified`);
}
