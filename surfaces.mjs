// Builds surfaces.upk: surfaces the editor offers in every map besides the map's own (index.html EXTRA_SURFACES),
// copied into a map from here when used, all made here from nothing but code: Editor_Lava, glowing lava; Editor_Grass,
// plain grass, a new map's ground; and Image_Surface, what a picture of yours becomes (map.js imageSurface), showing
// Image_Placeholder, which the editor swaps for the picture's texture. Each is an instance of the engine's
// VertexPaint_2Tex_Color material, laid out as UDK saves one. Also the lake water of the game's Deadeye Canyon
// (Outlaw_P), a game material, so only its name.
//   node surfaces.mjs
import { writeFileSync } from 'fs';
import { Additions, Package } from './ue3.js';
import { blankMap } from './blank.js';
import { addTexture } from './texture.js';
import { concat, pack } from './bytes.js';

// what VertexPaint_2Tex_Color gives an instance of it (read from one UDK saved): its parameters' expression guids,
// its lighting guid and the guids of the textures it references itself
const PARENT = {
  EmissiveMultiply: '900b47ff6d7fe642bbcd285e875f3f47', SpecPower: '0b94e1e317eece48902b63cd05eb49b1',
  Diffuse: '7699e45859107c499606f5fb86ca944a', Emissive: '6666db835b6c334fb40ac6eb45b04a2f', Normal: 'c456395c5888354c914e03afda279c6c',
  lighting: 'a85b5d90c5d13648841112fa8730fb76', textures: ['182e7a3c7c4c8a44be919e58bae4a8de', '5e82addc85bdd8408c92d55061847bb0'],
};

const add = new Additions(new Package(blankMap()));
const importOf = (path, cls) => path.split('.').reduce((outer, name, k, all) => {   // an engine object by its path
  const c = k === all.length - 1 ? cls : 'Package';
  return add.findImport(name, c, outer) ?? add.addImport(c === 'Package' ? 'Core' : 'Engine', c, outer, name);
}, 0);
const parent = importOf('enginedebugmaterials.VertexPaint_2Tex_Color', 'Material');
const flat = importOf('EngineMaterials.DefaultNormal', 'Texture2D'), mobile = importOf('EngineMaterials.DefaultDiffuse', 'Texture2D');

// a surface showing `texture` (a reference), glowing with it `glow` times over; no specular shine
function surface(name, texture, glow) {
  const guid = hex => Uint8Array.from(hex.match(/../g), b => parseInt(b, 16));
  const list = (prop, items) => add.tag(prop, 'ArrayProperty', concat(pack('<i', items.length), ...items));
  const param = (p, type, value) => concat(add.tag('ParameterName', 'NameProperty', add.fname(p)), add.tag('ParameterValue', type, value),
    add.tag('ExpressionGUID', 'StructProperty', guid(PARENT[p]), 'Guid'), add.fname('None'));
  const blob = concat(pack('<i', 0),
    list('ScalarParameterValues', [param('EmissiveMultiply', 'FloatProperty', pack('<f', glow)), param('SpecPower', 'FloatProperty', pack('<f', 1e18))]),
    list('TextureParameterValues', [['Diffuse', texture], ['Emissive', texture], ['Normal', flat]].map(([p, t]) => param(p, 'ObjectProperty', pack('<i', t)))),
    add.tag('Parent', 'ObjectProperty', pack('<i', parent)),
    list('ReferencedTextureGuids', PARENT.textures.map(guid)),
    add.tag('ParentLightingGuid', 'StructProperty', guid(PARENT.lighting), 'Guid'),
    add.tag('LightingGuid', 'StructProperty', crypto.getRandomValues(new Uint8Array(16)), 'Guid'),
    add.tag('MobileBaseTexture', 'ObjectProperty', pack('<i', mobile)),
    add.fname('None'));
  return add.addObject(add.classRef('MaterialInstanceConstant', 'Engine'), 0, name, blob, 0x000F000500000000n) + 1;
}

surface('Editor_Lava', addTexture(add, 'Editor_Lava_Texture', { width: 512, height: 512, rgba: lava(512) }), 4);
importOf('Outlaw_P.fx_water.Mat.Lake_01_Mat', 'Material');
surface('Image_Surface', addTexture(add, 'Image_Placeholder', { width: 4, height: 4, rgba: new Uint8Array(64).fill(128) }), 0);
surface('Editor_Grass', addTexture(add, 'Editor_Grass_Texture', { width: 512, height: 512, rgba: grass(512) }), 0);
const out = add.save();
writeFileSync(new URL('surfaces.upk', import.meta.url), out);
console.log(`surfaces.upk: ${(out.length / 1e6).toFixed(1)} MB`);

// seeded random numbers in [0, 1), and value noise repeating every W pixels, `cells` lattice cells across
function noise(W, seed) {
  let s = seed;
  const random = () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const layer = cells => {
    const v = Float32Array.from({ length: cells * cells }, random), at = (i, j) => v[(j % cells) * cells + i % cells];
    const ease = t => t * t * (3 - 2 * t);
    return (x, y) => {
      const fx = x * cells / W, fy = y * cells / W, i = Math.floor(fx), j = Math.floor(fy), u = ease(fx - i), w = ease(fy - j);
      return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - w) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * w;
    };
  };
  return { random, layer };
}
function byte(v) { return Math.max(0, Math.min(255, Math.round(v))); }

// W x W RGBA of plain grass, seamless: greens from value noise at a few scales, specks for blades, a few dry patches
function grass(W, seed = 7) {
  const { layer } = noise(W, seed);
  const patches = layer(4), mid = layer(12), fine = layer(128), finer = layer(256), dry = layer(6);
  const rgba = new Uint8Array(4 * W * W), dark = [44, 82, 30], light = [92, 138, 50], straw = [128, 136, 66];
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const t = Math.min(1, Math.max(0, 0.15 + 0.25 * patches(x, y) + 0.45 * mid(x, y)));
    const d = Math.max(0, dry(x, y) - 0.7) * 1.2, blade = 0.78 + 0.32 * fine(x, y) + 0.22 * finer(x, y);
    const c = [0, 1, 2].map(k => ((dark[k] + (light[k] - dark[k]) * t) * (1 - d) + straw[k] * d) * blade);
    rgba.set([...c.map(byte), 255], 4 * (y * W + x));
  }
  return rgba;
}

// W x W RGBA of lava, seamless: plates of dark crust (cells around random points, wrapping at the edges) split by
// cracks of molten rock, the crust warmed beside them. Nearly black but for the cracks, as it glows with itself.
function lava(W, seed = 11) {
  const { random, layer } = noise(W, seed);
  const wrap = d => d - W * Math.round(d / W), points = [];
  while (points.length < 22) {                    // apart enough that no plate is a sliver
    const p = [random() * W, random() * W, 0.12 * random() ** 3];   // the last: how warm the plate is
    if (points.every(([qx, qy]) => Math.hypot(wrap(p[0] - qx), wrap(p[1] - qy)) > W / 9)) points.push(p);
  }
  const warpX = layer(5), warpY = layer(5), width = layer(6), reach = layer(4), grain = layer(48), grit = layer(160);
  const ramp = [[0, [12, 5, 3]], [0.3, [80, 12, 2]], [0.6, [205, 50, 5]], [0.85, [250, 135, 18]], [1, [255, 215, 95]]];
  const heat = t => {
    const k = ramp.findIndex(([at]) => at >= t), [a, ca] = ramp[Math.max(0, k - 1)], [b, cb] = ramp[k];
    return ca.map((v, c) => v + (cb[c] - v) * (b > a ? (t - a) / (b - a) : 0));
  };
  const rgba = new Uint8Array(4 * W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const px = x + 40 * (warpX(x, y) - 0.5), py = y + 40 * (warpY(x, y) - 0.5);
    let d1 = Infinity, d2 = Infinity, warm = 0;
    for (const [qx, qy, w] of points) {
      const d = Math.hypot(wrap(px - qx), wrap(py - qy));
      if (d < d1) [d1, d2, warm] = [d, d1, w];
      else if (d < d2) d2 = d;
    }
    const edge = (d2 - d1) / 2;                   // how far the crack between the two nearest plates is
    const molten = Math.max(0, 1 - edge / (1 + 9 * width(x, y) ** 2));
    const t = Math.max(molten, 0.55 * Math.exp(-edge / (4 + 14 * reach(x, y))) + warm);
    const crust = 0.4 + 0.7 * grain(x, y) + 0.5 * grit(x, y), c = heat(t);
    rgba.set([...c.map((v, k) => byte(t < 0.15 ? v * crust : v)), 255], 4 * (y * W + x));
  }
  return rgba;
}
