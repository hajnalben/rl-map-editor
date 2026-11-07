// Builds surfaces.upk: surfaces the editor offers in every map besides the map's own (index.html EXTRA_SURFACES),
// copied into a map from here when used. Lethamyr's lava floor from LethDribbleRM (its textures are Textures.com's)
// and the lake water of the game's Deadeye Canyon (Outlaw_P) that his Medieval Rings uses (a game material, so only
// its name is copied). Also Image_Surface, what a picture of yours becomes (map.js imageSurface): the lava floor's
// material without its glow or its rock bumps, showing Image_Placeholder, which the editor swaps for the picture's
// texture; and Editor_Grass, the same with a plain grass texture made here, a new map's ground.
//   node surfaces.mjs <folder with LethDribbleRM.udk and LethMedievalRings.upk>
import { readFileSync, writeFileSync } from 'fs';
import { Additions, Package } from './ue3.js';
import { blankMap } from './blank.js';
import { nodeProps } from './kismet.js';
import { addTexture } from './texture.js';
import { packInto, unpackFrom } from './bytes.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node surfaces.mjs <workshop maps folder>');
const open = name => new Package(new Uint8Array(readFileSync(`${dir}/${name}`)));
const add = new Additions(new Package(blankMap()));
const dribble = open('LethDribbleRM.udk'), medieval = open('LethMedievalRings.upk');
const lava = dribble.exports.findIndex(e => e.name === 'Text_LavaFloor') + 1;
add.copyFrom(dribble, lava);
add.copyFrom(medieval, -(medieval.imports.findIndex(im => im.name === 'Lake_01_Mat') + 1));

const props = nodeProps(dribble, dribble.exports[lava - 1]);
const textures = Object.fromEntries(props.TextureParameterValues.map(v => [v.ParameterName, v.ParameterValue]));
const [, , , from, size] = [...dribble.properties(dribble.exports[lava - 1])].find(([name]) => name === 'ScalarParameterValues');
const nameAt = (k, q) => unpackFrom('<ii', dribble.data, q).join() === `${dribble.names.indexOf(k)},0`;
let q = from;
while (q < from + size && !nameAt('EmissiveMultiply', q)) q++;
while (q < from + size && !nameAt('ParameterValue', q)) q++;
if (q >= from + size) throw new Error("the lava floor's EmissiveMultiply was not found");
packInto('<f', dribble.data, q + 24, 0);         // no glow (after the lava floor itself was copied)
const engineMaterials = add.copyFrom(dribble, dribble.imports[-props.MobileBaseTexture - 1].outer);
const flat = add.findImport('DefaultNormal', 'Texture2D', engineMaterials) ?? add.addImport('Engine', 'Texture2D', engineMaterials, 'DefaultNormal');
const placeholder = addTexture(add, 'Image_Placeholder', { width: 4, height: 4, rgba: new Uint8Array(64).fill(128) });
add.copyFrom(dribble, lava, new Map([[textures.Diffuse, placeholder], [textures.Normal, flat]]), 'Image_Surface');
const grassTexture = addTexture(add, 'Editor_Grass_Texture', { width: 512, height: 512, rgba: grass(512) });
add.copyFrom(dribble, lava, new Map([[textures.Diffuse, grassTexture], [textures.Normal, flat]]), 'Editor_Grass');
const out = add.save();
writeFileSync(new URL('surfaces.upk', import.meta.url), out);
console.log(`surfaces.upk: ${(out.length / 1e6).toFixed(1)} MB`);

// W x W RGBA of plain grass, seamless: greens from value noise at a few scales, specks for blades, a few dry patches
function grass(W, seed = 7) {
  let s = seed;
  const random = () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const layer = cells => {                        // value noise repeating every W pixels, `cells` lattice cells across
    const v = Float32Array.from({ length: cells * cells }, random), at = (i, j) => v[(j % cells) * cells + i % cells];
    const ease = t => t * t * (3 - 2 * t);
    return (x, y) => {
      const fx = x * cells / W, fy = y * cells / W, i = Math.floor(fx), j = Math.floor(fy), u = ease(fx - i), w = ease(fy - j);
      return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - w) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * w;
    };
  };
  const patches = layer(4), mid = layer(12), fine = layer(128), finer = layer(256), dry = layer(6);
  const rgba = new Uint8Array(4 * W * W), dark = [44, 82, 30], light = [92, 138, 50], straw = [128, 136, 66];
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const t = Math.min(1, Math.max(0, 0.15 + 0.25 * patches(x, y) + 0.45 * mid(x, y)));
    const d = Math.max(0, dry(x, y) - 0.7) * 1.2, blade = 0.78 + 0.32 * fine(x, y) + 0.22 * finer(x, y);
    const c = [0, 1, 2].map(k => ((dark[k] + (light[k] - dark[k]) * t) * (1 - d) + straw[k] * d) * blade);
    rgba.set([...c.map(v => Math.max(0, Math.min(255, Math.round(v)))), 255], 4 * (y * W + x));
  }
  return rgba;
}
