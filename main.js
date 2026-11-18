// The editor: the open map and its document, every edit as a new document (undo is the documents before), files in
// and out, the game folder, and the keys. view.js draws the document, panels.js and ui.js show it, ai.js lets AI
// agents build with the same actions.
import { effect, computed } from '@preact/signals';
import { Package } from './ue3.js';
import { blankMap } from './blank.js';
import { LIGHTING, bareName, build, describe, isOriginalGameMap } from './map.js';
import { motionKeys, newMotion } from './motion.js';
import { meshGeometry } from './shapes.js';
import { textureSize } from './texture.js';
import { gameIndex, gameLook, openGame } from './game.js';
import { eventLabel, previewOf, runSandboxed } from './script.js';
import { BALL_REST, GATE, RESPAWN_CLEARANCE, NEW_GRAVITY, adding, applyRecipe, byId, byUid, canMove, checkpointEntity, clipOf, copyEntity, diff, docFrom, floorOf,
         hasPanel, isSolid, isZone, lavaEntity, lavaValues, lightEntity, noteUids, paste, recipeOf, removing, replace, roofSpot, same, settle, shapeEntity, single, zoneEntity } from './doc.js';
import { brushHeights, heightAt, roadHeights, setHeights } from './terrain.js';
import * as V from './view.js';
import { SNAP_STEPS, mountUI, ui } from './ui.js';
import { all, pref, remembered, setPref, stored, storeAll, trust, trusted } from './store.js';
import { docSig, ed, eyeOff, runSig, selSig, settledSig, shapeData } from './state.js';
import { LAVA_FLOOR, abilities, donorSig, groupOf, libRev, mapSig, openGroups, outlineLists, paletteOpen, panelSurface, pieces, selection, surfaceOf, surfaceValue, surfaces } from './panels.js';
import { installAI } from './ai.js';
import { MODEL_FILES, readModel } from './models.js';

const $ = id => document.getElementById(id);
const doc = () => docSig.value;
const setStatus = (text, kind = '') => { ui.status.value = { text, kind }; };
const confirmed = (text, ok, input) => new Promise(answer => { ui.ask.value = { text, ok, answer, input }; });   // ui.js Ask
const nextFrame = () => new Promise(r => setTimeout(r, 30));
const fingerprint = () => `${ed.file ?? 'new map'}:${ed.source?.length}`;   // which map a clip came from: its surfaces only mean something there
const extras = fetch('surfaces.upk').then(r => r.ok ? r.arrayBuffer() : null).then(b => b && new Package(new Uint8Array(b))).catch(() => null);
extras.then(p => { ed.donor = p; donorSig.value = p; V.restyle(); gameLooksSoon(); });

// History: every edit commits a new document; `key` makes edits of one field in a row (dragging through colours,
// typing) one step. A step is {doc, sel}: undo brings back the selection too. Pictures only ever join, so undo keeps them.
let past = [], future = [], lastKey = null;
const now = (d = doc()) => ({ doc: d, sel: selSig.value });
function show(next, live = false) {               // the document drawn and shown; `live`: mid-drag, not kept yet
  next = settle(next);
  docSig.value = next;
  V.sync(next, live);
  if (!live) { settledSig.value = next; keepSoon(); }
  return next;
}
function commit(next, key = null) {
  if (next === doc()) return;
  if (!(key && key === lastKey && !future.length)) past.push(now());
  future = [];
  lastKey = key;
  show(next);
  select(selSig.value, false);
}
function stepBack(from, to) {
  if (!from.length) return;
  to.push(now());
  lastKey = null;
  const step = from.pop();
  show({ ...step.doc, images: doc().images });
  select(step.sel, false);
}
const remember = d => { past.push(now(d)); future = []; lastKey = null; };   // a step made outside commit (drags, strokes)
const undo = () => stepBack(past, future), redo = () => stepBack(future, past);

// The selection: uids, the last one in front. The Map list opens its group and scrolls to it.
function select(uids, reveal = true) {
  const d = doc(), list = [...new Set(uids)].filter(uid => d.objects.some(e => e.uid === uid));
  selSig.value = list;
  V.select(list);
  setMode(ui.mode.value);
  if (!reveal || !list.length) return;
  const [g, sub] = groupOf(byUid(d, list.at(-1)));
  openGroups.value = new Set([...openGroups.value, g, ...(sub ? [`${g}/${sub}`] : [])]);
  ui.reveal.value = { uid: list.at(-1) };
}
const selected = () => selection.value;
const one = () => selected().length === 1 ? selected()[0] : null;
function setMode(mode) {
  const can = abilities(selected());
  if (selected().length && !can.modes.includes(mode)) mode = 'translate';
  ui.mode.value = mode;
  V.setTools(mode, can);
}

// Opening a map: its saved document (docFrom), drawn afresh. A recipe (from the autosave) is put on top.
let sculpting = false;
async function openBytes(bytes, file, recipe = null) {
  let pkg, data;
  try {
    pkg = new Package(bytes);
    data = describe(pkg);
  } catch (err) {
    setStatus(`${file ?? 'The map'}: ${err.message}`, 'warn');
    return false;
  }
  const { doc: base, map } = docFrom(data, file ? file.replace(/\.(udk|upk)$/i, '') + '-edit.udk' : 'my-map.udk');
  if (!file) base.terrain.surface = map.materials.find(m => bareName(m.name) === 'Editor_Grass')?.ref ?? base.terrain.surface;   // a new map's hills: grass, like its ground
  ed.preview?.stop();
  Object.assign(ed, { file, source: bytes, pkg, base, map, lastSurface: map.earthy, preview: null });
  runSig.value = { source: null, plan: null, error: null };
  past = []; future = []; lastKey = null;
  eyeOff.value = new Set();
  setSculpt(false);
  const start = recipe ? applyRecipe(base, recipe) : base;
  noteUids(start);
  mapSig.value = { base, map, file, size: bytes.length };
  selSig.value = [];
  docSig.value = settledSig.value = settle(start);
  V.openMap(doc());
  V.loadMeshes(doc());
  docSig.value = settledSig.value = { ...doc() };   // the panels again, now that meshes' parts are known
  ui.canSculpt.value = !!map.materials.length;
  const spawn = doc().objects.find(e => e.kind === 'spawn');
  const at = spawn?.loc ?? [0, 0, 0];
  V.lookAt(at, file ? [at[0] + 3000, at[1] + 3000, at[2] + 2500] : [at[0] - 1900, at[1] + 1100, at[2] + 900]);
  ui.loading.value = null;
  setTimeout(collectShapes, 0);                   // after the map shows: its shapes join your library
  gameLooksSoon();
  runIfTrusted();
  keepSoon();
  return true;
}
async function openFile(file, ask = true) {       // a map, a clip (.json), a 3D model or a picture
  if (!file) return false;
  if (/\.json$/i.test(file.name)) return pasteClip(JSON.parse(await file.text()));
  if (MODEL_FILES.test(file.name)) return importModel([file]);
  if (/^image\//.test(file.type)) return usePicture(await addPicture(file));
  if (ask && ui.dirty.value && !await confirmed(`Open ${file.name}? Your ${ui.dirty.value} unsaved changes are discarded.`, 'Discard and open')) return false;
  ui.loading.value = `Loading ${file.name}…`;
  await nextFrame();                              // let the message paint before parsing blocks the page
  const ok = await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  if (ok) setStatus(`${doc().objects.length} objects loaded`);
  ui.loading.value = null;
  return ok;
}
// A new map: the blank map (blank.js) with grass for ground
async function newMap(ask = true) {
  if (ask && ui.dirty.value && !await confirmed(`Start a new map? Your ${ui.dirty.value} unsaved changes are discarded.`, 'Discard and start new')) return;
  const donor = await extras, blank = blankMap(), floor = describe(new Package(blank)).actors.find(a => a.mesh === 'Floor').i;
  await openBytes(donor ? build(blank, { surfaces: [{ i: floor, material: 'extra:Editor_Grass' }] }, donor) : blank, null);
  setStatus('New map. Press T to sculpt the ground.');
}

// The Script (script.js): run in a sandbox into a plan, which saving writes as Kismet (rules.js). A script that comes
// with an opened map is shown, not run, until you apply it, unless you ran it here before (store.js trust).
const scriptKind = e => e.kind === 'lava' ? 'lava' : e.kind === 'checkpoint' ? 'checkpoint' : isZone(e) ? 'zone' : e.kind === 'light' ? 'light'
  : canMove(e) ? 'shape' : isSolid(e) ? 'mesh' : 'object';
async function runPlan(source = doc().script) {
  try {
    runSig.value = { source, plan: await runSandboxed(source, Object.fromEntries(doc().objects.map(e => [e.id, scriptKind(e)]))), error: null };
    trust(source).catch(() => {});
  } catch (err) { runSig.value = { source, plan: null, error: err.message }; }
  resetPreview();
  return runSig.value;
}
const planFor = d => runSig.value.source === d.script ? runSig.value.plan : null;
async function runIfTrusted() {
  const text = doc().script;
  if (text.trim() && await trusted(text).catch(() => false) && doc().script === text) runPlan(text);
}
async function scriptReady() {                    // a script typed here and not applied yet is yours: it runs first
  const d = doc();
  if (!d.script.trim() || d.script === ed.base.script || runSig.value.source === d.script) return;
  const r = await runPlan(d.script);
  if (r.error) throw new Error(`Script: ${r.error}`);
}
ui.scriptSource = computed(() => docSig.value?.script ?? '');
ui.scriptStatus = computed(() => {
  const r = runSig.value, d = docSig.value, ran = d && r.source === d.script;
  return { error: ran && !!r.error, text: ran && r.error ? r.error : ran && r.plan ? `${r.plan.rules.length} rules, ${r.plan.clips.length} movements; saved with the map`
    : d?.script.trim() ? 'Not run yet: Apply runs it (it is code from this map)' : 'No script' };
});
ui.scriptEvents = computed(() => {
  const plan = docSig.value && planFor(docSig.value), seen = new Map();
  for (const r of plan?.rules ?? []) if (!['finished', 'reversed', 'after', 'every'].includes(r.event.on)) seen.set(JSON.stringify(r.event), r.event);
  return [...seen.values()].map(event => ({ label: eventLabel(event), event }));
});
function resetPreview() {
  ed.preview?.stop();
  $('scriptTexts').replaceChildren();
  const plan = planFor(doc());
  ed.preview = plan && previewOf(plan, {
    track: (name, motion) => { const e = byId(doc(), name); return motionKeys(motion, e.rot, V.moverBox(e)); },
    lightOn: name => byId(doc(), name)?.light?.on ?? true,
    showText({ text, size, at, color }) {         // as the game draws it: offset from the middle of a 1080-high screen
      const k = V.el.clientHeight / 1080, t = Object.assign(document.createElement('div'), { textContent: text,
        className: 'absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-bold text-shadow-md' });
      Object.assign(t.style, { left: `calc(50% + ${at[0] * k}px)`, top: `calc(50% + ${at[1] * k}px)`, fontSize: `${12 * size * Math.max(k, 0.5)}px`, color: `rgb(${color.join(',')})` });
      $('scriptTexts').append(t);
      return () => t.remove();
    },
  });
}
function startPreview() {
  resetPreview();
  if (!ed.preview) return setStatus(runSig.value.error ? 'Fix the script first.' : 'Apply the script first.', 'warn');
  ed.preview.start();
}

// Placing things where you look
const target = () => V.fromThree(V.orbit.target);
const LIGHT_AIM = { point: [0, 0, 0], spot: [-16384, 0, 0], sun: [-8192, 8192, 0], sky: [0, 0, 0] };   // a spot shines straight down
const LIGHT_LIFT = { point: 400, spot: 1000, sun: 3000, sky: 3000 };   // how far over the point you look at a new one goes
const NEW_LIGHT = {
  point: { color: [255, 255, 255], brightness: 2, radius: 2000, shadows: false, on: true },
  spot: { color: [255, 255, 255], brightness: 3, radius: 3000, inner: 15, outer: 30, shadows: false, on: true },
  sun: { color: [255, 255, 255], brightness: 0.5, shadows: false, on: true },
  sky: { color: [255, 255, 255], brightness: 0.3, shadows: false, on: true },
};
const zone = () => ed.map.zone;
function place(list) {
  commit(adding(doc(), list));
  select(list.map(e => e.uid));
  return list.at(-1);
}
function newShape(d, key, loc, rot = [0, 0, 0], scale3d = [1, 1, 1], rest = true) {   // rest: on the point it is at
  const geo = V.shapeGeometry(key);
  if (!geo) return null;
  const { min, max } = geo.boundingBox, c = [0, 1, 2].map(k => (min.getComponent(k) + max.getComponent(k)) / 2), h = [0, 1, 2].map(k => (max.getComponent(k) - min.getComponent(k)) / 2);
  const lib = key.startsWith('lib:') ? ed.library.get(key.slice(4)) : null;
  return shapeEntity(d, key, lib ? lib.name : key.slice(4), [c[0], c[2], c[1], h[0], h[2], h[1]], rest ? [loc[0], loc[1], loc[2] - min.y] : loc, rot, scale3d,
                     lib?.image ? lib.imageValue : ed.lastSurface);   // an imported model wears its own texture
}
const zoneAt = () => { const loc = target(); loc[2] += zone().bounds[5] - 50; return loc; };   // a zone resting on the point you look at
function addFromPalette(value = ui.picked.value) {
  if (!value) return setStatus('Pick a shape in the list first.', 'warn');
  if ((value.startsWith('cp:') || value.startsWith('zone:') || value === 'lava') && !zone()) return setStatus('This map has no trigger zone to copy.', 'warn');
  const d = doc(), b = zone()?.bounds;
  if (value.startsWith('cp:')) return place([checkpointEntity(d, ed.map, value.split(':')[1] === 'ball', zoneAt(), [0, 0, 0], false, [value.endsWith(':gate') ? GATE / (2 * b[3]) : 1, 1, 1])]);
  if (value === 'lava') return addLava();
  if (value === 'zone:gravity') { const loc = zoneAt(); return place([zoneEntity(d, ed.map, [loc[0], loc[1], loc[2] + b[5]], [0, 0, 0], [2, 2, 2], NEW_GRAVITY)]); }
  if (value.startsWith('zone:')) return place([zoneEntity(d, ed.map, zoneAt(), [0, 0, 0], [value.endsWith('gate') ? GATE / (2 * b[3]) : 1, 1, 1])]);
  if (value.startsWith('light:')) {
    const kind = value.slice(6), loc = target();
    return place([lightEntity(d, kind, [loc[0], loc[1], loc[2] + LIGHT_LIFT[kind]], LIGHT_AIM[kind], { kind, ...NEW_LIGHT[kind] })]);
  }
  if (value.startsWith('piece:')) return pasteClip(pieces.value[+value.slice(6)].clip);
  if (value.startsWith('map:')) {
    const template = d.objects.find(e => e.i === +value.slice(4));
    return template && place([copyEntity(d, template, target())]);
  }
  const lib = ed.library.get(value.slice(4));
  if (lib?.image) addImage(lib.imageValue, lib.image);
  const s = newShape(doc(), value, target());
  return s ? place([s]) : setStatus('That shape is no longer in your library.', 'warn');
}
function placeSnapped() {                         // with snapping on, what you place lands with its lower corner on the grid
  const placed = addFromPalette();
  if (!ui.snap.value || !placed?.uid || !V.meshOf(placed.uid)) return;
  const { min } = V.meshBox(placed.uid), step = ui.snapStep.value;
  commit(replace(doc(), selected().map(e => ({ ...e, loc: [e.loc[0] + Math.round(min[0] / step) * step - min[0], e.loc[1] + Math.round(min[1] / step) * step - min[1], e.loc[2]] }))));
}
// Floor is lava: a flat zone over the whole floor that resets you when touched, by the car or the ball. The floor
// itself takes the lava texture when it can take a surface; else the zone gets a fiery panel. The spawn gets a
// platform to start on (the spawn counts as the first checkpoint); a ball reset in front of the car lands on it too.
function addLava() {
  const other = doc().objects.find(e => e.kind === 'lava');
  if (other) { select([other.uid]); return setStatus('The floor is lava already: pick what resets in the Inspector.', 'warn'); }
  const spawn = doc().objects.find(e => e.kind === 'spawn'), hit = spawn && V.floorHit(spawn.loc), floor = hit && byUid(doc(), V.hitUid(hit));
  if (!floor) return setStatus('Found no floor under the spawn to cover with lava.', 'warn');
  const [loc, scale3d] = lavaValues(V.meshBox(floor.uid), hit.point.y, zone().bounds);
  let d = doc();
  const textured = !!V.donorRef(LAVA_FLOOR) && surfaceOf(floor, d) !== undefined;
  if (textured) d = floorSurface(d, floor, LAVA_FLOOR);
  d = adding(d, [newShape(d, 'std:Platform', [spawn.loc[0], spawn.loc[1], hit.point.y], [0, 0, 0], [1, 1, 1], false)]);
  d = settleSpawn(d);                             // onto the platform
  const lava = { ...lavaEntity(d, ed.map, loc, scale3d, { car: true, ball: true }, textured ? floor.uid : null), panel: textured ? null : { material: null } };
  commit(adding(d, [lava]));
  select([lava.uid]);
  setStatus('Lava over the floor, and a platform under the spawn to start on. Raise ground or add shapes above it to build the course.', 'ok');
}
function floorSurface(d, floor, v) {              // the floor's surface on every part (undefined: its own again)
  const parts = V.partsOf(floor);
  return replace(d, [{ ...floor, surface: v !== undefined && parts?.length > 1 ? parts.map(() => v) : v }]);
}
function settleSpawn(d) {                         // the spawn rests on what is under it, like a respawn spot
  V.sync(d, true);
  const s = d.objects.find(e => e.kind === 'spawn'), ground = s && V.groundUnder([s.loc[0], s.loc[1], s.loc[2] + 150], 5000);
  return ground === null || !s ? d : replace(d, [{ ...s, loc: [s.loc[0], s.loc[1], ground + RESPAWN_CLEARANCE] }]);
}
function settleBall(d) {                          // let go over the spawn car: on its roof; elsewhere on the ground under it
  V.sync(d, true);
  const ball = d.objects.find(e => e.kind === 'ball'), start = d.objects.find(e => e.kind === 'spawn'), at = ball.loc;
  const onRoof = !!start && Math.hypot(at[0] - start.loc[0], at[1] - start.loc[1]) < 100, ground = V.groundUnder([at[0], at[1], at[2] + 150], 5000);
  return replace(d, [{ ...ball, placed: true, onRoof, loc: onRoof ? roofSpot(start) : ground === null ? at : [at[0], at[1], ground + BALL_REST] }]);
}

// The selection: copies, arrays, the clipboard, pieces, deleting
function copies(list, offset, times = 1) {
  const taken = new Set(), out = [];
  for (let k = 1; k <= times; k++) for (const e of list) {
    const c = copyEntity(doc(), e, e.loc.map((v, j) => v + k * offset[j]), taken);
    taken.add(c.id);
    out.push(c);
  }
  return out;
}
function duplicate() {
  const list = selected().filter(e => !single(e));
  if (!list.length) return;
  const box = V.unionBox(list.map(e => V.meshOf(e.uid))), width = box.max.x - box.min.x;
  place(copies(list, [ui.snap.value ? width : Math.max(width * 1.2, 300), 0, 0]));   // snapping: right against it
}
function makeArray(count, offset) {               // `count` more of the selection, each `offset` from the one before
  const list = selected().filter(e => !single(e)), n = Math.round(+count), by = offset.map(Number);
  if (!list.length || !(n >= 1 && n <= 200) || by.some(Number.isNaN)) return setStatus('An array is 1 to 200 copies, each offset by a distance.', 'warn');
  place(copies(list, by, n));
  setStatus(`${n * list.length} copies, ${Math.round(Math.hypot(...by))} units apart.`, 'ok');
}
function remove() {
  const list = selected().filter(e => !single(e));
  if (!list.length) return;
  let d = removing(doc(), list.map(e => e.uid));
  for (const e of list) if (e.kind === 'lava' && e.floor) { const f = byUid(d, e.floor); if (f) d = floorSurface(d, f, undefined); }   // the floor shows its own again
  select([]);
  commit(d);
}
let clipboard = null;
async function copySelection() {
  const clip = clipOf(doc(), selSig.value, fingerprint());
  if (!clip) return setStatus('Nothing to copy: the spawn and the ball stay where they are.', 'warn');
  clipboard = clip;
  await navigator.clipboard?.writeText(JSON.stringify(clip)).catch(() => {});
  setStatus(`${clip.objects.length} copied: ⌘V puts them where you look, in this map or another.`, 'ok');
}
async function pasteFromClipboard() {
  const text = await navigator.clipboard?.readText().catch(() => null);
  let clip = clipboard;
  try { const c = JSON.parse(text); if (c?.rlme && Array.isArray(c.objects)) clip = c; } catch { /* not ours: the last copy here */ }
  if (!clip) return setStatus('Nothing copied yet.', 'warn');
  pasteClip(clip);
}
function pasteClip(clip) {
  if (!clip?.rlme || !Array.isArray(clip.objects)) return setStatus('That is not a piece of a map.', 'warn');
  if (clip.objects.some(e => ['checkpoint', 'lava', 'zone', 'gravity'].includes(e.kind)) && !zone()) return setStatus('This map has no trigger zone to copy for checkpoints and zones.', 'warn');
  const at = target(), [d, uids, notes] = paste(doc(), clip, at, fingerprint());
  for (const e of clip.objects) if (e.kind === 'shape' && e.shape.startsWith('lib:') && !ed.library.has(e.shape.slice(4))) notes.push(`${e.name}: not in this browser's shape library`);
  const fixed = d.objects.filter(e => uids.includes(e.uid)).map(e => e.kind === 'shape' && e.surface === null ? { ...e, surface: ed.lastSurface } : e)
    .map(e => e.kind === 'shape' && !shapeData(e.shape) ? null : e);
  const kept = fixed.filter(Boolean), dropped = new Set(uids.filter((uid, k) => !fixed[k]));
  commit(removing(replace(d, kept), [...dropped]));
  select(kept.map(e => e.uid));
  setStatus(`${kept.length} placed${notes.length ? `; left out: ${notes.join('; ')}` : ''}`, notes.length ? 'warn' : 'ok');
  return true;
}
async function savePiece() {
  const clip = clipOf(doc(), selSig.value, fingerprint());
  if (!clip) return setStatus('Select what the piece holds first.', 'warn');
  const name = await confirmed('Name the piece: it shows under Add > Your pieces, in every map.', 'Save piece', one()?.id ?? `Piece ${pieces.value.length + 1}`);
  if (!name?.trim()) return;
  pieces.value = [...pieces.value.filter(p => p.name !== name.trim()), { name: name.trim(), clip }];
  remembered('pieces', pieces.value).catch(() => setStatus('Pieces are not kept in this browser (storage blocked).', 'warn'));
  setStatus(`Saved the piece ${name.trim()}.`, 'ok');
}
function deletePiece(value) {
  pieces.value = pieces.value.filter((_, k) => `piece:${k}` !== value);
  ui.picked.value = null;
  remembered('pieces', pieces.value).catch(() => {});
}
async function exportPiece() {                    // the selection as a file to share; opening or dropping it places it
  const clip = clipOf(doc(), selSig.value, fingerprint());
  if (!clip) return setStatus('Select what to export first.', 'warn');
  await saveFile(`${one()?.id ?? 'piece'}.json`, new TextEncoder().encode(JSON.stringify(clip)), { description: 'Map piece', accept: { 'application/json': ['.json'] } });
}

// The Inspector's edits (ui.js act), checked here
const edit = (fn, key = null) => { const e = one(); if (e) { const next = fn(e); if (next) commit(replace(doc(), [next].flat()), key && `${e.uid}:${key}`); } };
function setTransform(f, k, raw) {
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return;
  edit(e => {
    const c = { ...e, loc: [...e.loc], rot: [...e.rot], scale3d: [...e.scale3d] };
    if (f === 'loc') c.loc[k] = v;
    if (f === 'rot') c.rot[k] = Math.round(v * 65536 / 360);
    if (f === 'scale') c.scale3d[k] = v / e.scale;
    return e.kind === 'ball' ? { ...c, placed: true, onRoof: false } : c;
  });
}
const LIGHT_RANGE = { brightness: [0, 100], radius: [10, 100000], outer: [1, 89], inner: [0, 89] };
function setLight(field, raw) {
  /** @type {any} */
  const v = typeof raw === 'boolean' ? raw : field === 'color' ? [1, 3, 5].map(k => parseInt(raw.slice(k, k + 2), 16))
    : Math.min(LIGHT_RANGE[field][1], Math.max(LIGHT_RANGE[field][0], parseFloat(raw)));
  if (Number.isNaN(v)) return;
  edit(e => {
    if (!e.light) return null;
    const l = { ...e.light, [field]: v };
    if (field === 'outer') l.inner = Math.min(l.inner, v);
    if (field === 'inner') l.outer = Math.max(l.outer, v);
    return { ...e, light: l };
  }, `light:${field}`);                           // dragging through colours is one step to undo
}
function setGravity(raw) {
  const v = Math.min(20000, Math.max(-20000, parseFloat(raw)));
  if (!Number.isNaN(v)) edit(e => e.kind === 'gravity' && v !== e.gravity ? { ...e, gravity: v } : null);
}
const MOTION_RANGE = { steps: [1, 36], angle: [1, 180], seconds: [0.1, 600], pause: [0, 600], delay: [0, 600] };
// an edit from the Inspector's Motion section: 'kind', 'to.<k>', 'spot.<n>.<k>' or a setting, with what the input holds
function setMotion(field, raw) {
  edit(e => {
    const was = e.motion;
    if (field === 'kind') return { ...e, motion: raw ? { ...newMotion(raw), ...(was ? { pause: was.pause, delay: was.delay, once: was.once, trigger: was.trigger } : {}) } : null };
    if (!was) return null;
    const [lo, hi] = MOTION_RANGE[field] ?? [-Infinity, Infinity], num = Math.min(hi, Math.max(lo, parseFloat(raw)));
    if (typeof raw === 'string' && /^(to|spot)\.|^(steps|angle|seconds|pause|delay)$/.test(field) && Number.isNaN(num)) return null;
    const m = structuredClone(was), [part, a, b] = field.split('.');
    if (part === 'to') m.to[+a] = num;
    else if (part === 'spot') m.points[+a][+b] = num;
    else if (part === 'trigger') m.trigger = raw === '' ? null : raw;
    else m[part] = typeof raw === 'boolean' ? raw : part in MOTION_RANGE ? (part === 'steps' ? Math.round(num) : num) : raw;
    if (m.kind === 'slide' && m.back === 'start') m.back = 'same';
    return { ...e, motion: m };
  }, `motion:${field.replace(/\.\d+$/, '')}`);
  V.restartMotion();
}
const addSpot = () => edit(e => e.motion && { ...e, motion: { ...e.motion, points: [...e.motion.points, e.motion.points.at(-1).map((v, k) => v + (k === 0 ? 1000 : 0))] } });
const dropSpot = () => edit(e => e.motion?.points.length > 1 && { ...e, motion: { ...e.motion, points: e.motion.points.slice(0, -1) } });
const setGate = gate => edit(e => e.kind === 'checkpoint' && { ...e, scale3d: [gate ? GATE / (2 * e.bounds[3] * e.scale) : e.scale3d[1], e.scale3d[1], e.scale3d[2]] });
const setPanel = on => edit(e => ({ ...e, panel: on ? { material: e.savedPanel?.material ?? panelSurface(e.kind === 'lava') } : null }));
const setTitle = text => edit(e => e.kind === 'checkpoint' && e.title !== undefined && { ...e, title: text.trim() }, 'title');
const setLava = (key, on) => edit(e => e.kind === 'lava' && { ...e, lava: { ...e.lava, [key]: on } });
const setBallOnTop = top => edit(e => e.kind === 'checkpoint' && e.ball && { ...e, ballOnTop: top });
function setSurface(raw) {
  const v = surfaceValue(raw), e = one();
  if (!e) return;
  const floor = e.kind === 'lava' && e.floor && byUid(doc(), e.floor);
  if (floor) return commit(floorSurface(doc(), floor, v));
  if (e.kind === 'shape') ed.lastSurface = v;
  edit(x => hasPanel(x) ? x.panel && { ...x, panel: { material: v } } : { ...x, surface: v });
}
function setPartSurface(k, raw) {
  const v = surfaceValue(raw);
  edit(e => { const groups = V.partsOf(e); return { ...e, surface: groups.map((g, j) => j === k ? (v === g.material ? 0 : v) : (e.surface ?? e.materials ?? [])[j] || 0) }; });
}
async function rename(raw) {                      // the Inspector's Name
  const v = raw.trim(), e = one();
  if (!e) return;
  if (!/^[\w-]{1,40}$/.test(v)) return setStatus('A name is 1 to 40 letters, digits, - or _.', 'warn');
  if (doc().objects.some(x => x !== e && x.id === v)) return setStatus(`Something else is already named ${v}.`, 'warn');
  commit(replace(doc(), [{ ...e, id: v }]));
  V.relabel();
  if (planFor(doc()) || runSig.value.source === doc().script) await runPlan();   // names may now resolve differently
}
const setLighting = mood => commit({ ...doc(), lighting: mood });
const setHud = (key, on) => commit({ ...doc(), hud: { ...doc().hud, [key]: on } });
const setScriptSource = source => commit({ ...doc(), script: source }, 'script');
const setTerrainSurface = value => commit({ ...doc(), terrain: { ...doc().terrain, surface: typeof value === 'string' ? surfaceValue(value) : value } });
function setGround(raw) {                         // the floor's surface, and the hills' while none is saved (one step)
  const floor = floorOf(doc()), v = surfaceValue(raw);
  if (!floor) return;
  const d = floorSurface(doc(), floor, v);
  commit(ed.map.terrainLocked ? d : { ...d, terrain: { ...d.terrain, surface: v } });
}

// Pictures from this computer, as surfaces ('image:<id>'), and 3D models as shapes
function pictureOf(source, name) {                // {name, width, height, rgba} of an image, at a size the game takes
  const [width, height] = textureSize(source.width, source.height);
  const canvas = Object.assign(document.createElement('canvas'), { width, height }), ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);
  const base = name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'Picture';
  return { name: /^\d/.test(base) ? `Picture_${base}` : base, width, height, rgba: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer) };
}
function addImage(value, img) {                   // a picture joins the document; outside the history, as undo keeps pictures
  if (doc().images[value]) return;
  show({ ...doc(), images: { ...doc().images, [value]: img } });
  for (const step of [...past, ...future]) step.doc = { ...step.doc, images: { ...step.doc.images, [value]: img } };
}
async function addPicture(file) {
  const bitmap = await createImageBitmap(file), img = pictureOf(bitmap, file.name), value = `image:${Date.now()}`;
  addImage(value, img);
  setStatus(`${file.name} is a surface now${img.width !== bitmap.width || img.height !== bitmap.height ? `, as ${img.width}×${img.height} (the game wants powers of two)` : ''}.`, 'ok');
  return value;
}
function pickPicture() {                          // a picture from this computer as a surface: its value, null when none
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.onchange = () => addPicture(input.files[0]).then(resolve, err => { setStatus(`That picture could not be read: ${err.message}`, 'warn'); resolve(null); });
    input.oncancel = () => resolve(null);
    input.click();
  });
}
function usePicture(value) {                      // a dropped picture goes on what is selected, when that takes a surface
  const list = selected().filter(e => surfaceOf(e) !== undefined && !Array.isArray(surfaceOf(e)));
  if (list.length === 1) setSurface(value);
  return true;
}
async function importModel(files) {
  try {
    setStatus(`Reading ${files.find(f => MODEL_FILES.test(f.name))?.name}…`);
    const m = await readModel(files), id = `model:${m.name}`, image = m.image && pictureOf(m.image, `${m.name}_Texture`);
    const item = { id, name: m.name, source: 'Imported', geometry: m.geometry, ...(image ? { image, imageValue: `image:${id}` } : {}) };
    ed.library.set(id, item);
    V.forgetShape(`lib:${id}`);
    libRev.value++;
    stored('shapes', id, item).catch(() => {});
    addFromPalette(`lib:${id}`);
    setStatus(`${m.name}: ${m.geometry.tris.length / 3} triangles, now under Add > Your models${image ? ', with its texture' : ''}${m.notes.length ? ` (${m.notes.join(', ')})` : ''}. The car collides with its shape.`, 'ok');
    return true;
  } catch (err) {
    setStatus(`That model could not be read: ${err.message}`, 'warn');
    return false;
  }
}
function pickModel() {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.glb,.gltf,.obj,.stl,.bin,image/*' });
  input.onchange = () => importModel([...input.files]);
  input.click();
}

// The gizmo moves meshes; once let go, what it did is one step
let dragFrom = null, dragMode = null;
const transformed = (d, list) => replace(d, list.map(t => {
  const e = byUid(d, t.uid);
  return { ...e, loc: t.loc, ...(dragMode === 'rotate' ? { rot: t.rot } : {}), ...(dragMode === 'scale' && e.kind !== 'ball' ? { scale3d: t.scale3d } : {}) };
}));
V.hooks.dragStart = uids => {
  dragFrom = doc();
  dragMode = V.gizmo.mode;
  const ball = doc().objects.find(e => e.kind === 'ball' && uids.includes(e.uid));
  if (ball) show(replace(doc(), [{ ...ball, placed: true, onRoof: false }]), true);
};
V.hooks.drag = list => show(transformed(doc(), list), true);
V.hooks.dragEnd = list => {
  let d = transformed(doc(), list);
  const kinds = new Set(list.map(t => byUid(d, t.uid).kind));
  if (kinds.has('spawn')) d = settleSpawn(d);
  if (kinds.has('ball')) d = settleBall(d);
  const moved = list.some(t => { const a = byUid(d, t.uid), b = byUid(dragFrom, t.uid); return a !== b && !(same(a.loc, b.loc, 1e-6) && same(a.rot, b.rot, 0.5) && same(a.scale3d, b.scale3d, 1e-9)); });
  if (moved) remember(dragFrom);
  show(moved ? d : dragFrom);
  select(selSig.value, false);
};
V.hooks.pick = (uid, add) => {
  if (sculpting) return;
  if (!add) return select(uid ? [uid] : []);
  if (uid) select(selSig.value.includes(uid) ? selSig.value.filter(x => x !== uid) : [...selSig.value, uid]);
};

// Sculpting: a stroke works on its own copy of the tiles it changes, and is one step when let go
let stroke = null;
function setSculpt(on) {
  on = on && !!ed.map && !!ed.map.materials.length;
  if (on) select([]);
  sculpting = on;
  if (sculpting) {
    if (doc().terrain.base === null) show({ ...doc(), terrain: { ...doc().terrain, base: floorHeight() - ed.map.sink } });
  }
  ui.sculpting.value = sculpting;
  V.setBrush(sculpting);
}
function floorHeight() {
  const s = doc().objects.find(e => e.kind === 'spawn'), hit = s && V.floorHit(s.loc);
  return hit ? hit.point.y : s ? s.loc[2] : V.orbit.target.y;
}
V.hooks.strokeStart = (p, invert) => {
  const d = doc(), t = d.terrain;
  stroke = { from: d, tiles: new Map(t.tiles), own: new Set(), touched: new Set(), invert, base: t.base ?? floorHeight() - ed.map.sink,
             level: heightAt(t.tiles, Math.round(p.x / ed.map.cell), Math.round(p.z / ed.map.cell)), path: ui.brushTool.value === 'road' ? [p] : null };
};
function strokeWrite(list) {
  const touched = setHeights(stroke.tiles, list, stroke.own);
  if (!touched.size) return;
  for (const k of touched) stroke.touched.add(k);
  V.strokeTiles({ ...doc().terrain, base: stroke.base, tiles: stroke.tiles }, touched);
  V.brushAgain();
}
V.hooks.strokeStep = (dt, p) => {
  if (!stroke || !p) return;
  if (stroke.path) {                              // roads are laid on release; meanwhile the line shows where the drag went
    if (Math.hypot(p.x - stroke.path.at(-1).x, p.z - stroke.path.at(-1).z) > ed.map.cell) stroke.path.push(p.clone());
    return V.showRoad([...stroke.path, p]);
  }
  const tool = ui.brushTool.value, t = stroke.invert && tool === 'raise' ? 'lower' : stroke.invert && tool === 'lower' ? 'raise' : tool;
  strokeWrite(brushHeights(stroke.tiles, t, p, ui.brushSize.value, ui.brushStrength.value, dt, stroke.level));
};
V.hooks.strokeEnd = p => {
  if (!stroke) return;
  if (stroke.path) {
    if (p) stroke.path.push(p);
    strokeWrite(roadHeights(stroke.tiles, stroke.path, ui.brushSize.value, stroke.base));
  }
  if (stroke.touched.size) {
    remember(stroke.from);
    show({ ...doc(), terrain: { ...doc().terrain, base: stroke.base, tiles: stroke.tiles } });
  }
  stroke = null;
};
function writeHeights(list) {                     // heights [[gx, gy, h]] as one step (AI agents, tests)
  const t = doc().terrain, tiles = new Map(t.tiles);
  if (setHeights(tiles, list, new Set()).size) commit({ ...doc(), terrain: { ...t, base: t.base ?? floorHeight() - ed.map.sink, tiles } });
}

// Saving: the file as opened with what diff() finds changed applied (map.js build)
const changeSet = (d = doc()) => diff(ed.base, d, ed.map, { respawnOf: V.respawnValues, plan: planFor(d), shapeData, panelSurface, lastSurface: ed.lastSurface });
/** @returns {Promise<[Uint8Array<ArrayBuffer>, string]>} [map bytes with every change applied, summary] */
async function editedMap() {
  await scriptReady();
  const [changes, summary] = changeSet();
  return [build(ed.source, changes, await extras), summary];
}
const failed = err => err.name === 'SecurityError'   // the browser wants a fresh click before it shows a file dialog
  ? setStatus('Ready: click that button once more to pick where it goes.', 'ok')
  : err.name !== 'AbortError' && setStatus(err.message, 'warn');   // cancelling a dialog is no error
/** @param {Uint8Array<ArrayBuffer> | (() => Promise<Uint8Array<ArrayBuffer>>)} bytes */
async function saveFile(name, bytes, type) {      // ask for the file first: the browser only allows the dialog right after the click
  const handle = window.showSaveFilePicker ? await showSaveFilePicker({ suggestedName: name, types: [type] }) : null;
  const out = typeof bytes === 'function' ? await bytes() : bytes;
  if (handle) {
    const w = await handle.createWritable();
    await w.write(out);
    await w.close();
  } else {
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([out])), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }
  return handle?.name ?? name;
}
async function save() {
  try {
    let summary = '', size = 0;
    const name = await saveFile(doc().name, async () => {
      setStatus('Saving…');
      await nextFrame();
      const [bytes, s] = await editedMap();
      [summary, size] = [s, bytes.length];
      return bytes;
    }, { description: 'Rocket League map', accept: { 'application/octet-stream': ['.udk'] } });
    setStatus(`Saved ${name} (${summary}; ${(size / 1e6).toFixed(1)} MB)`, 'ok');
  } catch (err) { failed(err); }
}
const SLOT = 'Labs_Underpass_P.upk', BACKUP = 'Labs_Underpass_P.upk.original';
async function gameFolder() {
  if (!window.showDirectoryPicker) throw new Error('Loading into the game needs Chrome or Edge. Use Save as, then copy the file over Labs_Underpass_P.upk in the game folder.');
  let dir = await remembered('game').catch(() => null);
  if (!dir || await dir.requestPermission({ mode: 'readwrite' }) !== 'granted') {
    setStatus('Pick the game folder TAGame/CookedPCConsole (the one with Labs_Underpass_P.upk).');
    dir = await showDirectoryPicker({ id: 'rl-game', mode: 'readwrite' });
  }
  if (!await dir.getFileHandle(SLOT).catch(() => null)) throw new Error(`${dir.name} has no ${SLOT}; pick TAGame/CookedPCConsole in the game folder.`);
  await remembered('game', dir);
  return dir;
}
async function writeFile(dir, name, bytes) {
  const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await out.write(bytes);
  await out.close();
}
const slotNote = s => s ? `Underpass holds ${s.name}, loaded ${new Date(s.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : null;
ui.slot.value = slotNote(pref('slot', null));
async function play() {
  try {
    const dir = await gameFolder();
    if (!await dir.getFileHandle(BACKUP).catch(() => null)) {            // keep the real Underpass before the first swap
      const slot = new Uint8Array(await (await (await dir.getFileHandle(SLOT)).getFile()).arrayBuffer());
      if (isOriginalGameMap(slot)) await writeFile(dir, BACKUP, slot);
    }
    setStatus('Writing the map into the game…');
    await nextFrame();
    const [bytes, summary] = await editedMap();
    await writeFile(dir, SLOT, bytes);
    const name = ed.file ?? doc().name;
    setPref('slot', { name, at: Date.now() });
    ui.slot.value = slotNote(pref('slot', null));
    setStatus(`${name} (${summary}) is in the game: Free Play → Underpass`, 'ok');
  } catch (err) { failed(err); }
}
async function restore() {
  try {
    const dir = await gameFolder();
    const backup = await dir.getFileHandle(BACKUP).catch(() => null);
    if (!backup) return setStatus('No backup of the original Underpass here; verify the game files in your launcher to get it back.', 'warn');
    await writeFile(dir, SLOT, new Uint8Array(await (await backup.getFile()).arrayBuffer()));
    setPref('slot', null);
    ui.slot.value = null;
    setStatus('The original Underpass is back.', 'ok');
  } catch (err) { failed(err); }
}

// Game textures (game.js): the game folder, read-only, remembered from Load into game (or picked here); `ask` (a
// click) may ask for permission or for the folder. Null when not allowed.
async function gameTexturesFolder(ask) {
  let dir = await remembered('game').catch(() => null);
  if (dir && await dir.queryPermission({ mode: 'read' }) !== 'granted' && !(ask && await dir.requestPermission({ mode: 'read' }) === 'granted')) dir = null;
  if (!dir && ask && !window.showDirectoryPicker) throw new Error('Game textures need Chrome or Edge, which can open the game folder.');
  if (!dir && ask) {
    setStatus('Pick the game folder TAGame/CookedPCConsole.');
    dir = await showDirectoryPicker({ id: 'rl-game', mode: 'read' });
    if (!await dir.getFileHandle('TAGame.upk').catch(() => null)) throw new Error(`${dir.name} isn't TAGame/CookedPCConsole in the game folder.`);
    await remembered('game', dir).catch(() => {});   // storage blocked: asked again next time
  }
  return dir;
}
let gameIndexMemo = null;                          // which game package holds each texture and material, until the game's files change
async function gameTexturesIndex(dir, open) {
  const names = [];
  for await (const [name] of dir.entries()) if (/\.upk$/i.test(name) && !/_SF\.upk$/i.test(name)) names.push(name.slice(0, -4));
  const stamp = `${names.length}:${(await (await dir.getFileHandle('TAGame.upk')).getFile()).lastModified}`;
  if (gameIndexMemo?.stamp === stamp) return gameIndexMemo.index;
  const saved = await remembered('gameIndex').catch(() => null);
  const index = saved?.stamp === stamp ? new Map(saved.entries)
    : await gameIndex(names.sort(), name => open(name), (k, n) => setStatus(`Finding the game's textures… ${k + 1} of ${n} packages`));
  if (saved?.stamp !== stamp) await remembered('gameIndex', { stamp, entries: [...index] }).catch(() => {});
  gameIndexMemo = { stamp, index };
  return index;
}
// the package path of game surface `r`: an import of the map, or one of the editor's surfaces that is one (the
// water); null for anything else
function gamePath(r) {
  const [from, at] = typeof r === 'string' ? [ed.donor, V.donorRef(r)] : [ed.pkg, r];
  if (!(at < 0) || !/^Material/.test(from.imports[-at - 1]?.cls ?? '')) return null;
  const path = [];
  for (let q = at; q < 0; q = from.imports[-q - 1].outer) path.unshift(from.imports[-q - 1].name);
  return path;
}
const gameLooksSoon = () => ui.view.value.gameTextures && ed.pkg && useGameLooks(false).catch(err => setStatus(err.message, 'warn'));
async function useGameLooks(ask) {               // read the looks of the game surfaces the map shows, then redraw them
  const map = ed.pkg, dir = await gameTexturesFolder(ask);
  if (!dir) return ask || ui.status.value.text || setStatus('Game textures need the game folder again: turn View > Game textures off and on.');   // a hint: it never covers another message
  const want = [...V.gameWanted].filter(r => !V.gameLooks.has(r) && gamePath(r));
  const read = file => async (offset, size) => new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
  const openOne = name => dir.getFileHandle(`${name}.upk`).then(h => h.getFile()).then(f => openGame(read(f)));
  const opened = new Map(), open = name => {
    if (!opened.has(name.toLowerCase())) opened.set(name.toLowerCase(), openOne(name).catch(() => null));
    return opened.get(name.toLowerCase());
  };
  const cache = async (name, offset, size) => read(await (await dir.getFileHandle(`${name}.tfc`)).getFile())(offset, size);
  const index = want.length ? await gameTexturesIndex(dir, openOne) : null;
  for (const [k, r] of want.entries()) {
    setStatus(`Reading game textures… ${k + 1} of ${want.length}`);
    const look = await gameLook(open, cache, gamePath(r), index).catch(() => null);
    if (ed.pkg !== map) return;                   // another map was opened meanwhile
    V.gameLooks.set(r, look);
  }
  V.forgetSurfaces([...V.gameLooks.keys()]);
  V.restyle();
  const known = [...V.gameLooks.values()].filter(Boolean).length;
  setStatus(`Game textures: ${known} of ${V.gameLooks.size} of the game's surfaces in this map${known < V.gameLooks.size ? '; the rest keep the editor\'s colours' : ''}`, 'ok');
}

// The map being edited is kept in IndexedDB as you work, so a reload brings it back: the opened file (once per file)
// and the recipe of what changed on it (doc.js recipeOf)
let keeping = false, keepTimer = 0, kept = null;
function keepSoon() {                             // a newly opened file at once, edits a moment after the last one
  if (!keeping) return;
  clearTimeout(keepTimer);
  keepTimer = window.setTimeout(keepSession, ed.source && kept?.bytes !== ed.source ? 0 : 250);   // short: a write started as the page unloads gets dropped
}
async function keepSession() {
  clearTimeout(keepTimer);
  keepTimer = 0;
  try {
    const view = { pos: V.camera.position.toArray(), target: V.orbit.target.toArray() };
    const file = kept?.bytes === ed.source ? kept : { id: Date.now(), bytes: ed.source };
    // the file as a Blob: Chrome refuses a byte array this big (Medieval Rings' 674 MB) as one value, not a Blob
    await storeAll('session', [...(file === kept ? [] : [['source', { id: file.id, blob: new Blob([ed.source]) }]]),
      ['map', { v: 2, source: file.id, file: ed.file, recipe: recipeOf(ed.base, doc(), fingerprint()), view }]]);
    kept = file;
  } catch (err) {
    console.warn('The map could not be kept for a reload:', err);
    setStatus(`Your map is not kept for a reload: ${err.message}`, 'warn');
  }
}
async function restoreSession() {
  let back = false;
  try {
    const rec = await stored('session', 'map');
    if (rec?.v === 2) {
      $('bootText').textContent = `Opening ${rec.file ?? 'your map'}…`;
      await nextFrame();                          // shown before parsing blocks the page
      const src = await stored('session', 'source');
      if (src?.id !== rec.source) throw new Error('its file was not kept with it');
      const bytes = new Uint8Array(await src.blob.arrayBuffer());
      kept = { id: src.id, bytes };
      back = await openBytes(bytes, rec.file, rec.recipe);
      if (back) {
        V.camera.position.fromArray(rec.view.pos);
        V.orbit.target.fromArray(rec.view.target);
        const n = ui.dirty.value;
        setStatus(n ? `${rec.file ?? 'Your map'} is back with your ${n} unsaved change${n === 1 ? '' : 's'}. Save as keeps them in a file.` : `${rec.file ?? 'Your map'} is open again.`, 'ok');
      }
    }
  } catch (err) {
    setStatus(`The map from before the reload could not be opened: ${err.message}`, 'warn');
  } finally {
    if (!back) await newMap(false);
    keeping = true;
    keepSoon();
    setTimeout(() => $('app').classList.remove('booting'));
  }
}
window.addEventListener('pagehide', () => { if (keepTimer) keepSession(); });

// Your shape library: geometry of every shape in the maps you open, and the models you import, kept in this browser
// (IndexedDB) and never uploaded. Placed in a map they become new meshes drawn with the chosen Surface.
async function loadLibrary() {
  try {
    for (const item of await all('shapes')) ed.library.set(item.id, item);
    pieces.value = await remembered('pieces') ?? [];
  } catch { /* storage blocked (private window): the library stays empty */ }
  libRev.value++;
}
function collectShapes() {                        // the open map's shapes join the library
  const map = ed.file ?? 'New map', reader = ed.pkg, found = ed.map.palette.filter(p => !ed.library.has(`${map}:${p.mesh}`));
  for (const p of found) {
    try {
      const item = { id: `${map}:${p.mesh}`, name: p.mesh, source: map, geometry: meshGeometry(reader, p.meshIndex) };
      ed.library.set(item.id, item);
      stored('shapes', item.id, item).catch(() => {});
    } catch { /* a mesh this editor can't read stays out */ }
  }
  if (found.length) libRev.value++;
}

// The view's settings, snapping and the left panel's folds
function setSnap(on) { ui.snap.value = on; setPref('snap', on); }
function setSnapStep(step) { ui.snapStep.value = step; setPref('snapStep', step); }
setSnap(!!pref('snap', false));
setSnapStep(SNAP_STEPS.includes(pref('snapStep', 50)) ? pref('snapStep', 50) : 50);
if (pref('gameTextures', false)) ui.view.value = { ...ui.view.value, gameTextures: true };
function setView(key, on) {                       // the View menu
  ui.view.value = { ...ui.view.value, [key]: on };
  if (key === 'gameTextures') {
    setPref('gameTextures', on);
    if (on) return useGameLooks(true).catch(err => { setView(key, false); setStatus(err.name === 'AbortError' ? 'Game textures stay off.' : err.message, 'warn'); });
    V.forgetSurfaces([...V.gameLooks.keys()]);
    V.gameLooks.clear();
    return V.restyle();
  }
  if (key !== 'ids' && key !== 'playMotion') V.filter();   // those two the view reads every frame
}
const outlineActs = {
  setFilter(q) { ui.filter.value = q; V.filter(); },
  outlineRow(uid, add) {
    if (sculpting) setSculpt(false);
    if (eyeOff.value.has(uid)) { eyeOff.value = new Set([...eyeOff.value].filter(x => x !== uid)); V.filter(); }   // picking a hidden one from the list shows it again
    if (add) return select(selSig.value.includes(uid) ? selSig.value.filter(x => x !== uid) : [...selSig.value, uid], false);
    select([uid], false);
    V.focus([uid]);
  },
  outlineEye({ uid, key }) {                      // a row's, or a fold's for all it holds
    const list = key === undefined ? [uid] : outlineLists.get(key), off = new Set(eyeOff.value), hide = !list.every(x => off.has(x));
    for (const x of list) hide ? off.add(x) : off.delete(x);
    eyeOff.value = off;
    if (hide) select(selSig.value.filter(x => !off.has(x)), false);
    V.filter();
  },
  foldOutline(key, open) {                        // remember open groups, except ones a search opened
    if (ui.filter.value.trim() || open === openGroups.value.has(key)) return;
    openGroups.value = new Set(open ? [...openGroups.value, key] : [...openGroups.value].filter(k => k !== key));
  },
  setPaletteFilter(q) { ui.paletteFilter.value = q; },
  foldPalette(key, open) {
    if (ui.paletteFilter.value.trim() || open === paletteOpen.value.has(key)) return;
    paletteOpen.value = new Set(open ? [...paletteOpen.value, key] : [...paletteOpen.value].filter(k => k !== key));
    setPref('addOpen', [...paletteOpen.value]);
  },
};
effect(() => V.setMood(LIGHTING[docSig.value?.lighting]));
effect(() => { ui.view.value; V.relabel(); });

// Keys
const typing = el => el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['range', 'checkbox'].includes(el.type));
window.addEventListener('keydown', e => {
  if (typing(e.target) || ui.ask.value) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (e.ctrlKey && k === 'y') { e.preventDefault(); return redo(); }
  if (mod && k === 's') { e.preventDefault(); return save(); }
  if (mod && k === 'o') { e.preventDefault(); return $('file').click(); }
  if (mod && e.key === 'Enter') { e.preventDefault(); return play(); }
  if (mod && k === 'd') { e.preventDefault(); return duplicate(); }
  if (mod && k === 'c') { e.preventDefault(); return copySelection(); }
  if (mod && k === 'v') { e.preventDefault(); return pasteFromClipboard(); }
  if (mod && k === 'a') { e.preventDefault(); return select(doc().objects.filter(x => V.meshOf(x.uid)?.visible && !single(x) && x.kind !== 'template').map(x => x.uid), false); }
  if (e.key === '?') return toggleHelp();
  if (e.key === 'Escape' && ui.helpOpen.value) return toggleHelp(false);
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return remove(); }
  if (!mod) V.held.add(k);
  if (k === '1') setMode('translate');
  if (k === '2') setMode('rotate');
  if (k === '3') setMode('scale');
  if (k === 'f') V.focus(selSig.value);
  if (k === 'g') setSnap(!ui.snap.value);
  if (k === '[' || k === ']') setSnapStep(SNAP_STEPS[Math.max(0, Math.min(SNAP_STEPS.length - 1, SNAP_STEPS.indexOf(ui.snapStep.value) + (k === ']' ? 1 : -1)))]);
  if (k === 't') setSculpt(!sculpting);
  if (k === 'escape') sculpting ? setSculpt(false) : select([]);
});
// menus close once something in them is picked, or on a click elsewhere
document.addEventListener('click', e => document.querySelectorAll('details.dropdown[open]').forEach(menu => {
  const at = /** @type {HTMLElement} */ (e.target);
  if (!menu.contains(at) || at.closest('.dropdown-content button')) /** @type {HTMLDetailsElement} */ (menu).open = false;
}));
function toggleHelp(on = !ui.helpOpen.value) { ui.helpOpen.value = on; }
$('file').addEventListener('change', e => {
  const input = /** @type {HTMLInputElement} */ (e.target), files = [...input.files];
  input.value = '';
  files.some(f => MODEL_FILES.test(f.name)) ? importModel(files) : openFile(files[0]);
});
V.el.addEventListener('dragover', e => e.preventDefault());
V.el.addEventListener('drop', e => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  files.some(f => MODEL_FILES.test(f.name)) ? importModel(files) : openFile(files[0]);
});

const inspectorActs = {
  rename, setTransform, setSurface, setPartSurface, setPanel, setTitle, setLava, setGravity, setBallOnTop, setLight, setMotion, addSpot, dropSpot, setGate,
  duplicate, delete: remove, makeArray, savePiece, exportPiece, copy: copySelection, setLighting, setHud, setTerrainSurface,
};
mountUI({
  newMap, open: () => $('file').click(), undo, redo, pickPicture, pickModel, setGround, save, play, restore,
  setMode: mode => { if (sculpting) setSculpt(false); setMode(mode); }, toggleSculpt: () => setSculpt(!sculpting), setSnap, setSnapStep, setView,
  ...outlineActs, ...inspectorActs, place: placeSnapped, deletePiece,
  toggleScript: () => { ui.scriptOpen.value = !ui.scriptOpen.value; },
  setTool: tool => { ui.brushTool.value = tool; }, setBrushSize: size => { ui.brushSize.value = size; V.showBrush(); },
  setScriptSource, runScript: () => runPlan(), startPreview, fireEvent: e => ed.preview?.fireEvent(e),
});
setMode('translate');
setTimeout(() => $('app').classList.remove('booting'), 15000);   // never stuck loading, whatever the storage does
loadLibrary();
restoreSession();

const api = { doc, commit, select, selected, place, newShape, addLava, settleSpawn, settleBall, floorSurface, newMap, runPlan, planFor, changeSet, setStatus,
              writeHeights, nextFrame, LIGHT_AIM, NEW_LIGHT, surfaces, surfaceOf };
installAI(api);
window.editor = { doc, select, acts: { ...inspectorActs, setGround, place: addFromPalette }, undo, redo, changeSet, editedMap, openFile, newMap, addPicture,
                  writeHeights, pasteClip, copy: () => clipOf(doc(), selSig.value, fingerprint()), importModel, setSculpt, view: V };
