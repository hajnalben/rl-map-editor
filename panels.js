// What the panels show, computed from the document and the selection (ui.js draws it): the Map list, the Add
// palette, the Inspector, the surface lists and the change count. Nothing here changes the map.
import { computed, signal } from '@preact/signals';
import { LIGHTING, bareName } from './map.js';
import { LIGHT_KINDS } from './lights.js';
import { MOTIONS } from './motion.js';
import { BUILT_IN } from './shapes.js';
import { BALL_AHEAD } from './kismet.js';
import { GATE_PAST, countChanges, floorOf, hasPanel, isGate, isVolume, isZone, ownName, single } from './doc.js';
import { donorRef, partsOf } from './view.js';
import { docSig, ed, eyeOff, selSig, settledSig } from './state.js';
import { ui } from './ui.js';
import { pref } from './store.js';

export const mapSig = signal(null);               // {base, map, file, size} of the open map
export const donorSig = signal(null);             // surfaces.upk, once loaded
export const libRev = signal(0);                  // the shape library changed
export const pieces = signal([]);                 // saved pieces: [{name, clip}]
export const openGroups = signal(new Set(['Checkpoints', 'Lava', 'Shapes']));
export const paletteOpen = signal(new Set(pref('addOpen', ['Checkpoints', 'Lights', 'Library'])));

// The editor's own surfaces, offered in every map (surfaces.upk, made by surfaces.mjs) and copied into it when used:
// value 'extra:<material name>'
export const EXTRA_SURFACES = { Editor_Lava: 'Lava', Lake_01_Mat: 'Water (Deadeye Canyon lake)', Editor_Grass: 'Grass' };
export const LAVA_FLOOR = 'extra:Editor_Lava';
// see-through glass when the map has some, so a gate shows without hiding the view; for lava something fiery.
// 'lava' is a red copy of a surface, made when the map is saved.
const fiery = name => /lava|magma|fire|ember|orange/i.test(name) || /(?<![a-z])red|Red/.test(name);   // not "Colored"
export const surfaceValue = v => v === 'lava' || v.startsWith('extra:') || v.startsWith('image:') ? v : +v;
// [{value, text, group?}]: the map's surfaces, a red lava copy when it has none, the editor's surfaces it lacks, your pictures
export const surfaces = computed(() => {
  const m = mapSig.value, images = docSig.value?.images ?? {}, donor = donorSig.value;
  if (!m) return [];
  const own = m.map.materials.map(x => ({ value: x.ref, text: EXTRA_SURFACES[bareName(x.name)] ?? x.name }));
  const list = [...own, ...(m.map.tintable && !m.map.materials.some(x => fiery(x.name)) ? [{ value: 'lava', text: `Lava red (a red copy of ${m.map.tintable})` }] : [])];
  const shown = () => new Set(list.flatMap(o => [o.text, String(o.value), bareName(String(o.text))]));   // a copy the map has shows under the same label
  if (donor) list.push(...Object.entries(EXTRA_SURFACES).filter(([name, label]) => donorRef(`extra:${name}`) && !shown().has(label) && !shown().has(`extra:${name}`))
    .map(([name, label]) => ({ value: `extra:${name}`, text: label, group: 'More surfaces' })));
  const seen = shown();
  list.push(...Object.entries(images).filter(([value, img]) => !seen.has(value) && !seen.has(img.name)).map(([value, img]) => ({ value, text: img.name, group: 'Your pictures' })));
  return list;
});
export function panelSurface(lava = false) {      // what a new visible panel shows
  const options = surfaces.value;
  const look = (lava && options.find(o => o.value === LAVA_FLOOR || o.text === EXTRA_SURFACES.Editor_Lava)) || options.find(o => lava ? fiery(o.text) : /glass/i.test(o.text));
  return look ? look.value : ed.lastSurface;
}
// The surface the inspector offers for `e`, or undefined when there is none to pick: a lava's floor, a zone's
// visible panel, a shape, or a saved mesh's (an array, one per part, when it has several). A saved mesh of several
// parts keeps `surface` as the component writes it: per part, 0 for the mesh's own.
export function surfaceOf(e, doc = docSig.value) {
  const floor = e.kind === 'lava' && e.floor && doc.objects.find(x => x.uid === e.floor);
  if (floor) { const s = surfaceOf(floor, doc); return Array.isArray(s) ? s[0] : s; }
  if (hasPanel(e)) return e.panel ? e.panel.material ?? panelSurface(e.kind === 'lava') : undefined;
  if (e.kind === 'shape') return e.surface ?? ed.lastSurface;
  const groups = partsOf(e);
  if (e.cls !== 'StaticMeshActor' || !groups) return undefined;
  return groups.length <= 1 ? e.surface ?? (e.materials[0] || groups[0]?.material || null) : groups.map((g, k) => (e.surface ?? e.materials)[k] || g.material);
}
// what a Surface list shows for `v`: a label of its own when the list lacks it (a part's own material, say)
export const surfaceChoice = v => ({ value: v, missing: typeof v === 'number' && v && !surfaces.value.some(o => o.value === v) ? ed.pkg.ref(v) : null });

// What the inspector and gizmo offer: the spawn car turns only about its yaw and never scales, the ball spawn only
// moves, objects without a shape (lights, markers) don't scale; several at once only what each allows.
export function abilities(list) {
  const one = e => e.kind === 'ball' ? { modes: ['translate'], yawOnly: false } : e.kind === 'spawn' ? { modes: ['translate', 'rotate'], yawOnly: true }
    : e.kind === 'light' ? { modes: ['spot', 'sun'].includes(e.light.kind) ? ['translate', 'rotate'] : ['translate'], yawOnly: false }
    : { modes: e.bounds || isVolume(e) ? ['translate', 'rotate', 'scale'] : ['translate', 'rotate'], yawOnly: false };
  const each = list.map(one);
  return { modes: ['translate', 'rotate', 'scale'].filter(m => each.length && each.every(c => c.modes.includes(m))), yawOnly: each.some(c => c.yawOnly) };
}
export const selection = computed(() => { const doc = docSig.value, ids = selSig.value; return doc ? ids.map(uid => doc.objects.find(e => e.uid === uid)).filter(Boolean) : []; });
ui.modes = computed(() => selection.value.length ? abilities(selection.value).modes : null);

function checkpointName(e) {
  return e.title || `${e.ball ? 'Ball' : 'Car'} ${isGate(e) ? 'gate' : 'checkpoint'} at ${e.loc.slice(0, 2).map(Math.round).join(', ')}`;
}
export const canMoveIt = e => e.kind === 'shape' || !!e.mover;
function motionOf(e, doc) {                       // the Inspector's Motion settings (ui.js Motion), null when it can't move
  if (!canMoveIt(e)) return null;
  const m = e.motion;
  if (!m) return { kind: '', kinds: MOTIONS };
  const checkpoints = doc.objects.filter(c => c.kind === 'checkpoint');
  return { kind: m.kind, kinds: MOTIONS, to: (m.to ?? [0, 0, 0]).map(Math.round), points: m.points?.map(p => p.map(Math.round)) ?? [],
           back: m.back ?? 'same', axis: m.axis ?? 'yaw', steps: m.steps ?? 1, reverse: !!m.reverse, angle: m.angle ?? 45, hinge: m.hinge ?? 'top',
           seconds: m.seconds, pause: m.pause, smooth: m.smooth, delay: m.delay, once: m.once,
           triggers: [['', 'With the map'], ...checkpoints.map(c => [c.uid, `When ${checkpointName(c)} is touched`])],
           trigger: m.trigger && checkpoints.some(c => c.uid === m.trigger) ? m.trigger : '' };
}
function infoOf(e) {                              // the Inspector's heading: what `e` is and does
  const own = e.i === null ? '(new)' : e.name;
  if (e.kind === 'spawn') return { title: 'Spawn', note: e.name, text: 'Where your car starts, facing the way it points, and comes back to on resets until you reach a checkpoint. Drag it anywhere: it settles just above the ground under it.' };
  if (e.kind === 'ball') return { title: e.placed ? 'Ball spawn' : 'Ball start', note: null, text: `${e.placed
    ? `Where the ball starts, and comes back to on resets until you reach a checkpoint${e.onRoof ? ": on the spawn car's roof, following the car" : ''}.`
    : 'Where the game puts the ball now.'} Drag it to give the ball a spawn of its own: let go over the car to start on its roof, anywhere else to rest on the ground.` };
  if (e.kind === 'shape') {
    const from = e.shape.startsWith('std:') ? 'built-in shape' : e.shape.startsWith('lib:model:') ? 'imported model' : 'from ' + (ed.library.get(e.shape.slice(4))?.source ?? 'your library');
    return { title: e.name, note: `(${from})`, text: `${e.i === null ? 'A new mesh' : 'A shape added in the editor'}; the car collides with ${e.motion ? 'its box, as it moves' : 'its shape'}.` };
  }
  if (e.kind === 'lava') return { title: 'Lava', note: own, text: [e.lava.car && 'When your car touches it, it goes back to the last checkpoint, as after a reset.',
    e.lava.ball && 'When the ball touches it, the car goes back to the last checkpoint with a fresh ball (in front of the car after a car checkpoint).', 'Before the first checkpoint, that is the spawn.'].filter(Boolean).join(' ') };
  if (e.kind === 'checkpoint') {
    const gate = isGate(e);
    return { title: `${e.ball ? 'Ball' : 'Car'} ${gate ? 'gate' : 'checkpoint'}`, note: own, text: `${e.ball
      ? `Becomes your respawn point when the ball ${gate ? 'passes through' : 'gets into'} it.`
      : `Becomes your respawn point when your car ${gate ? 'passes through' : 'drives or flies into'} it.`} After a reset the car appears ${gate ? `just past the gate (${GATE_PAST} units)` : 'inside it'}, on the ground when it reaches some, facing the arrow${e.ball
      ? `, with the new ball ${e.ballOnTop ? 'just over the roof' : `${BALL_AHEAD} units ahead`}` : ''}: the ghosts show where.` };
  }
  if (e.kind === 'gravity') return { title: 'Gravity zone', note: own, text: "Inside it, the car and ball fall with this gravity instead of the map's (Rocket League's is −650): less floats, more is heavy, above 0 pulls up." };
  if (e.kind === 'zone') return { title: 'Trigger zone', note: own, text: `Sets off script events when the car or ball goes in or out: zone('${e.id}').enter('car'), .leave(). Nothing happens unless the Script uses it.` };
  if (e.kind === 'light') return { title: LIGHT_KINDS[e.light.kind].name, note: own, text: {
    point: 'Shines every way, fading out to its radius.',
    spot: "Shines a cone the way it points: rotate it to aim. Full brightness inside the core, fading out to the cone's edge.",
    sun: "Light from far away, the way the arrow points; where it stands doesn't matter.",
    sky: "Even light from all around; where it stands doesn't matter.",
  }[e.light.kind] };
  return { title: e.name, note: null, text: `${e.cls}${e.mesh ? ' · ' + e.mesh : ''}` };
}
function inspect(e, doc) {                        // what the Inspector shows for `e` (ui.js Inspector)
  const can = abilities([e]), l = e.light, lava = e.lava, offered = surfaces.value.length > 0, surface = surfaceOf(e, doc), parts = Array.isArray(surface);
  const untitled = e.title === undefined;
  return {
    info: infoOf(e),
    name: single(e) ? null : e.id,
    transform: { loc: can.modes.length ? e.loc.map(v => Math.round(v)) : null, rot: can.modes.includes('rotate') ? e.rot.map(v => +(v * 360 / 65536).toFixed(1)) : null,
                 scale: can.modes.includes('scale') ? e.scale3d.map(v => +(v * e.scale).toFixed(3)) : null, yawOnly: can.yawOnly },
    surface: offered && surface !== undefined && !parts ? surfaceChoice(surface) : null,
    parts: offered && parts ? surface.map(surfaceChoice) : null,
    zone: e.kind === 'checkpoint' || e.kind === 'lava' || isZone(e) ? {
      gate: e.kind === 'checkpoint' ? isGate(e) : null,
      panel: e.kind !== 'gravity' ? !!e.panel : null,
      title: e.kind === 'checkpoint' ? { value: e.title ?? '', disabled: untitled, placeholder: untitled ? 'Saved without a title' : 'Checkpoint N' } : null,   // untitled: saved before checkpoints had a text
      lava: lava ? { car: lava.car, ball: lava.ball } : null,
      gravity: e.kind === 'gravity' ? e.gravity ?? '' : null,
      ball: e.kind === 'checkpoint' && e.ball ? { onTop: !!e.ballOnTop, old: e.oldBall ? 'Made by an older version of the editor: its ball always drops onto the car' : null } : null,
    } : null,
    light: l ? { color: '#' + l.color.map(v => v.toString(16).padStart(2, '0')).join(''), brightness: +l.brightness.toFixed(3), radius: 'radius' in l ? Math.round(l.radius ?? 0) : null,
                 outer: l.kind === 'spot' ? +(l.outer ?? 0).toFixed(1) : null, inner: l.kind === 'spot' ? +(l.inner ?? 0).toFixed(1) : null, shadows: l.shadows, on: l.on } : null,
    motion: motionOf(e, doc),
    actions: !single(e),
  };
}
const KIND_LABEL = { shape: 'shape', mesh: 'mesh', checkpoint: 'checkpoint', lava: 'lava zone', zone: 'trigger zone', gravity: 'gravity zone', light: 'light', volume: 'volume', marker: 'marker' };
ui.inspect = computed(() => {
  const list = selection.value, doc = docSig.value;
  if (ui.sculpting.value || !list.length) return null;
  if (list.length === 1) return inspect(list[0], doc);
  const counts = new Map();
  for (const e of list) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const label = (k, n) => { const w = KIND_LABEL[k] ?? k; return `${n} ${n === 1 ? w : w === 'mesh' ? 'meshes' : `${w}s`}`; };
  return { many: list.length, kinds: [...counts].map(([k, n]) => label(k, n)).join(', '), actions: list.some(e => !single(e)) };
});
ui.mapProps = computed(() => {
  const m = mapSig.value, doc = docSig.value;
  if (!m || !doc) return { lighting: null, hud: { timer: false, deaths: false }, ground: null };
  const floor = groundOf(doc), ground = floor && surfaceOf(floor, doc);
  return { lighting: m.map.hasSuns ? { value: doc.lighting, options: [['map', 'As the map has it'], ...Object.entries(LIGHTING).map(([k, v]) => [k, v.name])] } : null,
           hud: doc.hud, ground: ground === undefined || ground === null ? null : surfaceChoice([ground].flat()[0]) };
});
export const groundOf = doc => floorOf(doc);     // the floor the Map's Ground surface sets
ui.surfaces = surfaces;
ui.terrain = computed(() => {
  const m = mapSig.value, doc = docSig.value;
  return m && doc ? { options: surfaces.value.filter(o => !o.group || o.group === 'More surfaces'), value: doc.terrain.surface, locked: m.map.terrainLocked } : { options: [], value: null, locked: false };
});
ui.dirty = computed(() => { const m = mapSig.value, doc = docSig.value; return m && doc ? countChanges(m.base, doc, m.map) : 0; });
ui.mapName = computed(() => { const m = mapSig.value; return !m ? '' : m.file ? `${m.file} · ${(m.size / 1e6).toFixed(m.size < 1e7 ? 1 : 0)} MB` : 'New map'; });
ui.mapTitle = computed(() => mapSig.value?.file ?? 'A new map: sculpt the ground and add shapes and checkpoints.');

// The Map list: every object grouped by kind, shapes by their mesh; it follows the selection. • marks what isn't
// saved yet. A fold's eye hides all it holds (outlineLists: fold key -> uids).
const GROUPS = ['Spawn', 'Checkpoints', 'Lava', 'Trigger zones', 'Gravity zones', 'Shapes', 'Lights & atmosphere', 'Volumes', 'Other'];   // the spawn: a row of its own
export function groupOf(e) {                      // [group, sub-group or null]
  if (e.kind === 'lava') return ['Lava', null];
  if (e.kind === 'checkpoint') return ['Checkpoints', null];
  if (isZone(e)) return [e.kind === 'gravity' ? 'Gravity zones' : 'Trigger zones', null];
  if (single(e)) return ['Spawn', null];
  if (/Light|Fog|PostProcess|SceneCapture/.test(e.cls)) return ['Lights & atmosphere', null];   // scene captures make reflections
  if (isVolume(e)) return ['Volumes', null];
  if (e.mesh) return ['Shapes', e.mesh];
  return ['Other', null];
}
export const outlineLists = new Map();
ui.outline = computed(() => {
  const doc = settledSig.value, q = ui.filter.value.trim().toLowerCase(), sel = new Set(selSig.value), off = eyeOff.value, open = openGroups.value;
  if (!doc) return { nodes: [], empty: '' };
  const tree = new Map(GROUPS.map(g => [g, new Map()]));
  for (const e of doc.objects) {
    if (e.kind === 'template') continue;
    const [g, sub] = groupOf(e);
    if (q && !`${e.name} ${e.cls} ${e.mesh || ''} ${e.id} ${g}`.toLowerCase().includes(q)) continue;
    const subs = tree.get(g);
    if (!subs.has(sub ?? '')) subs.set(sub ?? '', []);
    subs.get(sub ?? '').push(e);
  }
  const where = e => e.loc.slice(0, 2).map(v => Math.round(v)).join(', '), numbers = {};
  const label = e => {
    if (e.kind === 'spawn') return `Spawn · ${where(e)}`;
    if (e.kind === 'ball') return `${e.placed ? 'Ball spawn' : 'Ball start'}${e.placed ? ` · ${where(e)}` : ''}`;
    const name = ownName(e);
    if (name) return `${name} · ${where(e)}`;
    if (e.kind !== 'checkpoint' && e.kind !== 'lava') return `${e.name} · ${where(e)}`;
    const kind = e.kind === 'lava' ? 'Lava' : `${e.ball ? 'Ball' : 'Car'} ${isGate(e) ? 'gate' : 'checkpoint'}`;
    numbers[kind] = (numbers[kind] || 0) + 1;
    return `${kind} ${numbers[kind]} · ${where(e)}`;
  };
  const eye = list => ({ some: list.some(e => off.has(e.uid)), every: list.every(e => off.has(e.uid)) });   // hidden in the view only; the saved map keeps it
  const item = (e, text, top = false) => ({ uid: e.uid, text: (e.i === null && e.kind !== 'ball' ? '• ' : '') + text, title: e.name, sel: sel.has(e.uid), top, eye: eye([e]) });
  const fold = (key, text, list, fill) => {
    const shown = !!q || open.has(key);
    outlineLists.set(key, list.map(e => e.uid));
    return { key, text, open: shown, eye: eye(list), children: shown ? fill() : [] };   // closed groups stay empty until opened
  };
  outlineLists.clear();
  const nodes = [];
  for (const [g, subs] of tree) {
    const total = [...subs.values()].reduce((n, list) => n + list.length, 0);
    if (!total) continue;
    if (g === 'Spawn') { nodes.push(...subs.get('').map(e => item(e, label(e), true))); continue; }
    nodes.push(fold(g, `${g} (${total})`, [...subs.values()].flat(), () => [...subs].sort(([x], [y]) => x.localeCompare(y)).flatMap(([sub, list]) =>
      sub ? [fold(`${g}/${sub}`, `${sub} ×${list.length}`, list, () => list.map(e => item(e, where(e))))] : list.map(e => item(e, label(e))))));
  }
  return { nodes, empty: q ? 'No matches' : 'Nothing here yet' };
});

// The Add palette: what can be placed, in folds that only fill once opened
const SKIES = /sky ?dome|fog ?ring/i;
function libraryShapes(file) {                    // without sky domes, and each shape once though many maps have it
  const same = s => `${s.name}|${s.geometry.positions.length}|${s.geometry.tris.length}`, items = [...ed.library.values()];
  const seen = new Set(items.filter(s => s.source === file).map(same));
  return items.filter(s => s.source !== file && !SKIES.test(s.name) && !seen.has(same(s)) && seen.add(same(s)));
}
ui.palette = computed(() => {
  libRev.value;
  const m = mapSig.value, q = ui.paletteFilter.value.trim().toLowerCase(), hit = text => text.toLowerCase().includes(q), open = paletteOpen.value;
  if (!m) return { nodes: [], empty: '' };
  const row = ([value, text, title = text], top = false) => ({ value, text, title, top });
  const fold = (key, text, fill) => { const shown = !!q || open.has(key); return { key, text, open: shown, children: shown ? fill() : [] }; };
  const group = (label, items, count = false) => {
    const found = items.filter(([, text]) => hit(`${label} ${text}`));
    return found.length ? fold(label, `${label}${count ? ` (${found.length})` : ''}`, () => found.map(r => row(r))) : null;
  };
  const shapes = libraryShapes(m.file), imported = shapes.filter(s => s.source === 'Imported'), maps = Map.groupBy(shapes.filter(s => s.source !== 'Imported' && hit(`${s.source} ${s.name}`)), s => s.source.replace(/\.(udk|upk)$/i, ''));
  const folders = [...maps].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const zoned = list => m.map.zone ? list : [];   // these copy a trigger zone, which most maps have
  const nodes = [
    group('Checkpoints', zoned([['cp:car', 'Car · box'], ['cp:car:gate', 'Car · gate'], ['cp:ball', 'Ball · box'], ['cp:ball:gate', 'Ball · gate']])),
    ...zoned([['lava', 'Floor is lava', 'Lava over the whole floor: touching it resets you. What resets is in the Inspector.']]).filter(([, text]) => hit(text)).map(r => row(r, true)),
    group('Zones', zoned([['zone:box', 'Trigger · box', 'A zone for scripts'], ['zone:gate', 'Trigger · gate', 'A zone for scripts'],
                          ['zone:gravity', 'Gravity', 'Gravity of its own inside: lower, heavier or upward']])),
    group('Lights', Object.entries(LIGHT_KINDS).map(([k, v]) => [`light:${k}`, v.name])),
    group('Built-in shapes', Object.keys(BUILT_IN).map(k => [`std:${k}`, k])),
    group('Your models', imported.map(s => [`lib:${s.id}`, s.name, `${s.name} · imported`])),
    group('Your pieces', pieces.value.map((p, k) => [`piece:${k}`, p.name, `${p.name}: ${p.clip.objects.length} objects`])),
    group('This map', m.map.palette.map(p => [`map:${p.template}`, `${p.mesh}  ×${p.count}`]), true),
    folders.length ? fold('Library', `Library · ${folders.length} map${folders.length === 1 ? '' : 's'}`, () => folders.map(([name, list]) =>
      fold(`Library/${name}`, `${name} (${list.length})`, () => list.map(s => row([`lib:${s.id}`, s.name, `${s.name} · ${name}`]))))) : null,
  ].filter(Boolean);
  return { nodes, empty: 'No matches' };
});
