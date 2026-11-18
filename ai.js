// AI agents build maps through window.mapAI (ai-guide.md): steps of JSON in map units and degrees, each one undo step,
// the map's facts back, and camera views to take screenshots of. Objects have ids: the agent's own, or kind#n / map#<export>.
import * as THREE from 'three';
import { LIGHTING } from './map.js';
import { LIGHT_KINDS } from './lights.js';
import { MOTIONS, motionErrors, newMotion, ueAxes } from './motion.js';
import { eventLabel } from './script.js';
import { GATE, RESPAWN_CLEARANCE, BALL_REST, adding, checkpointEntity, floorOf, isZone, lavaEntity, lavaValues, lightEntity, isGate, removing, replace, roofSpot, zoneEntity } from './doc.js';
import * as V from './view.js';
import { ed, shapeData, runSig } from './state.js';
import { ui } from './ui.js';

const AI_SHAPES = { platform: 'Platform', ramp: 'Ramp', pillar: 'Pillar', ring: 'Ring', 'quarter pipe': 'Quarter pipe' };
const LAVA_KINDS = { none: [], car: ['car'], ball: ['ball'], both: ['ball', 'car'] };
const DEG = 32768 / 180, LIMIT = 100000;          // rotator units a degree; how far coordinates and sizes may go
const CHECKPOINT_SINK = 50;                       // a checkpoint reaches this far under the ground it stands on
const r1 = v => Math.round(v * 10) / 10, deg = uu => r1(uu / DEG);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isVec = v => Array.isArray(v) && v.length === 3 && v.every(x => isNum(x) && Math.abs(x) <= LIMIT);
const rotated = (rot, v) => { const ax = ueAxes(rot); return [0, 1, 2].map(k => ax[0][k] * v[0] + ax[1][k] * v[1] + ax[2][k] * v[2]); };
const shapeBoxes = new Map();
function shapeBox(key) {                          // a built-in shape's [min, max] corners
  if (!shapeBoxes.has(key)) {
    const p = shapeData(key).positions, axis = k => p.filter((_, v) => v % 3 === k);
    shapeBoxes.set(key, [[0, 1, 2].map(k => Math.min(...axis(k))), [0, 1, 2].map(k => Math.max(...axis(k)))]);
  }
  return shapeBoxes.get(key);
}
// the point an agent's `at` names, relative to the pivot before rotation: a shape's bottom centre, a checkpoint's ground
const shapeFoot = (key, s) => { const [min, max] = shapeBox(key); return [(min[0] + max[0]) / 2 * s[0], (min[1] + max[1]) / 2 * s[1], min[2] * s[2]]; };
const zoneFoot = (b, s) => [b[0] * s[0], b[1] * s[1], (b[2] - b[5]) * s[2] + CHECKPOINT_SINK];
const pivotFor = (at, rot, foot) => rotated(rot, foot).map((v, k) => at[k] - v);
const footOf = (e, foot) => rotated(e.rot, foot).map((v, k) => r1(e.loc[k] + v));
const lavaKind = ({ car, ball }) => car && ball ? 'both' : car ? 'car' : ball ? 'ball' : 'none';

export function installAI(api) {
  const surfaceKey = name => name.replace(/^MAT_|_(INST|MIC|MAT|Mat)$/g, '');
  const aiSurfaces = () => new Map(api.surfaces.value.map(op => [op.value === 'lava' ? 'lava' : surfaceKey(op.text), op.value]));
  const surfaceRef = name => [...aiSurfaces()].find(([k]) => k.toLowerCase() === surfaceKey(name).toLowerCase())?.[1];
  const surfaceName = ref => [...aiSurfaces()].find(([, v]) => v === ref)?.[0] ?? null;
  const aiObjects = d => { const floor = floorOf(d); return [floor, d.objects.filter(e => V.listedForAI(e, floor))]; };
  const aiFind = (d, id) => aiObjects(d)[1].find(e => e.id === id);
  const aiLava = d => { const zones = d.objects.filter(e => e.kind === 'lava').map(e => e.lava); return lavaKind({ car: zones.some(l => l.car), ball: zones.some(l => l.ball) }); };
  const spawnOf = d => d.objects.find(e => e.kind === 'spawn'), ballOf = d => d.objects.find(e => e.kind === 'ball');

  function aiErrors(step) {                       // what is wrong with a step before anything changes
    if (!step || typeof step !== 'object' || Array.isArray(step)) return ['a step is an object, such as {"add": [...]}'];
    const out = [], bad = (where, what) => out.push(`${where}: ${what}`);
    const FIELDS = ['new', 'name', 'lighting', 'lava', 'timer', 'deaths', 'spawn', 'ball', 'add', 'remove', 'script'];
    for (const k of Object.keys(step)) if (!FIELDS.includes(k)) bad(k, `unknown field; a step has ${FIELDS.join(', ')}`);
    if ('new' in step && typeof step.new !== 'boolean') bad('new', 'true or false');
    if ('name' in step && !(typeof step.name === 'string' && /^[\w -]{1,60}$/.test(step.name))) bad('name', 'up to 60 letters, digits, spaces, - or _');
    if ('lighting' in step && step.lighting !== 'map' && !Object.hasOwn(LIGHTING, step.lighting)) bad('lighting', `one of map, ${Object.keys(LIGHTING).join(', ')}`);
    if ('lava' in step && !Object.hasOwn(LAVA_KINDS, step.lava)) bad('lava', `one of ${Object.keys(LAVA_KINDS).join(', ')}`);
    for (const k of ['timer', 'deaths']) if (k in step && typeof step[k] !== 'boolean') bad(k, 'true or false');
    if ('spawn' in step && !(isVec(step.spawn?.at) && (!('yaw' in step.spawn) || isNum(step.spawn.yaw)))) bad('spawn', '{"at": [x, y, z], "yaw": degrees}');
    if ('ball' in step && !['start', 'roof'].includes(step.ball) && !isVec(step.ball?.at)) bad('ball', '"start", "roof" or {"at": [x, y, z]}');
    if ('remove' in step && !(Array.isArray(step.remove) && step.remove.every(id => typeof id === 'string'))) bad('remove', 'a list of ids');
    if ('script' in step && !(typeof step.script === 'string' && step.script.length <= 50000)) bad('script', 'the whole script as one string (JavaScript, see "Scripts")');
    if (!('add' in step)) return out;
    if (!Array.isArray(step.add) || step.add.length > 2000) return [...out, 'add: a list of up to 2000 shapes, checkpoints and lights'];
    const ids = new Set(), KEYS = { shape: ['id', 'shape', 'at', 'size', 'yaw', 'pitch', 'roll', 'surface', 'motion'],
                                    checkpoint: ['id', 'checkpoint', 'at', 'size', 'yaw', 'gate', 'ballOnTop', 'visible', 'title'],
                                    light: ['id', 'light', 'at', 'yaw', 'pitch', 'color', 'brightness', 'radius', 'cone', 'core', 'shadows', 'on'],
                                    zone: ['id', 'zone', 'at', 'size', 'yaw', 'visible', 'gravity'] };
    step.add.forEach((e, n) => {
      const where = `add[${n}]${typeof e?.id === 'string' ? ` (${e.id})` : ''}`, kind = e && ['shape', 'checkpoint', 'light', 'zone'].filter(k => k in e);
      if (!kind || kind.length !== 1) return bad(where, 'an object with one of "shape", "checkpoint", "light" or "zone"');
      if ('zone' in e && !['box', 'gate'].includes(e.zone)) bad(where, 'zone: "box" or "gate"');
      if ('gravity' in e && !(typeof e.gravity === 'number' && Math.abs(e.gravity) <= 20000)) bad(where, 'gravity: a number within ±20000 (Rocket League\'s is -650)');
      for (const k of Object.keys(e)) if (!KEYS[kind[0]].includes(k)) bad(where, `unknown field "${k}" for a ${kind[0]}`);
      if ('id' in e && !(typeof e.id === 'string' && /^[\w-]{1,40}$/.test(e.id))) bad(where, 'id: up to 40 letters, digits, - or _');
      else if ('id' in e && ids.has(e.id)) bad(where, 'id used twice in this step');
      ids.add(e.id);
      if (!isVec(e.at)) bad(where, `at: [x, y, z] within ±${LIMIT}`);
      if ('size' in e && !(isVec(e.size) && e.size.every(v => v > 0))) bad(where, 'size: [x, y, z], each above 0');
      for (const k of ['yaw', 'pitch', 'roll']) if (k in e && !isNum(e[k])) bad(where, `${k}: degrees`);
      if ('shape' in e && !Object.hasOwn(AI_SHAPES, String(e.shape).toLowerCase())) bad(where, `shape: one of ${Object.keys(AI_SHAPES).join(', ')}`);
      if ('surface' in e && typeof e.surface !== 'string') bad(where, 'surface: a name from state().surfaces');
      if ('checkpoint' in e && !['car', 'ball'].includes(e.checkpoint)) bad(where, 'checkpoint: "car" or "ball"');
      for (const k of ['gate', 'ballOnTop']) if (k in e && typeof e[k] !== 'boolean') bad(where, `${k}: true or false`);
      if ('visible' in e && !['boolean', 'string'].includes(typeof e.visible)) bad(where, 'visible: true, false or a surface name');
      if ('title' in e && !(typeof e.title === 'string' && e.title.length <= 60)) bad(where, 'title: up to 60 characters');
      if ('light' in e && !Object.hasOwn(LIGHT_KINDS, e.light)) bad(where, `light: one of ${Object.keys(LIGHT_KINDS).join(', ')}`);
      if ('color' in e && !(typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color))) bad(where, 'color: "#rrggbb"');
      for (const [k, lo, hi] of [['brightness', 0, 100], ['radius', 10, LIMIT], ['cone', 1, 89], ['core', 0, 89]]) {
        if (k in e && !(isNum(e[k]) && e[k] >= lo && e[k] <= hi)) bad(where, `${k}: a number from ${lo} to ${hi}`);
      }
      if ('light' in e && ('radius' in e && !['point', 'spot'].includes(e.light) || ['cone', 'core'].some(k => k in e) && e.light !== 'spot')) bad(where, 'radius is for point and spot lights; cone and core for spot lights');
      for (const k of ['shadows', 'on']) if ('light' in e && k in e && typeof e[k] !== 'boolean') bad(where, `${k}: true or false`);
      if ('shape' in e && 'motion' in e) {
        const m = e.motion;
        if (!m || typeof m !== 'object' || !Object.hasOwn(MOTIONS, m.kind)) bad(where, `motion: {"kind": one of ${Object.keys(MOTIONS).join(', ')}, ...settings}`);
        else {
          for (const err of motionErrors({ ...newMotion(m.kind), ...m, trigger: null }, LIMIT)) bad(where, `motion.${err}`);
          if (m.trigger != null && typeof m.trigger !== 'string') bad(where, 'motion.trigger: a checkpoint id, or null to start with the map');
        }
      }
    });
    return out;
  }
  const surfaceErrors = step => (step.add ?? []).flatMap((e, n) => [e.surface, typeof e.visible === 'string' ? e.visible : undefined]
    .filter(s => s !== undefined && surfaceRef(s) === undefined)
    .map(s => `add[${n}]: no surface "${s}"; this map has ${[...aiSurfaces().keys()].join(', ')}`));

  function aiAdd(d, e, pending) {                 // the document with entry `e` of a step's add in it; pending: [uid, trigger id]
    const old = e.id && aiFind(d, e.id), zone = ed.map.zone;
    if (old) d = removing(d, [old.uid]);
    const panelOf = () => e.visible ? { material: e.visible === true ? null : surfaceRef(e.visible) } : null;
    let made;
    if ('zone' in e || 'checkpoint' in e) {
      if (!zone) throw new Error('this map has no trigger zone to copy');
      const b = zone.bounds, rot = [0, Math.round((e.yaw ?? 0) * DEG), 0], size = e.size ?? [2 * b[3], 2 * b[4], 2 * b[5]];
      const scale3d = [(e.zone ?? (e.gate ? 'gate' : 'box')) === 'gate' ? GATE : size[0], size[1], size[2]].map((v, k) => v / (2 * b[3 + k]));
      const loc = pivotFor(e.at, rot, zoneFoot(b, scale3d));
      made = 'zone' in e ? { ...zoneEntity(d, ed.map, loc, rot, scale3d, e.gravity), panel: panelOf() }
        : { ...checkpointEntity(d, ed.map, e.checkpoint === 'ball', loc, rot, !!e.ballOnTop, scale3d, (e.title ?? '').trim()), panel: panelOf() };
    } else if ('light' in e) {
      const hex = e.color ?? '#ffffff', settings = { kind: e.light, ...api.NEW_LIGHT[e.light], color: [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)) };
      for (const [k, f] of [['brightness', 'brightness'], ['radius', 'radius'], ['cone', 'outer'], ['core', 'inner'], ['shadows', 'shadows'], ['on', 'on']]) if (k in e) settings[f] = e[k];
      if (e.light === 'spot') settings.inner = Math.min(settings.inner, settings.outer);
      const aim = api.LIGHT_AIM[e.light], rot = ['spot', 'sun'].includes(e.light) ? [Math.round((e.pitch ?? aim[0] / DEG) * DEG), Math.round((e.yaw ?? aim[1] / DEG) * DEG), 0] : [0, 0, 0];
      made = lightEntity(d, e.light, e.at, rot, settings);
    } else {
      const key = `std:${AI_SHAPES[e.shape.toLowerCase()]}`, [min, max] = shapeBox(key);
      const rot = [e.pitch ?? 0, e.yaw ?? 0, e.roll ?? 0].map(x => Math.round(x * DEG));
      const scale3d = e.size ? e.size.map((v, k) => v / (max[k] - min[k])) : [1, 1, 1];
      made = api.newShape(d, key, pivotFor(e.at, rot, shapeFoot(key, scale3d)), rot, scale3d, false);
      if (e.surface) made.surface = surfaceRef(e.surface);
      if (e.motion) made.motion = { ...newMotion(e.motion.kind), ...structuredClone(e.motion), trigger: null };
      if (typeof e.motion?.trigger === 'string') pending.push([made.uid, e.motion.trigger]);   // resolved after the step's adds
    }
    return adding(d, [{ ...made, id: e.id ?? made.id }]);
  }
  function aiSetLava(d, kind) {
    d = removing(d, d.objects.filter(e => e.kind === 'lava').map(e => e.uid));
    const floor = floorOf(d), kinds = LAVA_KINDS[kind];
    if (kinds.length && (!floor || !ed.map.zone)) throw new Error('this map has no floor or trigger zone for lava');
    if (!kinds.length) return d;
    const box = V.meshBox(floor.uid), [loc, scale3d] = lavaValues(box, box.max[2], ed.map.zone.bounds);
    return adding(d, [{ ...lavaEntity(d, ed.map, loc, scale3d, { car: kinds.includes('car'), ball: kinds.includes('ball') }), panel: { material: null } }]);
  }
  function aiSpawn(d, { at, yaw = 0 }) {
    const s = spawnOf(d);
    return api.settleSpawn(replace(d, [{ ...s, loc: [at[0], at[1], at[2] + RESPAWN_CLEARANCE], rot: [0, Math.round(yaw * DEG), 0] }]));
  }
  function aiBall(d, how, notes) {
    const ball = ballOf(d);
    if (how === 'start') {
      if (ball.i !== null) { notes.push('ball: this map has a ball spawn of its own; place it with {"at": [x, y, z]}'); return d; }
      return replace(d, [{ ...ball, placed: false, onRoof: false }]);
    }
    return api.settleBall(replace(d, [{ ...ball, loc: how === 'roof' ? roofSpot(spawnOf(d)) : [...how.at] }]));
  }
  async function apply(step) {
    if (typeof step === 'string') try { step = JSON.parse(step); } catch (err) { return { ok: false, errors: [`not JSON: ${err.message}`] }; }
    let errors = aiErrors(step);
    if (errors.length) return { ok: false, errors };
    try {
      if (step.new) await api.newMap(false);
      if ((errors = surfaceErrors(step)).length) return { ok: false, errors };
      let d = api.doc();
      const notes = [];
      if (step.name) d = { ...d, name: `${step.name.trim()}.udk` };
      if (step.lighting) d = { ...d, lighting: step.lighting };
      if ('timer' in step || 'deaths' in step) d = { ...d, hud: { timer: step.timer ?? d.hud.timer, deaths: step.deaths ?? d.hud.deaths } };
      for (const id of step.remove ?? []) { const e = aiFind(d, id); e ? d = removing(d, [e.uid]) : notes.push(`remove: no object "${id}"`); }
      const pending = [];
      for (const e of step.add ?? []) d = aiAdd(d, e, pending);
      for (const [uid, id] of pending) {
        const c = aiFind(d, id), e = d.objects.find(x => x.uid === uid);
        if (c?.kind === 'checkpoint') d = replace(d, [{ ...e, motion: { ...e.motion, trigger: c.uid } }]);
        else notes.push(`${e.id}: no checkpoint "${id}" to start it; it starts with the map`);
      }
      if (step.lava) d = aiSetLava(d, step.lava);
      if (step.spawn) d = aiSpawn(d, step.spawn);
      if (step.ball) d = aiBall(d, step.ball, notes);
      if ('script' in step) d = { ...d, script: step.script };
      api.commit(d);
      api.select([]);
      if ('script' in step) {
        const r = await api.runPlan(step.script);
        if (r.error) return { ok: false, errors: [`script: ${r.error} (the rest of the step was applied)`] };
      }
      api.setStatus(`An AI agent changed the map: ${api.changeSet()[1]}`, 'ok');
      return { ok: true, objects: aiObjects(api.doc())[1].length, warnings: [...notes, ...aiWarnings(api.doc())] };
    } catch (err) {
      return { ok: false, errors: [err.message] };
    }
  }

  function aiEntry(d, e) {
    const b = V.meshBox(e.uid), out = { id: e.id };
    if (e.kind === 'lava') Object.assign(out, { kind: 'lava', resets: lavaKind(e.lava) });
    else if (isZone(e)) {
      const s = e.scale3d.map(v => v * e.scale);
      Object.assign(out, { kind: 'zone', at: footOf(e, zoneFoot(e.bounds, s)), yaw: deg(e.rot[1]), size: s.map((v, k) => r1(2 * e.bounds[3 + k] * v)), visible: !!e.panel,
                           ...(e.kind === 'gravity' ? { gravity: e.gravity } : {}) });
    } else if (e.kind === 'checkpoint') {
      const s = e.scale3d.map(v => v * e.scale);
      Object.assign(out, { kind: 'checkpoint', checkpoint: e.ball ? 'ball' : 'car', at: footOf(e, zoneFoot(e.bounds, s)), yaw: deg(e.rot[1]),
                           size: s.map((v, k) => r1(2 * e.bounds[3 + k] * v)), gate: isGate(e), visible: !!e.panel });
      if (e.ball) out.ballOnTop = !!e.ballOnTop;
      out.title = e.title ?? null;
      out.respawn = (V.respawnValues(e) ?? e).loc.map(r1);
    } else if (e.kind === 'shape' && e.shape.startsWith('std:')) {
      const [min, max] = shapeBox(e.shape);
      Object.assign(out, { kind: e.shape.slice(4).toLowerCase(), at: footOf(e, shapeFoot(e.shape, e.scale3d)), size: e.scale3d.map((v, k) => r1(v * (max[k] - min[k]))),
                           yaw: deg(e.rot[1]), pitch: deg(e.rot[0]), roll: deg(e.rot[2]), surface: surfaceName(e.surface ?? ed.lastSurface) });
    } else if (e.kind === 'light') {
      const l = e.light;
      Object.assign(out, { kind: 'light', light: l.kind, at: e.loc.map(r1), color: '#' + l.color.map(v => v.toString(16).padStart(2, '0')).join(''),
                           brightness: Math.round(l.brightness * 100) / 100, shadows: l.shadows, on: l.on });
      if ('radius' in l) out.radius = Math.round(l.radius);
      if (l.kind === 'spot') Object.assign(out, { cone: r1(l.outer), core: r1(l.inner) });
      if (['spot', 'sun'].includes(l.kind)) Object.assign(out, { yaw: deg(e.rot[1]), pitch: deg(e.rot[0]) });
      return out;
    } else Object.assign(out, { kind: 'mesh', mesh: e.mesh || e.name });
    if (e.motion) out.motion = { ...structuredClone(e.motion), trigger: e.motion.trigger ? d.objects.find(t => t.uid === e.motion.trigger)?.id ?? null : null };
    out.box = { min: b.min.map(r1), max: b.max.map(r1) };
    return out;
  }
  function aiWarnings(d) {                        // what keeps the map from playing as meant
    const [floor, list] = aiObjects(d), lava = aiLava(d) !== 'none', out = [];
    const floorTop = floor ? V.meshBox(floor.uid).max[2] : -Infinity, s = spawnOf(d);
    const under = V.groundHit([s.loc[0], s.loc[1], s.loc[2] + 150], 5000);
    if (!under) out.push('spawn: nothing under the car');
    else if (lava && V.hitUid(under) === floor?.uid) out.push('spawn: the car starts on the lava floor; stand it on a shape');
    for (const e of list) {
      if (e.kind === 'lava' || e.kind === 'light' || isZone(e)) continue;
      if (e.kind === 'checkpoint') {
        const spot = (V.respawnValues(e) ?? e).loc, hit = V.groundHit([spot[0], spot[1], spot[2] + 1], RESPAWN_CLEARANCE + 50);
        if (!hit) out.push(`${e.id}: nothing under its respawn spot [${spot.map(Math.round)}]; a reset drops the car from there`);
        else if (lava && V.hitUid(hit) === floor?.uid) out.push(`${e.id}: its respawn spot is on the lava floor`);
      } else if (V.meshBox(e.uid).max[2] <= floorTop) out.push(`${e.id}: under the floor`);
    }
    const ball = ballOf(d), b = V.ballStart(d);
    if (ball.placed && !ball.onRoof && !V.groundHit([b[0], b[1], b[2] + 1], BALL_REST + 50)) out.push('ball: in the air; it falls when the map starts');
    const over = !ball.placed && !ed.map.spawnBall && !d.objects.some(e => e.kind === 'lava' && e.lava.ball) && V.groundHit([b[0], b[1], LIMIT], 2 * LIMIT);
    if (over && over.point.y > b[2]) out.push(`ball: Free Play starts it at the field centre under ${V.hitUid(over) === floor?.uid ? 'the floor' : d.objects.find(x => x.uid === V.hitUid(over))?.id ?? 'terrain'}; place it with "ball", or keep (0, 0) clear`);
    return out;
  }
  function state() {
    const d = api.doc(), [floor, list] = aiObjects(d), s = spawnOf(d), ball = ballOf(d), plan = api.planFor(d);
    return {
      name: d.name, floor: floor ? r1(V.meshBox(floor.uid).max[2]) : null, surfaces: [...aiSurfaces().keys()], lighting: d.lighting, lava: aiLava(d), timer: d.hud.timer, deaths: d.hud.deaths,
      spawn: { at: [s.loc[0], s.loc[1], s.loc[2] - RESPAWN_CLEARANCE].map(r1), yaw: deg(s.rot[1]) },
      ball: { start: ball.placed ? ball.onRoof ? 'roof' : 'placed' : 'start', centre: V.ballStart(d).map(r1) },
      objects: list.map(e => aiEntry(d, e)), warnings: aiWarnings(d),
      script: { source: d.script, error: runSig.value.source === d.script ? runSig.value.error : null, ran: !!plan, rules: plan?.rules.map(r => eventLabel(r.event)) ?? [] },
    };
  }
  function ground(x, y) {
    if (!isNum(x) || !isNum(y)) return { error: 'ground(x, y) takes two numbers' };
    const hit = V.groundHit([x, y, LIMIT], 2 * LIMIT), d = api.doc();
    if (!hit) return null;
    const uid = V.hitUid(hit);
    return { z: r1(hit.point.y), on: uid === floorOf(d)?.uid ? 'floor' : uid ? d.objects.find(e => e.uid === uid)?.id : 'terrain' };
  }
  /** @param {string | {from: number[], at: number[]}} [view] */
  async function look(view = 'top', { labels = true } = {}) {
    const d = api.doc(), named = ['top', 'overview', 'spawn'];
    const target = typeof view === 'string' && !named.includes(view) ? aiFind(d, view) : null;
    if (typeof view === 'string' ? !named.includes(view) && !target : !(isVec(view?.from) && isVec(view?.at))) {
      return { ok: false, error: 'look takes "top", "overview", "spawn", an object id, or {from: [x, y, z], at: [x, y, z]}' };
    }
    api.select([]);
    ui.view.value = { ...ui.view.value, ids: labels };
    const { camera, orbit } = V, s = spawnOf(d), [ahead, right] = ueAxes(s.rot).map(V.toThree), up = new THREE.Vector3(0, 1, 0), tan = Math.tan(camera.fov * Math.PI / 360);
    const box = new THREE.Box3().expandByPoint(V.toThree(s.loc)).expandByPoint(V.toThree(V.ballStart(d)));
    for (const e of aiObjects(d)[1]) if (e.kind !== 'lava' && !['sun', 'sky'].includes(e.light?.kind)) box.union(V.boxOf(V.meshOf(e.uid)));   // far-off suns don't count
    const of = target ? V.boxOf(V.meshOf(target.uid)) : box, centre = of.getCenter(new THREE.Vector3()), size = of.getSize(new THREE.Vector3());
    const place = () => {
      let from, at;
      if (view === 'top') {                       // straight down, +X to the right (+Y is then down the screen)
        const dist = Math.max(size.z / 2 / tan, size.x / 2 / (tan * camera.aspect)) * 1.1 + 300;
        at = new THREE.Vector3(centre.x, box.min.y, centre.z);
        from = new THREE.Vector3(centre.x, box.max.y + dist, centre.z + 0.01);
      } else if (view === 'spawn') {
        const p = V.toThree(s.loc);
        from = p.clone().addScaledVector(ahead, -900).addScaledVector(up, 350);
        at = p.clone().addScaledVector(ahead, 1200).addScaledVector(up, 100);
      } else if (typeof view === 'string') {      // from behind the spawn's left shoulder, the whole box in view
        at = centre;
        from = ahead.clone().negate().addScaledVector(right, -0.5).addScaledVector(up, 0.8).normalize()
          .multiplyScalar((size.length() / 2 + 200) / (tan * Math.min(1, camera.aspect)) * 1.1).add(centre);
      } else [from, at] = [V.toThree(view.from), V.toThree(view.at)];
      camera.position.copy(from);
      orbit.target.copy(at);
      orbit.update();
    };
    place();
    V.setReframe(place);
    document.getElementById('legendText').textContent = view === 'top' ? 'top view · +X → · +Y ↓' : '';
    V.renderNow();                                // now: a hidden page gets no animation frames
    await api.nextFrame();
    return { ok: true, note: 'Take a screenshot now. The bar is the scale at the middle of the view.' };
  }
  window.mapAI = { help: async () => (await fetch('ai-guide.md', { cache: 'no-store' })).text(), apply, state, ground, look };
  console.info('AI agents: this editor has a map-building API. Run  await mapAI.help()  for the guide.');
}
