// A blank Rocket League map written from scratch, for new maps with no workshop map to start from: the level and
// its world, the spawn and game setup, sun lights, a floor, a sky dome, a trigger zone to copy for checkpoints and
// a few surfaces. Every object is written here (layouts as UDK 2015 saves them, package version 868); nothing is
// copied from another map. Game materials and classes are only referenced by name.
import { concat, latin1Bytes, pack, packInto } from './bytes.js';
import { geometryMesh, write } from './mesh.js';
import { asMeshInput, boxShape } from './shapes.js';

const FLOOR = 100000, SKY = 250000;               // floor half size and sky dome radius
const ZONE = [512, 512, 352];                     // the trigger zone's half size
const ACTOR = 0x0207000100000000n, INNER = 0x0007000100000000n, TOP = 0x0007000400000000n;   // object flags as UDK sets them
const PROBE = { WorldInfo: 0x43, PlayerStart_TA: 0x756e, Pylon_Soccar_TA: 0x0d, DirectionalLight: 0x0a, StaticMeshActor: 0x0d, TriggerVolume: 0x0d };
const COLOR_PARAM = [1378020830, 1227273346, 2316132514, 4232704091];   // LevelColorationLitMaterial's Color parameter
const GAME_SURFACES = [                           // [package path..., class, name]
  ['ARC_Field', 'spacestation_fieldassets', 'Material', 'MAT_FieldGlass'],
  ['ARC_Field', 'spacestation_assets', 'Materials', 'Material', 'MAT_Metal_Master'],
  ['BG_CS', 'ss_oob', 'Mat', 'Material', 'CS_Concrete_MAT'],
  ['BG_CS', 'city', 'Materials', 'MaterialInstanceConstant', 'Concrete_Hexagons_MIC'],
  ['Beach_Field', 'beach_materials', 'MIC', 'buildings', 'MaterialInstanceConstant', 'BCH_Plastic_White_MIC'],
  ['FNI_Stadium_OOB', 'fni_assets01', 'Materials', 'Material', 'Ice_02_Mat'],
];
const TINTS = { Sand: [0.5, 0.375, 0.227], White: [0.8, 0.8, 0.8], Gray: [0.25, 0.25, 0.25], Dark: [0.05, 0.05, 0.05],
                Blue: [0.05, 0.2, 0.6], Orange: [0.8, 0.3, 0.03], Green: [0.1, 0.45, 0.12] };

class Writer {                                    // names, imports and exports, then the package bytes
  constructor() { Object.assign(this, { names: [], nameAt: new Map(), imports: [], importAt: new Map(), exports: [] }); }
  name(text, number = 0) {
    if (!this.nameAt.has(text)) { this.nameAt.set(text, this.names.length); this.names.push(text); }
    return pack('<ii', this.nameAt.get(text), number);
  }
  imp(...path) {                                  // [classPackage, className, name] from the outermost; returns the import ref
    let outer = 0;
    for (const [classPackage, className, name] of path) {
      const key = `${outer}/${className}/${name}`;
      if (!this.importAt.has(key)) {
        this.imports.push(concat(this.name(classPackage), this.name(className), pack('<i', outer), this.name(name)));
        this.importAt.set(key, -this.imports.length);
      }
      outer = this.importAt.get(key);
    }
    return outer;
  }
  cls(pkg, name) { return this.imp(['Core', 'Package', pkg], ['Core', 'Class', name]); }
  exp(cls, outer, name, number, flags, archetype = 0) {   // declare an export; its blob comes later (refs are known by then)
    this.exports.push({ cls, outer, name: this.name(name, number), flags, archetype, blob: null, netAt: 0, bulkAt: [] });
    return this.exports.length;                   // 1-based reference
  }
  bytes() {
    const fstr = s => concat(pack('<i', s.length + 1), latin1Bytes(s), new Uint8Array(1));
    const header = n => concat(pack('<IHHi', 0x9E2A83C1, 868, 0, n.size), fstr('None'), pack('<I', 0x20001),
      pack('<7i', this.names.length, n.names, this.exports.length, n.exports, this.imports.length, n.imports, n.depends),
      pack('<4i', n.size, 0, 0, 0), crypto.getRandomValues(new Uint8Array(16)),
      pack('<4i', 1, this.exports.length, this.names.length, this.exports.length), pack('<6i', 12791, 0, 0, 0, n.source, 0), pack('<i', 0));
    const names = concat(...this.names.map(t => concat(fstr(t), pack('<Q', 0x0007001000000000n))));
    const imports = concat(...this.imports), depends = new Uint8Array(4 * this.exports.length);
    const at = { names: header({ size: 0 }).length };
    at.imports = at.names + names.length;
    at.exports = at.imports + imports.length;
    at.depends = at.exports + 68 * this.exports.length;
    at.size = at.depends + depends.length;
    at.source = crypto.getRandomValues(new Uint32Array(1))[0] | 0;
    let off = at.size;
    const entries = this.exports.map((e, k) => {
      packInto('<i', e.blob, e.netAt, k);
      for (const b of e.bulkAt) packInto('<i', e.blob, b + 12, off + b + 16);
      const entry = concat(pack('<3i', e.cls, 0, e.outer), e.name, pack('<iQii', e.archetype, e.flags, e.blob.length, off), pack('<iI', 0, 0),
                           new Uint8Array(16), pack('<I', 0));
      off += e.blob.length;
      return entry;
    });
    return concat(header(at), names, imports, ...entries, depends, ...this.exports.map(e => e.blob));
  }
}

// Tagged properties
const props = (w, list) => concat(...list.filter(Boolean), w.name('None'));
const tag = (w, name, type, body, struct = null) => concat(w.name(name), w.name(type), pack('<ii', type === 'BoolProperty' ? 0 : body.length, 0),
                                                           struct ? w.name(struct) : new Uint8Array(0), body);
const P = {
  int: (w, n, v) => tag(w, n, 'IntProperty', pack('<i', v)),
  float: (w, n, v) => tag(w, n, 'FloatProperty', pack('<f', v)),
  bool: (w, n, v) => tag(w, n, 'BoolProperty', Uint8Array.of(v ? 1 : 0)),
  obj: (w, n, v) => tag(w, n, 'ObjectProperty', pack('<i', v)),
  name: (w, n, v) => tag(w, n, 'NameProperty', w.name(v)),
  objs: (w, n, refs) => tag(w, n, 'ArrayProperty', pack(`<i${refs.length}i`, refs.length, ...refs)),
  vector: (w, n, v) => tag(w, n, 'StructProperty', pack('<3f', ...v), 'Vector'),
  rotator: (w, n, v) => tag(w, n, 'StructProperty', pack('<3i', ...v), 'Rotator'),
  guid: (w, n) => tag(w, n, 'StructProperty', crypto.getRandomValues(new Uint8Array(16)), 'Guid'),
  color: (w, n, [r, g, b]) => tag(w, n, 'StructProperty', Uint8Array.of(b, g, r, 0), 'Color'),
  struct: (w, n, struct, inner) => tag(w, n, 'StructProperty', props(w, inner), struct),
  raw: (w, n, count, bytes) => tag(w, n, 'ArrayProperty', concat(pack('<i', count), bytes)),
};
const LIGHTMASS = pack('<2ifif4f', 0, 0, 1, 0, 2, 0, 1, 1, 1);   // default FLightmassPrimitiveSettings
// object bytes and where their NetIndex sits: after an actor's script state frame (class, class, probe mask, latent
// action, code offset), after a component's template owner class, else first
const object = (w, list, native = new Uint8Array(0)) => ({ blob: concat(pack('<i', 0), props(w, list), native), netAt: 0 });
const component = (w, list, native) => ({ blob: concat(pack('<i', 0), object(w, list, native).blob), netAt: 4 });
const actor = (w, cls, kind, list, native) => ({ blob: concat(pack('<iiQhi', cls, cls, (BigInt(PROBE[kind]) << 32n) | 0xffffffffn, 0, -1), object(w, list, native).blob), netAt: 22 });

export function blankMap() {
  const w = new Writer(), engine = n => w.cls('Engine', n), tagame = n => w.cls('TAGame', n);
  const def = (pkg, cls, sub, subCls) => w.imp(['Core', 'Package', pkg], [pkg, cls, `Default__${cls}`], ...(sub ? [['Engine', subCls, sub]] : []));
  const exp = (...args) => w.exp(...args);

  // the world, its level and the level's empty BSP
  const world = exp(engine('World'), 0, 'TheWorld', 0, INNER);
  const level = exp(engine('Level'), world, 'PersistentLevel', 0, INNER);
  const bsp = exp(engine('Model'), level, 'Model', 1, INNER), bspPolys = exp(engine('Polys'), level, 'Polys', 1, INNER);
  const info = exp(engine('WorldInfo'), level, 'WorldInfo', 1, ACTOR);
  const sequence = exp(engine('Sequence'), level, 'Main_Sequence', 0, INNER);

  // spawn and game setup: the Pylon lists the spawn; navigation runs spawn -> Pylon
  const start = exp(tagame('PlayerStart_TA'), level, 'PlayerStart_TA', 1, ACTOR);
  const startCyl = exp(engine('CylinderComponent'), start, 'CylinderComponent', 1, INNER, def('TAGame', 'PlayerStart_TA', 'CollisionCylinder', 'CylinderComponent'));
  const pylon = exp(tagame('Pylon_Soccar_TA'), level, 'Pylon_Soccar_TA', 1, ACTOR);
  const pylonCyl = exp(engine('CylinderComponent'), pylon, 'CylinderComponent', 2, INNER, def('TAGame', 'Pylon_Soccar_TA', 'CollisionCylinder', 'CylinderComponent'));
  const pylonRadius = exp(engine('DrawPylonRadiusComponent'), pylon, 'DrawPylonRadiusComponent', 1, INNER, def('TAGame', 'Pylon_Soccar_TA', 'DrawPylonRadius0', 'DrawPylonRadiusComponent'));
  const pylonRender = exp(engine('NavMeshRenderingComponent'), pylon, 'NavMeshRenderingComponent', 1, INNER, def('TAGame', 'Pylon_Soccar_TA', 'NavMeshRenderer', 'NavMeshRenderingComponent'));

  // lights: a key sun, a soft fill from the other side and one from above
  const SUNS = [[1.3, [-8192, 5461, 0], [255, 250, 240]], [0.35, [-4096, -27307, 0], [220, 230, 255]], [0.3, [-16384, 0, 0], [255, 255, 255]]];
  const suns = SUNS.map((_, k) => {
    const a = exp(engine('DirectionalLight'), level, 'DirectionalLight', k + 1, ACTOR);
    return [a, exp(engine('DirectionalLightComponent'), a, 'DirectionalLightComponent', k + 1, INNER, def('Engine', 'DirectionalLight', 'DirectionalLightComponent0', 'DirectionalLightComponent'))];
  });

  // surfaces: tints of the engine's coloration material, and some of the game's own
  const coloration = w.imp(['Core', 'Package', 'enginedebugmaterials'], ['Engine', 'Material', 'LevelColorationLitMaterial']);
  const tints = Object.fromEntries(Object.keys(TINTS).map(n => [n, exp(w.cls('Engine', 'MaterialInstanceConstant'), 0, `${n}_INST`, 0, TOP)]));
  for (const path of GAME_SURFACES) {
    const groups = path.slice(0, -2), [cls, name] = path.slice(-2);
    w.imp(...groups.map(g => ['Core', 'Package', g]), ['Engine', cls, name]);
  }
  const sky = w.imp(['Core', 'Package', 'Park_P'], ['Core', 'Package', 'sky_partlycloudy_assets'], ['Core', 'Package', 'Materials'], ['Engine', 'Material', 'SkyDome_MAT']);
  const sticky = exp(engine('PhysicalMaterial'), 0, 'StickyWalls', 0, TOP);
  const stickyProp = exp(tagame('PhysicalMaterialProperty_TA'), sticky, 'PhysicalMaterialProperty_TA', 1, TOP);

  // the floor (its top at z = 0) and the sky dome: our own meshes; the floor is also the mesh actor new shapes copy
  const meshCls = engine('StaticMesh'), meshComp = def('Engine', 'StaticMeshActor', 'StaticMeshComponent0', 'StaticMeshComponent');
  const floorMesh = exp(meshCls, 0, 'Floor', 0, TOP), skyMesh = exp(meshCls, 0, 'SkyDome', 0, TOP);
  const floor = exp(engine('StaticMeshActor'), level, 'StaticMeshActor', 1, ACTOR);
  const floorComp = exp(engine('StaticMeshComponent'), floor, 'StaticMeshComponent', 1, INNER, meshComp);
  const dome = exp(engine('StaticMeshActor'), level, 'StaticMeshActor', 2, ACTOR);
  const domeComp = exp(engine('StaticMeshComponent'), dome, 'StaticMeshComponent', 2, INNER, meshComp);

  // the trigger zone checkpoints, gates, lava and markers are copies of; parked far under the floor
  const zone = exp(engine('TriggerVolume'), level, 'TriggerVolume', 1, ACTOR);
  const zoneComp = exp(engine('BrushComponent'), zone, 'BrushComponent', 1, INNER, def('Engine', 'TriggerVolume', 'BrushComponent0', 'BrushComponent'));
  const zoneModel = exp(engine('Model'), zone, 'Model', 2, INNER), zonePolys = exp(engine('Polys'), zoneModel, 'Polys', 2, INNER & ~0x0000000100000000n);

  const actors = [info, 0, start, pylon, ...suns.map(([a]) => a), floor, dome, zone];
  const set = (r, { blob, netAt }, bulkAt = []) => Object.assign(w.exports[r - 1], { blob, netAt, bulkAt });

  set(world, object(w, [], concat(pack('<ii', level, 0), ...Array.from({ length: 4 }, () => concat(new Uint8Array(24), pack('<f', 10000))), pack('<ii', 0, 0))));
  set(level, object(w, [], concat(
    pack(`<ii${actors.length}i`, level, actors.length, ...actors),
    ...['unreal', '', 'Untitled', ''].map(s => s ? concat(pack('<i', s.length + 1), latin1Bytes(s), new Uint8Array(1)) : pack('<i', 0)),
    pack('<4i', 0, 7777, 1, bsp), pack('<i', 0), pack('<ii', 1, sequence),
    pack('<2i', 0, 0),                            // texture streaming: none
    pack('<5i', 16, 0, 0, 12, 0), pack('<2i', 1, 0), pack('<4i', 0, 0, 0, 0), pack('<2i', 0, 34079889), pack('<i', 0), pack('<2i', 0, 0),   // physics caches: empty
    pack('<6i', start, pylon, 0, 0, pylon, pylon), pack('<i', 0), new Uint8Array(89))));   // navigation, then no precomputed lighting
  set(bsp, object(w, [], concat(new Uint8Array(28), pack('<6i', 12, 0, 12, 0, 64, 0), pack('<ii', bsp, 0), pack('<ii', 24, 0),
    pack('<3i', 4, 0, bspPolys), pack('<4i', 4, 0, 4, 0), pack('<2i', 1, 0), pack('<2i', 4, 0), pack('<3i', 0, 36, 0),
    crypto.getRandomValues(new Uint8Array(16)), pack('<i', 0))));
  set(bspPolys, object(w, [], pack('<3i', 0, 0, bspPolys)));
  set(info, actor(w, engine('WorldInfo'), 'WorldInfo', [P.bool(w, 'bMapNeedsLightingFullyRebuilt', true), P.name(w, 'Tag', 'WorldInfo')]));
  set(sequence, object(w, [P.objs(w, 'SequenceObjects', [])]));

  const lit = list => P.struct(w, 'LightingChannels', 'LightingChannelContainer', list.map(n => P.bool(w, n, true)));
  const cylinder = () => component(w, [P.obj(w, 'ReplacementPrimitive', 0), lit(['bInitialized', 'Dynamic'])]);
  // 500 behind the field centre, where Free Play drops a ball the map doesn't place (as in TestGround)
  set(start, actor(w, tagame('PlayerStart_TA'), 'PlayerStart_TA', [P.bool(w, 'bPathsChanged', true), P.obj(w, 'nextNavigationPoint', pylon), P.obj(w, 'CylinderComponent', startCyl),
    P.guid(w, 'NavGuid'), P.vector(w, 'Location', [-500, 0, 30]), P.name(w, 'Tag', 'PlayerStart_TA'), P.obj(w, 'CollisionComponent', startCyl)]));
  set(startCyl, cylinder());
  set(pylon, actor(w, tagame('Pylon_Soccar_TA'), 'Pylon_Soccar_TA', [P.objs(w, 'SpawnPoints', [start]), P.obj(w, 'PylonRadiusPreview', pylonRadius),
    P.obj(w, 'RenderingComp', pylonRender), P.bool(w, 'bPathsChanged', true), P.obj(w, 'CylinderComponent', pylonCyl), P.guid(w, 'NavGuid'),
    P.vector(w, 'Location', [0, 0, 53]), P.name(w, 'Tag', 'Pylon_Soccar_TA'), P.obj(w, 'CollisionComponent', pylonCyl)], pack('<ii', 0, 0)));   // no nav mesh
  set(pylonCyl, cylinder());
  set(pylonRadius, component(w, [P.float(w, 'SphereRadius', 2048), P.obj(w, 'ReplacementPrimitive', 0), lit(['bInitialized', 'Dynamic'])]));
  set(pylonRender, cylinder());

  suns.forEach(([a, c], k) => {
    const [brightness, rot, color] = SUNS[k];
    set(a, actor(w, engine('DirectionalLight'), 'DirectionalLight', [P.obj(w, 'LightComponent', c), P.vector(w, 'Location', [0, 0, 3000 + 300 * k]),
      P.rotator(w, 'Rotation', rot), P.name(w, 'Tag', 'DirectionalLight')]));
    set(c, component(w, [P.guid(w, 'LightGuid'), P.guid(w, 'LightmapGuid'), P.float(w, 'Brightness', brightness), P.color(w, 'LightColor', color),
      P.bool(w, 'CastShadows', false), P.bool(w, 'CastStaticShadows', false), P.bool(w, 'CastDynamicShadows', false)]));
  });

  for (const [n, rgb] of Object.entries(TINTS)) {
    set(tints[n], object(w, [tag(w, 'VectorParameterValues', 'ArrayProperty', concat(pack('<i', 1), props(w, [
      P.name(w, 'ParameterName', 'Color'), tag(w, 'ParameterValue', 'StructProperty', pack('<4f', ...rgb, 0), 'LinearColor'),
      tag(w, 'ExpressionGUID', 'StructProperty', pack('<4I', ...COLOR_PARAM), 'Guid')]))), P.obj(w, 'Parent', coloration)]));
  }
  set(sticky, object(w, [P.obj(w, 'PhysicalMaterialProperty', stickyProp)]));
  set(stickyProp, object(w, [P.bool(w, 'bStickyWheels', true)]));

  const meshHead = () => concat(pack('<i', 0), props(w, ['UseSimpleRigidBodyCollision', 'UseSimpleBoxCollision', 'UseSimpleLineCollision'].map(n => P.bool(w, n, false))));
  const mesh = (geometry, material, streaming) => {
    const template = { head: meshHead(), version: 18, preLod: new Uint8Array(16), sections: [{ fields: [material] }],
                       tail: concat(pack('<i', 1), new Uint8Array(24), new Uint8Array(16), pack('<iif6i', 2, 4, streaming, 0, 0, 0, 1, 0, 0)) };
    const [blob, rawAt] = write(geometryMesh(template, ...asMeshInput(geometry)));
    return [{ blob, netAt: 0 }, [rawAt]];
  };
  set(floorMesh, ...mesh(boxShape([0, 0, -50, FLOOR, FLOOR, 50]), tints.Sand, 1024));
  set(skyMesh, ...mesh(domeGeometry(), sky, SKY));
  const meshActor = (a, comp, cls) => set(a, actor(w, cls, 'StaticMeshActor', [P.obj(w, 'StaticMeshComponent', comp), P.name(w, 'Tag', 'StaticMeshActor'), P.obj(w, 'CollisionComponent', comp)]));
  meshActor(floor, floorComp, engine('StaticMeshActor'));
  set(floorComp, component(w, [P.obj(w, 'StaticMesh', floorMesh), P.int(w, 'VertexPositionVersionNumber', 1), P.objs(w, 'Materials', [tints.Sand]),
    P.obj(w, 'ReplacementPrimitive', 0), P.bool(w, 'BlockRigidBody', true), P.bool(w, 'bDisableAllRigidBody', false), lit(['bInitialized', 'Static']),
    P.struct(w, 'RBCollideWithChannels', 'RBCollisionChannelContainer', ['Default', 'Vehicle', 'Ball'].map(n => P.bool(w, n, true))),
    P.obj(w, 'PhysMaterialOverride', sticky), P.bool(w, 'bAcceptsDynamicDecals', true)], pack('<i', 0)));
  meshActor(dome, domeComp, engine('StaticMeshActor'));
  set(domeComp, component(w, [P.obj(w, 'StaticMesh', skyMesh), P.int(w, 'VertexPositionVersionNumber', 1), P.obj(w, 'ReplacementPrimitive', 0),
    ...['CastShadow', 'bAcceptsLights', 'CollideActors', 'BlockActors', 'BlockRigidBody', 'BlockZeroExtent', 'BlockNonZeroExtent'].map(n => P.bool(w, n, false))],
    pack('<i', 0)));

  set(zone, actor(w, engine('TriggerVolume'), 'TriggerVolume', [P.obj(w, 'Brush', zoneModel), P.obj(w, 'BrushComponent', zoneComp), P.vector(w, 'Location', [0, 0, -50000]),
    P.name(w, 'Tag', 'TriggerVolume'), P.obj(w, 'CollisionComponent', zoneComp)]));
  const box = boxBrush(ZONE);
  set(zoneComp, component(w, [P.obj(w, 'Brush', zoneModel), P.struct(w, 'BrushAggGeom', 'KAggregateGeom', [convexElems(w, box)]),
    P.obj(w, 'ReplacementPrimitive', 0)], pack('<i', 0)));
  set(zoneModel, object(w, [], brushModel(box, zoneModel, zonePolys)));
  set(zonePolys, object(w, [], brushPolys(w, box, zonePolys)));

  return w.bytes();
}

// The zone box: corners (bit 0: +X, bit 1: +Y, bit 2: +Z) and faces as [normal, plane distance, corners in the order
// that makes cross(b - a, c - a) point out of the box, as UDK stores brush polygons].
function boxBrush(E) {
  const corners = Array.from({ length: 8 }, (_, k) => [k & 1 ? E[0] : -E[0], k & 2 ? E[1] : -E[1], k & 4 ? E[2] : -E[2]]);
  const sub = (a, b) => a.map((v, k) => v - b[k]), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const faces = [];
  for (const axis of [0, 1, 2]) {
    for (const s of [-1, 1]) {
      const n = [0, 0, 0];
      n[axis] = s;
      const [u, v] = [0, 1, 2].filter(k => k !== axis), bit = k => 1 << k, side = s > 0 ? bit(axis) : 0;
      let quad = [0, bit(u), bit(u) | bit(v), bit(v)].map(m => m | side);
      const c = cross(sub(corners[quad[1]], corners[quad[0]]), sub(corners[quad[2]], corners[quad[0]]));
      if (c[axis] * s < 0) quad = quad.reverse();
      faces.push({ n, d: E[axis], quad, u: [0, 1, 2].map(k => k === u ? 1 : 0), v: [0, 1, 2].map(k => k === v ? -1 : 0) });
    }
  }
  return { E, corners, faces };
}

function brushModel({ E, corners, faces }, self, polys) {   // the zone's BSP: one node per face, chained back to back
  const vectors = faces.flatMap(f => [f.n, f.u, f.v]);
  const nodes = faces.map((f, k) => concat(pack('<4f', ...f.n, f.d), pack('<5i', 4 * k, k, 0, 0, 0),
    pack('<4i', k < 5 ? k + 1 : -1, -1, -1, k < 5 ? -1 : 0), Uint8Array.of(0, 0, 4, 0), pack('<2i', -1, -1)));
  const surfs = faces.map((f, k) => concat(pack('<8i', 0, 0x0e00, f.quad[0], 3 * k, 3 * k + 1, 3 * k + 2, -1, 0), pack('<4f', ...f.n, f.d), pack('<fii', 32, 3, 0)));
  const verts = faces.flatMap(f => f.quad.map(c => pack('<ii4f', c, -1, 0, 0, 0, 0)));
  const hull = concat(pack('<7i', 0, 1, 2, 3, 4, 5, -1), pack('<6f', ...E.map(e => -e - 0.1), ...E.map(e => e + 0.1)));
  return concat(pack('<7f', 0, 0, 0, ...E, Math.hypot(...E)), pack('<ii', 12, vectors.length), ...vectors.map(v => pack('<3f', ...v)),
    pack('<ii', 12, 8), ...corners.map(c => pack('<3f', ...c)), pack('<ii', 64, 6), ...nodes, pack('<ii', self, 6), ...surfs,
    pack('<ii', 24, 24), ...verts, pack('<3i', 4, 0, polys), pack('<ii', 4, 13), hull, pack('<2i', 4, 0), pack('<2i', 1, 0), pack('<2i', 4, 0),
    pack('<3i', 8, 36, 0), crypto.getRandomValues(new Uint8Array(16)), pack('<i', 1), LIGHTMASS);
}

function brushPolys(w, { corners, faces }, self) {
  return concat(pack('<3i', 6, 6, self), ...faces.map((f, k) => concat(pack('<12f', ...corners[f.quad[0]], ...f.n, ...f.u, ...f.v), pack('<i', 4),
    ...f.quad.map(c => pack('<3f', ...corners[c])), pack('<2i', 0x0e00, 0), w.name('None'), pack('<3ifi', 0, k, -1, 32, 3), LIGHTMASS, w.name('None'))));
}

function convexElems(w, { E, corners, faces }) {  // the zone's collision: one convex element, the box
  const planes = faces.map(f => pack('<4f', ...f.n, f.d));
  const permuted = [0, 4].flatMap(g => [0, 1, 2].map(axis => pack('<4f', ...[0, 1, 2, 3].map(k => corners[g + k][axis]))));
  const tris = faces.flatMap(f => [f.quad[0], f.quad[1], f.quad[2], f.quad[0], f.quad[2], f.quad[3]]);
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => pack('<3f', ...a));
  const elem = props(w, [P.raw(w, 'VertexData', 8, concat(...corners.map(c => pack('<3f', ...c)))), P.raw(w, 'PermutedVertexData', 6, concat(...permuted)),
    P.raw(w, 'FaceTriData', tris.length, pack(`<${tris.length}i`, ...tris)), P.raw(w, 'EdgeDirections', 3, concat(...axes)),
    P.raw(w, 'FaceNormalDirections', 3, concat(...axes)), P.raw(w, 'FacePlaneData', 6, concat(...planes)),
    tag(w, 'ElemBox', 'StructProperty', concat(pack('<6f', ...E.map(e => -e), ...E), Uint8Array.of(1)), 'Box')]);
  return tag(w, 'ConvexElems', 'ArrayProperty', concat(pack('<i', 1), elem));
}

function domeGeometry(rows = 16, columns = 32) {  // a sky dome seen from inside: latitude rows from below the horizon to the top
  const P = [], U = [], N = [], T = [], tris = [];
  for (let r = 0; r <= rows; r++) {
    const lat = -0.15 + (Math.PI / 2 + 0.15) * r / rows;
    for (let c = 0; c <= columns; c++) {
      const lon = 2 * Math.PI * c / columns, d = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      P.push(...d.map(v => v * SKY));
      U.push(c / columns, 1 - r / rows);
      N.push(...d.map(v => -v));
      T.push(-Math.sin(lon), Math.cos(lon), 0, ...[Math.sin(lat) * Math.cos(lon), Math.sin(lat) * Math.sin(lon), -Math.cos(lat)]);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const a = r * (columns + 1) + c, b = a + 1, d = a + columns + 1, e = d + 1;
      tris.push(a, b, e, a, e, d);                 // fronts face the centre
    }
  }
  return { positions: Float32Array.from(P), uvs: Float32Array.from(U), normals: Float32Array.from(N), tangents: Float32Array.from(T), tris: Uint32Array.from(tris) };
}
