// The map being edited as plain data: a document of settings and entities, one per object. Entities and documents
// are never changed in place: an edit makes new ones, so any earlier document is an undo step as it is.
// docFrom(describe(file)) is the map as saved; diff(saved, edited) is what build() applies to the file. A recipe
// (recipeOf, applyRecipe) is that difference as JSON, which the autosave keeps; a clip (clipOf, paste) is a few
// objects as JSON: the clipboard, saved pieces and shared files.
import { BALL_LIFT, BALL_TOP_AHEAD } from './kismet.js';
import { LIGHT_FIELDS, LIGHT_KINDS } from './lights.js';
import { LIGHTING } from './map.js';
import { ueAxes } from './motion.js';
import { planNames } from './script.js';
import { asMeshInput } from './shapes.js';
import { apron, changedTiles } from './terrain.js';

export const NO_HUD = { timer: false, deaths: false };
// A gate is a checkpoint squashed flat along the way it faces: you pass through it. Thin is safe: the trigger fires
// on any overlap, and per physics step the ball (182 across) moves at most ~50 units, the car (118 long) ~20.
export const GATE = 20;
export const GATE_PAST = 250;                     // a reset at a gate puts the car this far past it, clear of the trigger
export const RESPAWN_CLEARANCE = 30;              // a reset puts the car this far above the ground (it rests at 17)
export const BALL_REST = 95;                      // a resting ball's centre this far over the ground (its radius is 92.75)
export const NEW_GRAVITY = -200;                  // a new gravity zone pulls about a third as hard: floaty
// Lava reaches from just under the floor to above the car's body, which rides about 13 units over it
export const LAVA_BELOW = 20, LAVA_ABOVE = 40;

export const same = (x, y, eps) => x.every((v, i) => Math.abs(v - y[i]) < eps);
const sameRot = (a, b) => { const x = ueAxes(a), y = ueAxes(b); return x.every((ax, i) => same(ax, y[i], 1e-4)); };
const json = v => JSON.stringify(v ?? null);
export const isVolume = e => /Volume/.test(e.cls);
export const isGate = e => 2 * e.bounds[3] * Math.abs(e.scale3d[0] * e.scale) <= 150;   // also the 100-unit gates saved earlier
export const isZone = e => e.kind === 'zone' || e.kind === 'gravity';
export const hasPanel = e => e.kind === 'checkpoint' || e.kind === 'lava' || isZone(e);
export const canMove = e => e.kind === 'shape' || !!e.mover;   // shapes added in the editor, and moving shapes the map has
export const isSolid = e => !!e.bounds && !isVolume(e) && e.kind !== 'ball' && e.kind !== 'spawn';
export const single = e => e.kind === 'spawn' || e.kind === 'ball';   // one of each per map: kept, never copied
export const settingsOf = light => Object.fromEntries(['kind', ...LIGHT_FIELDS].filter(f => f in light).map(f => [f, structuredClone(light[f])]));
export const scaleOf = e => e.scale3d.map((v, k) => v * e.scale * (e.inner?.[k] ?? 1));
// a ball resting on the car at spawn `start`: over it, a little ahead of its middle
export const roofSpot = start => {
  const forward = ueAxes(start.rot)[0];
  return [start.loc[0] + forward[0] * BALL_TOP_AHEAD, start.loc[1] + forward[1] * BALL_TOP_AHEAD, start.loc[2] + BALL_LIFT];
};
export function worldBox(e) {                     // {min, max} in map axes of the entity's bounds as placed
  const b = e.bounds, s = scaleOf(e), ax = ueAxes(e.rot), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
    const p = [(b[0] + dx * b[3]) * s[0], (b[1] + dy * b[4]) * s[1], (b[2] + dz * b[5]) * s[2]];
    for (let k = 0; k < 3; k++) {
      const w = e.loc[k] + ax[0][k] * p[0] + ax[1][k] * p[1] + ax[2][k] * p[2];
      min[k] = Math.min(min[k], w); max[k] = Math.max(max[k], w);
    }
  }
  return { min, max };
}
// the widest flat solid the map came with: its floor, what lava covers and the Map's Ground sets
export function floorOf(doc) {
  let best = null, area = 0;
  for (const e of doc.objects) {
    if (e.i === null || !isSolid(e)) continue;
    const { min, max } = worldBox(e), a = (max[0] - min[0]) * (max[1] - min[1]);
    if (max[2] - min[2] < 1000 && a > area) [best, area] = [e, a];
  }
  return best;
}
const takesSurface = e => !!e && (e.kind === 'shape' || (e.cls === 'StaticMeshActor' && e.meshIndex !== null));
// [loc, scale3d] of a lava zone covering a floor box ({min, max}) whose top is at `top`
export function lavaValues(box, top, bounds) {
  const s = [(box.max[0] - box.min[0]) / (2 * bounds[3]), (box.max[1] - box.min[1]) / (2 * bounds[4]), (LAVA_BELOW + LAVA_ABOVE) / (2 * bounds[5])];
  const centre = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, top + (LAVA_ABOVE - LAVA_BELOW) / 2];
  return [centre.map((v, k) => v - bounds[k] * s[k]), s];
}

// The document of a map as describe() reads it, and the facts about the map that editing never changes
export function docFrom(data, saveName = 'my-map.udk') {
  const cps = new Map(data.checkpoints.map(c => [c.i, c])), lavas = new Map(data.lava.map(z => [z.i, z]));
  const notes = data.editor?.objects ?? {}, scripted = new Map(Object.entries(data.script?.names ?? {}).map(([n, i]) => [i, n]));
  const movers = new Map(data.movers.map(m => [m.i, m.motion]));
  const markers = new Set(data.checkpoints.filter(c => c.dest !== c.i).map(c => c.dest));   // they follow their checkpoint
  const spawn = data.actors.find(a => a.cls.startsWith('PlayerStart'));
  const objects = [];
  for (const a of data.actors) {
    if (/^Pylon/.test(a.cls) || markers.has(a.i)) continue;   // the Pylon is the game's setup at the spawn
    const note = notes[a.i] ?? {}, e = { uid: `e${a.i}`, id: scripted.get(a.i) ?? note.name ?? `map#${a.i}`, kind: null, i: a.i, cls: a.cls, name: a.name,
      mesh: a.mesh, meshIndex: a.meshIndex, bounds: a.bounds, inner: a.inner, materials: a.materials ?? [], loc: [...a.loc], rot: [...a.rot], scale3d: [...a.scale3d], scale: a.scale };
    const cp = cps.get(a.i), lava = lavas.get(a.i);
    if (a.cls.startsWith('PlayerStart')) e.kind = 'spawn';
    else if (a.i === data.ballSpawn) {
      const onRoof = !!spawn && [roofSpot(spawn), [spawn.loc[0], spawn.loc[1], spawn.loc[2] + BALL_LIFT]].some(at => same(a.loc, at, 1));   // or straight over it, as saved before
      Object.assign(e, { kind: 'ball', placed: true, onRoof });
    } else if (a.light) Object.assign(e, { kind: 'light', light: settingsOf(a.light) });
    else if (a.cls === 'GravityVolume') Object.assign(e, { kind: 'gravity', gravity: a.gravity, panel: null });
    else if (cp) Object.assign(e, { kind: 'checkpoint', ball: cp.ball, ballOnTop: cp.ballOnTop, oldBall: cp.ball && cp.modeVar === null, title: cp.title ?? undefined,
                                    panel: null, respawn: { valueVar: cp.valueVar, marker: cp.dest !== cp.i ? cp.dest : null } });
    else if (lava) Object.assign(e, { kind: 'lava', lava: { car: lava.car, ball: lava.ball }, panel: null });
    else if (note.zone || (scripted.has(a.i) && a.cls === 'TriggerVolume')) Object.assign(e, { kind: 'zone', panel: null });
    else if (note.shape) Object.assign(e, { kind: 'shape', shape: note.shape, surface: e.materials[0] || null });
    else if (a.i === data.zone?.i && a.loc[2] < -10000) e.kind = 'template';   // the blank map's zone to copy, out of the way
    else e.kind = a.bounds && !isVolume(a) ? 'mesh' : isVolume(a) ? 'volume' : 'marker';
    if (a.cls === 'InterpActor' && (note.shape || scripted.has(a.i))) e.mover = true;
    const m = movers.get(a.i);
    if (m) Object.assign(e, { mover: true, motion: { ...m, trigger: m.trigger === null ? null : `e${m.trigger}` } });
    objects.push(e);
  }
  for (const e of objects) if (e.motion?.trigger && !objects.some(t => t.uid === e.motion.trigger)) e.motion.trigger = null;
  const panels = new Set();
  for (const { i, material } of data.panels) {    // a checkpoint's visible panel sits exactly on it
    const at = objects.find(e => e.i === i), owner = at && objects.find(e => hasPanel(e) && e.kind !== 'gravity' && same(e.loc, at.loc, 1) && same(e.rot, at.rot, 1));
    if (!owner) continue;
    Object.assign(owner, { panel: { material }, savedPanel: { i, material } });
    panels.add(at);
  }
  const kept = objects.filter(e => !panels.has(e));
  if (!kept.some(e => e.kind === 'ball')) kept.push(ballEntity());
  const floor = floorOf({ objects: kept });
  for (const e of kept) if (e.kind === 'lava') e.floor = !e.panel && takesSurface(floor) ? floor.uid : null;   // saved lava shows on the floor when it has no panel
  const earthy = data.materials.find(m => /sand|grass|dirt|rock|ground|snow|terrain/i.test(m.name)) || data.materials[0];
  const t = data.terrain;
  const doc = {
    name: saveName, lighting: data.lights.length && data.lights.every(m => m === data.lights[0]) && data.lights[0] || 'map',
    hud: data.hud ? { ...data.hud } : NO_HUD, script: data.script?.source ?? '', images: {},
    terrain: { base: t.base, surface: t.material ?? earthy?.ref ?? null, tiles: new Map(t.tiles.map(({ tx, ty, heights }) => [`${tx},${ty}`, Float32Array.from(heights)])) },
    objects: kept,
  };
  const map = { palette: data.palette, zone: data.zone, materials: data.materials, tintable: data.tintable, spawnBall: data.spawnBall, moversSaved: data.movers.length,
                hasSuns: !!data.lights.length, terrainLocked: t.material !== null, cell: t.cell, tile: t.tile, sink: t.sink, earthy: earthy?.ref ?? null };
  return { doc, map };
}
// the ball where the game puts it, until it is given a spawn of its own
const ballEntity = () => ({ uid: 'ball', id: 'ball', kind: 'ball', i: null, cls: 'BallSpawn', name: 'Ball spawn', mesh: null, meshIndex: null, bounds: null,
                            materials: [], loc: [0, 0, 0], rot: [0, 0, 0], scale3d: [1, 1, 1], scale: 1, placed: false, onRoof: false });

// New entities. uids are the document's own handles (selection, a motion's trigger); ids are the names the Script, AI
// agents and the Map list use: the user's, else <kind>#<n>.
let made = 0;
export const newUid = () => `n${++made}`;
export function noteUids(doc) {                   // new uids go on past the ones a document brings back
  for (const e of doc.objects) made = Math.max(made, +(/^n(\d+)$/.exec(e.uid)?.[1] ?? 0));
}
const ID_KIND = { lava: 'lava', checkpoint: 'checkpoint', light: 'light', zone: 'zone', gravity: 'zone' };
export function nextId(doc, kind, taken = new Set()) {
  let n = 0;
  for (const id of [...doc.objects.map(e => e.id), ...taken]) if (!id.startsWith('map#')) n = Math.max(n, +(/^\w+#(\d+)$/.exec(id)?.[1] ?? 0));
  return `${ID_KIND[kind] ?? 'shape'}#${n + 1}`;
}
const fresh = (doc, kind, fields) => ({ uid: newUid(), id: nextId(doc, kind), kind, i: null, materials: [], scale: 1, meshIndex: null, ...fields });
export const shapeEntity = (doc, key, name, bounds, loc, rot, scale3d, surface) =>
  fresh(doc, 'shape', { cls: 'Shape', name, mesh: name, bounds, loc: [...loc], rot: [...rot], scale3d: [...scale3d], shape: key, surface });
export const checkpointEntity = (doc, map, ball, loc, rot, ballOnTop = false, scale3d = [1, 1, 1], title = '') =>
  fresh(doc, 'checkpoint', { cls: 'TriggerVolume', name: 'Checkpoint', mesh: null, bounds: map.zone.bounds, loc: [...loc], rot: [...rot], scale3d: [...scale3d], ball, ballOnTop, panel: null, title });
export const lavaEntity = (doc, map, loc, scale3d, lava, floor = null) =>
  fresh(doc, 'lava', { cls: 'TriggerVolume', name: 'Lava', mesh: null, bounds: map.zone.bounds, loc: [...loc], rot: [0, 0, 0], scale3d: [...scale3d], lava, panel: null, floor });
export const zoneEntity = (doc, map, loc, rot = [0, 0, 0], scale3d = [1, 1, 1], gravity = undefined) => fresh(doc, gravity === undefined ? 'zone' : 'gravity', {
  cls: gravity === undefined ? 'TriggerVolume' : 'GravityVolume', name: gravity === undefined ? 'Trigger zone' : 'Gravity zone', mesh: null, bounds: map.zone.bounds,
  loc: [...loc], rot: [...rot], scale3d: [...scale3d], panel: null, ...(gravity !== undefined ? { gravity } : {}) });
export const lightEntity = (doc, kind, loc, rot, light) =>
  fresh(doc, 'light', { cls: LIGHT_KINDS[kind].actor, name: LIGHT_KINDS[kind].name, mesh: null, bounds: null, loc: [...loc], rot: [...rot], scale3d: [1, 1, 1], light: structuredClone(light) });
export function copyEntity(doc, e, loc, taken) {   // `taken`: ids handed out alongside, not in the document yet
  const { uid, id, i, savedPanel, respawn, oldBall, ...rest } = structuredClone(e);
  return { ...rest, uid: newUid(), id: nextId(doc, e.kind, taken), i: null, src: i ?? e.src, name: `${e.mesh || e.name} copy`, loc: [...loc],
           ...(e.kind === 'checkpoint' ? { title: e.title ?? '' } : {}) };
}

// Edits: new documents
export const byUid = (doc, uid) => doc.objects.find(e => e.uid === uid);
export const byId = (doc, id) => doc.objects.find(e => e.id === id);
export const replace = (doc, list) => {           // entities put in place of the ones with their uids
  const by = new Map(list.map(e => [e.uid, e]));
  return { ...doc, objects: doc.objects.map(e => by.get(e.uid) ?? e) };
};
export const update = (doc, uid, fn) => replace(doc, [fn(byUid(doc, uid))]);
export const adding = (doc, list) => ({ ...doc, objects: [...doc.objects, ...list] });
export function removing(doc, uids) {
  const gone = new Set(uids);
  return { ...doc, objects: doc.objects.filter(e => !gone.has(e.uid))
    .map(e => e.motion?.trigger && gone.has(e.motion.trigger) ? { ...e, motion: { ...e.motion, trigger: null } } : e) };
}
// what follows from the rest: a ball on the car's roof stays there when the car moves
export function settle(doc) {
  const ball = doc.objects.find(e => e.kind === 'ball'), spawn = doc.objects.find(e => e.kind === 'spawn');
  if (!ball?.placed || !ball.onRoof || !spawn) return doc;
  const loc = roofSpot(spawn);
  return same(loc, ball.loc, 1e-6) ? doc : replace(doc, [{ ...ball, loc }]);
}

// Fields of entity `e` build() must hear about: what differs from the saved `o`, every field for new ones
function changes(e, o) {
  const out = {};
  if (!o || !same(e.loc, o.loc, 0.01)) out.loc = e.loc;
  if (!o || !sameRot(e.rot, o.rot)) out.rot = e.rot;
  if (!o || !same(e.scale3d, o.scale3d, 1e-4)) out.scale3d = e.scale3d;
  if (e.kind === 'checkpoint' && e.ball && (!o || e.ballOnTop !== o.ballOnTop)) out.ballOnTop = e.ballOnTop;
  if (e.kind === 'checkpoint' && e.title !== undefined && (o ? e.title !== o.title : e.title)) out.title = e.title;
  if (o && hasPanel(e) && (!!e.panel !== !!e.savedPanel || (e.panel && e.savedPanel && e.panel.material !== e.savedPanel.material))) out.panel = true;
  if (o && e.kind === 'lava' && (e.lava.car !== o.lava.car || e.lava.ball !== o.lava.ball)) out.lava = true;   // written anew in its place
  const s = e.surface, own = e.materials[0] || null;
  if (o && s !== undefined && (Array.isArray(s) ? s.some((m, k) => m !== (e.materials[k] || 0)) : s !== own)) out.surface = s;
  if (o && canMove(e) && json(e.motion) !== json(o.motion)) out.motion = true;   // the movers are written as a whole
  if (e.gravity !== undefined && (!o || e.gravity !== o.gravity)) out.gravity = e.gravity;
  if (e.light) {
    const set = LIGHT_FIELDS.filter(f => f in e.light && (!o?.light || json(e.light[f]) !== json(o.light[f])));
    if (set.length) out.light = Object.fromEntries(set.map(f => [f, e.light[f]]));
  }
  if (o && e.id !== o.id) out.name = true;
  return out;
}
const changedFrom = (e, o) => e !== o && Object.keys(changes(e, o)).length > 0;
const SAVED_KINDS = ['shape', 'checkpoint', 'zone', 'light', 'duplicate'];
const category = e => e.kind === 'shape' ? 'shape' : e.kind === 'checkpoint' || e.kind === 'lava' ? 'checkpoint' : isZone(e) ? 'zone'
  : e.kind === 'light' && e.src == null ? 'light' : 'duplicate';
export const isNew = e => e.i === null && e.kind !== 'ball';
export const ownId = e => /^map#\d+$/.test(e.id) || single(e) ? null : e.id;   // ids but the export-based one, which changes
export const ownName = e => /^(shape|checkpoint|lava|light|zone|map)#\d+$/.test(e.id) || single(e) ? null : e.id;

// how many changes the edited document has over the saved one
export function countChanges(base, doc, map) {
  const was = new Map(base.objects.map(e => [e.uid, e]));
  let n = doc.objects.filter(e => isNew(e) || (was.has(e.uid) && changedFrom(e, was.get(e.uid)))).length;
  const now = new Set(doc.objects.map(e => e.uid));
  n += base.objects.filter(e => !now.has(e.uid)).length;
  n += changedTiles(base.terrain.tiles, doc.terrain.tiles).length;
  return n + (doc.lighting !== base.lighting) + (json(doc.hud) !== json(base.hud)) + (doc.script !== base.script);
}

// [what build() applies to the saved map, summary]. ctx: respawnOf(entity) (where a reset at a checkpoint puts the
// car: a marker transform, or null for the zone's own pivot), plan (the script's, for doc.script; null when not run),
// shapeData(key) (a shape's geometry), panelSurface(lava) (a new panel's surface), lastSurface (new shapes').
/** @returns {[any, string]} */
export function diff(base, doc, map, ctx) {
  const was = new Map(base.objects.map(e => [e.uid, e])), now = new Map(doc.objects.map(e => [e.uid, e]));
  const added = doc.objects.filter(isNew), removed = base.objects.filter(e => e.i !== null && !now.has(e.uid));
  const saved = doc.objects.filter(e => e.i !== null), changed = saved.filter(e => changedFrom(e, was.get(e.uid)));
  const ofKind = Object.fromEntries(SAVED_KINDS.map(k => [k, added.filter(e => category(e) === k)]));
  const refOf = e => e.i !== null ? { i: e.i } : { [category(e)]: ofKind[category(e)].indexOf(e) };
  const plan = ctx.plan, named = plan ? planNames(plan) : new Map();
  const scriptMoves = new Set([...named].filter(([name, need]) => need === 'moves' && doc.objects.some(e => e.id === name)).map(([name]) => doc.objects.find(e => e.id === name).uid));
  const edits = changed.filter(e => e.kind !== 'ball').map(e => { const { motion, lava, name, ...x } = changes(e, was.get(e.uid)); return { i: e.i, ...x }; })
    .filter(x => Object.keys(x).length > 1);
  const duplicates = ofKind.duplicate.map(e => ({ src: e.src, ...changes(e), ...(e.surface !== undefined ? { material: e.surface } : {}) }));
  const triggerZones = ofKind.zone.map(e => { const { loc, rot, scale3d, gravity } = changes(e); return { loc, rot, scale3d, ...(e.gravity !== undefined ? { gravity } : {}) }; });
  const lights = ofKind.light.map(e => { const { loc, rot, light } = changes(e); return { kind: e.light.kind, loc, rot, ...light }; });
  const shapes = ofKind.shape.map(e => ({ key: e.shape, ...changes(e), material: e.surface ?? null, mover: !!e.motion || scriptMoves.has(e.uid) }));
  const shapeGeometry = Object.fromEntries([...new Set(shapes.map(s => s.key))].map(k => [k, asMeshInput(ctx.shapeData(k))]));
  const checkpoints = ofKind.checkpoint.map(e => e.kind === 'lava' ? { ...changes(e), lava: true, ...e.lava } : { ...changes(e), ball: !!e.ball, respawn: ctx.respawnOf(e) });
  const removes = removed.map(e => e.i), respawns = [], panels = [];
  for (const e of changed) {                      // saved lava that resets on other touches now: a new zone in its place
    if (!changes(e, was.get(e.uid)).lava) continue;
    removes.push(e.i);
    checkpoints.push({ loc: [...e.loc], rot: [...e.rot], scale3d: [...e.scale3d], scale: e.scale, lava: true, ...e.lava });
  }
  const moved = edits.filter(x => Object.keys(x).some(k => k !== 'i' && k !== 'light')).length, lit = edits.filter(x => x.light).length;
  const surfaces = edits.filter(x => 'surface' in x).map(x => ({ i: x.i, material: x.surface }));
  const panelAt = (e, material) => ({ loc: [...e.loc], rot: [...e.rot], scale3d: [...e.scale3d], scale: e.scale, material: material ?? ctx.panelSurface(e.kind === 'lava') });
  for (const e of added) if (hasPanel(e) && e.panel) panels.push(panelAt(e, e.panel.material));
  for (const b of base.objects) {                 // saved checkpoints: their panel follows them, or appears or goes
    if (!hasPanel(b)) continue;
    const e = now.get(b.uid), want = e?.panel, had = b.savedPanel;
    if (!want) { if (had) removes.push(had.i); continue; }
    if (!had) { panels.push(panelAt(e, want.material)); continue; }
    const { loc, rot, scale3d } = panelAt(e);
    edits.push({ i: had.i, loc, rot, scale3d });
    if (want.material !== null && want.material !== had.material) surfaces.push({ i: had.i, material: want.material });
  }
  for (const b of base.objects) {                 // saved checkpoints: their respawn point keeps in step with them
    const r = b.respawn, e = now.get(b.uid);
    if (!r) continue;
    if (!e) { if (r.marker !== null) removes.push(r.marker); continue; }
    const want = ctx.respawnOf(e);
    if (want && r.marker !== null) edits.push({ i: r.marker, loc: want.loc, rot: want.rot });
    else if (want) respawns.push({ valueVar: r.valueVar, zone: e.i, marker: want });
    else if (r.marker !== null) {
      respawns.push({ valueVar: r.valueVar, zone: e.i, marker: null });
      removes.push(r.marker);
    }
  }
  const ball = doc.objects.find(e => e.kind === 'ball');   // the ball's own spawn, once it has been placed
  let ballSpawn = null;
  if (ball?.placed) {
    if (ball.i === null) ballSpawn = { loc: [...ball.loc] };
    else if (!same(ball.loc, was.get(ball.uid).loc, 0.01)) edits.push({ i: ball.i, loc: [...ball.loc] });
  }
  const tiles = changedTiles(base.terrain.tiles, doc.terrain.tiles);
  const terrain = tiles.length ? { base: doc.terrain.base, material: doc.terrain.surface, tiles: tiles.map(key => {
    const [tx, ty] = key.split(',').map(Number);
    return { tx, ty, heights: apron(doc.terrain.tiles, tx, ty) };
  }) } : null;
  // moving shapes, all of them whenever one is new, gone, turned, rescaled or set to move another way
  const moving = doc.objects.filter(e => e.motion);
  const turned = e => { const x = changes(e, was.get(e.uid)); return x.motion || x.rot || x.scale3d; };
  const trigger = uid => { const t = uid && now.get(uid); return !t ? null : t.i === null ? { checkpoint: ofKind.checkpoint.indexOf(t) } : { i: t.i }; };
  const movers = moving.some(e => e.i === null || turned(e)) || moving.filter(e => e.i !== null).length !== map.moversSaved ? moving.map(e => {
    const { trigger: t, ...rest } = e.motion;
    return { ...refOf(e), motion: { ...structuredClone(rest), trigger: trigger(t) } };
  }) : null;
  // saved shapes that now move: swapped for movers of themselves
  const conversions = saved.filter(e => e.kind === 'shape' && e.cls !== 'InterpActor' && (e.motion || scriptMoves.has(e.uid)))
    .map(e => ({ i: e.i, loc: [...e.loc], rot: [...e.rot], scale3d: [...e.scale3d], scale: e.scale, material: e.surface ?? null }));
  // the editor's notes: names, and which objects are shapes or trigger zones
  const meta = { objects: doc.objects.filter(e => ownId(e) || e.kind === 'shape' || isZone(e))
    .map(e => ({ ref: refOf(e), ...(ownId(e) ? { name: ownId(e) } : {}), ...(e.kind === 'shape' ? { shape: e.shape } : {}), ...(isZone(e) ? { zone: true } : {}) })) };
  let script = null;
  const entitiesChanged = changed.length || removed.length || added.length;
  if (plan && !(doc.script === base.script && !entitiesChanged)) {
    const names = {};
    for (const name of named.keys()) {
      const e = doc.objects.find(x => x.id === name);
      if (!e) throw new Error(`Script: nothing is named "${name}" any more; apply the script again`);
      names[name] = refOf(e);
    }
    script = { source: doc.script, plan, names };
  } else if (!plan && !doc.script.trim() && base.script.trim()) script = { source: '', plan: { clips: [], flags: [], counters: [], rules: [] }, names: {} };
  const hud = json(doc.hud) !== json(base.hud) ? doc.hud : null, lava = checkpoints.filter(c => c.lava).length;
  const n = (k, one, many = `${one}s`) => k && `${k} ${k === 1 ? one : many}`;
  const summary = [n(moved, 'moved', 'moved'), n(lit, 'light set', 'lights set'), n(duplicates.length, 'added', 'added'), n(lights.length, 'new light'), n(triggerZones.length, 'zone'),
    doc.script !== base.script && (doc.script.trim() ? 'the script' : 'no script'), n(shapes.length, 'shape'), n(checkpoints.length - lava, 'checkpoint'), n(lava, 'lava zone'),
    terrain && n(terrain.tiles.length, 'terrain tile'), n(removed.length, 'deleted', 'deleted'), n(respawns.length, 'respawn point'), n(panels.length, 'checkpoint panel'),
    ballSpawn && 'a ball spawn', doc.lighting !== base.lighting && `${LIGHTING[doc.lighting]?.name.toLowerCase() ?? "the map's own"} lighting`, movers && n(movers.length, 'moving shape'),
    hud && (hud.timer || hud.deaths ? `${[hud.timer && 'timer', hud.deaths && 'death counter'].filter(Boolean).join(' and ')} on screen` : 'nothing on screen')].filter(Boolean).join(', ') || 'no changes';
  return [{ edits, duplicates, lights, movers, triggerZones, script, conversions, meta, checkpoints, terrain, removes, shapes, shapeGeometry, shapeMaterial: ctx.lastSurface,
            respawns, panels, surfaces, ballSpawn, lighting: doc.lighting !== base.lighting ? doc.lighting : null, hud, images: doc.images }, summary];
}

// Recipes: what a document changes over the saved one, as JSON. `map` names the map it was made on.
export function recipeOf(base, doc, map = null) {
  const was = new Map(base.objects.map(e => [e.uid, e])), now = new Set(doc.objects.map(e => e.uid));
  const tiles = changedTiles(base.terrain.tiles, doc.terrain.tiles);
  return { rlme: 1, map, name: doc.name, lighting: doc.lighting, hud: doc.hud, script: doc.script, images: doc.images,
           objects: doc.objects.filter(e => e !== was.get(e.uid)), order: doc.objects.map(e => e.uid),
           removed: base.objects.filter(e => !now.has(e.uid)).map(e => e.uid),
           terrain: { base: doc.terrain.base, surface: doc.terrain.surface, tiles: Object.fromEntries(tiles.map(k => [k, doc.terrain.tiles.get(k) ? [...doc.terrain.tiles.get(k)] : null])) } };
}
export function applyRecipe(base, r) {
  const by = new Map(base.objects.map(e => [e.uid, e]));
  for (const e of r.objects) by.set(e.uid, e);
  const gone = new Set(r.removed), order = r.order.filter(uid => by.has(uid) && !gone.has(uid));
  const listed = new Set(order), objects = [...order, ...base.objects.map(e => e.uid).filter(uid => !listed.has(uid) && !gone.has(uid))].map(uid => by.get(uid));
  const tiles = new Map(base.terrain.tiles);
  for (const [k, h] of Object.entries(r.terrain.tiles)) h ? tiles.set(k, Float32Array.from(h)) : tiles.delete(k);
  return { ...base, name: r.name, lighting: r.lighting, hud: r.hud, script: r.script, images: imagesFrom(r.images), objects, terrain: { base: r.terrain.base, surface: r.terrain.surface, tiles } };
}
// pictures in JSON: their pixels as base64
const imagesJSON = images => Object.fromEntries(Object.entries(images).map(([k, img]) => {
  let s = '';
  for (let p = 0; p < img.rgba.length; p += 0x8000) s += String.fromCharCode(...img.rgba.subarray(p, p + 0x8000));
  return [k, { ...img, rgba: btoa(s) }];
}));
const imagesFrom = images => Object.fromEntries(Object.entries(images ?? {}).map(([k, img]) =>
  [k, { ...img, rgba: typeof img.rgba === 'string' ? Uint8Array.from(atob(img.rgba), ch => ch.charCodeAt(0)) : Uint8Array.from(img.rgba) }]));

// Clips: some objects as JSON, placed relative to the middle of their feet. Only what the editor adds travels
// between maps; copies of a map's own objects and its own surfaces stay in that map.
const PORTABLE = new Set(['shape', 'checkpoint', 'lava', 'zone', 'gravity', 'light']);
export function clipOf(doc, uids, map = null) {
  const list = doc.objects.filter(e => uids.includes(e.uid) && !single(e) && (PORTABLE.has(e.kind) || e.i !== null || e.src != null));
  if (!list.length) return null;
  const xs = list.map(e => e.loc), centre = [0, 1, 2].map(k => (Math.min(...xs.map(v => v[k])) + Math.max(...xs.map(v => v[k]))) / 2);
  centre[2] = Math.min(...list.map(e => e.bounds ? worldBox(e).min[2] : e.loc[2]));
  const used = new Set(list.flatMap(e => [e.surface, e.panel?.material].flat()).filter(v => typeof v === 'string' && v.startsWith('image:')));
  return { rlme: 1, map, objects: list.map(e => ({ ...e, loc: e.loc.map((v, k) => v - centre[k]) })),
           images: imagesJSON(Object.fromEntries(Object.entries(doc.images).filter(([k]) => used.has(k)))) };
}
// The document with clip `c` placed with its middle at `at`: [document, new uids, what didn't come along]
export function paste(doc, c, at, map = null) {
  const sameMap = c.map !== null && c.map === map, notes = [], taken = new Set(), uids = new Map();
  const local = v => typeof v === 'number' ? (sameMap ? v : undefined) : v;   // a surface of the map it came from
  const out = [];
  for (const e of c.objects) {
    if (!PORTABLE.has(e.kind) && !sameMap) { notes.push(`${e.name}: a copy of another map's own object`); continue; }
    const copy = copyEntity(doc, e, e.loc.map((v, k) => v + at[k]), taken);
    taken.add(copy.id);
    if (!sameMap) copy.src = undefined;           // a light of another map comes as a new light
    if (copy.surface !== undefined) copy.surface = Array.isArray(copy.surface) ? (sameMap ? copy.surface : undefined) : local(copy.surface) ?? (e.kind === 'shape' ? null : undefined);
    if (copy.panel) copy.panel = { material: local(copy.panel.material) ?? null };
    if (copy.kind === 'lava') copy.floor = null;
    uids.set(e.uid, copy.uid);
    out.push(copy);
  }
  for (const e of out) if (e.motion) e.motion = { ...e.motion, trigger: uids.get(e.motion.trigger) ?? null };
  return [{ ...adding(doc, out), images: { ...doc.images, ...imagesFrom(c.images) } }, out.map(e => e.uid), notes];
}
