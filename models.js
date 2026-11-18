// 3D models from other programs as shapes: glTF/GLB, OBJ and STL, read with three.js's loaders and made one mesh in
// Unreal axes (shapes.js geometry) standing on the middle of its base, with its base colour texture when it has one.
// glTF is in metres (100 map units each); OBJ and STL say nothing, so a model under 20 across is taken as metres too.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const MODEL_FILES = /\.(glb|gltf|obj|stl)$/i;
const MAX_VERTICES = 65535;                       // a mesh's indices are 16-bit
const unit = v => { const n = Math.hypot(...v) || 1; return v.map(c => c / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// `files`: the model and what it refers to (a .gltf's .bin and textures, an OBJ's texture). {name, geometry, image, notes}
export async function readModel(files) {
  const main = files.find(f => MODEL_FILES.test(f.name)), ext = main.name.split('.').pop().toLowerCase();
  const urls = new Map(files.map(f => [f.name.toLowerCase(), URL.createObjectURL(f)])), notes = [];
  let root, flipV = true, metres = ext === 'glb' || ext === 'gltf';
  try {
    if (metres) {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const manager = new THREE.LoadingManager();
      manager.setURLModifier(url => urls.get(decodeURIComponent(url.split(/[\\/]/).pop()).toLowerCase()) ?? url);
      root = (await new GLTFLoader(manager).parseAsync(ext === 'glb' ? await main.arrayBuffer() : await main.text(), '')).scene;
      flipV = false;                              // glTF's v runs down the texture, as the game's does
    } else if (ext === 'obj') {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      root = new OBJLoader().parse(await main.text());
    } else {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      root = new THREE.Mesh(new STLLoader().parse(await main.arrayBuffer()));
    }
  } finally {
    setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 60000);
  }
  root.updateMatrixWorld(true);
  const parts = [];
  let picture = null;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld), n = g.attributes.position.count;
    for (const name of Object.keys(g.attributes)) if (!['position', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(2 * n), 2));
    parts.push(g.index ? g.toNonIndexed() : g);
    picture ??= [o.material].flat().find(m => m?.map?.image)?.map.image ?? null;
  });
  if (!parts.length) throw new Error(`${main.name} has no meshes`);
  const image = files.find(f => /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!picture && image && ext !== 'gltf') picture = await createImageBitmap(image);
  const g = mergeVertices(mergeGeometries(parts), 1e-4), pos = g.attributes.position, uv = g.attributes.uv;
  if (pos.count > MAX_VERTICES) throw new Error(`${main.name} has ${pos.count} corners; a game mesh takes at most ${MAX_VERTICES}: simplify it first`);
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3()), longest = Math.max(size.x, size.y, size.z);
  if (!metres && longest < 20) metres = true;
  const k = metres ? 100 : 1, c = g.boundingBox.getCenter(new THREE.Vector3()), floor = g.boundingBox.min.y;
  if (metres && ext !== 'glb' && ext !== 'gltf') notes.push('taken as metres');
  const positions = new Float32Array(3 * pos.count), uvs = new Float32Array(2 * pos.count);
  for (let v = 0; v < pos.count; v++) {           // Y up to Z up: the swap keeps three's front faces Unreal's
    positions.set([(pos.getX(v) - c.x) * k, (pos.getZ(v) - c.z) * k, (pos.getY(v) - floor) * k], 3 * v);
    uvs.set([uv.getX(v), flipV ? 1 - uv.getY(v) : uv.getY(v)], 2 * v);
  }
  const tris = Uint32Array.from(g.index.array), normals = new Float32Array(3 * pos.count), tangents = new Float32Array(6 * pos.count);
  for (let t = 0; t < tris.length; t += 3) {      // area-weighted face normals, outward (Unreal's winding points in)
    const [a, b, d] = [0, 1, 2].map(j => positions.subarray(3 * tris[t + j], 3 * tris[t + j] + 3));
    const nrm = cross([d[0] - a[0], d[1] - a[1], d[2] - a[2]], [b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    for (let j = 0; j < 3; j++) for (let q = 0; q < 3; q++) normals[3 * tris[t + j] + q] += nrm[q];
  }
  for (let v = 0; v < pos.count; v++) {
    const nrm = unit([...normals.subarray(3 * v, 3 * v + 3)]), tx = unit(Math.abs(nrm[2]) < 0.9 ? cross([0, 0, 1], nrm) : cross(nrm, [0, 1, 0]));
    normals.set(nrm, 3 * v);
    tangents.set([...tx, ...cross(nrm, tx)], 6 * v);
  }
  return { name: main.name.replace(/\.[^.]*$/, ''), geometry: { positions, uvs, normals, tangents, tris }, image: picture, notes };
}
