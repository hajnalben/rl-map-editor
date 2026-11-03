// Kismet (Sequence) graphs in UE3 v868 maps: decode node properties, and wire up checkpoints.
import { concat, latin1, latin1Bytes, pack, unpackFrom, utf16 } from './bytes.js';

// Structs serialized as raw bytes instead of tagged properties.
const ATOMIC = { Vector: '<3f', Rotator: '<3i', Color: '<4B', LinearColor: '<4f', Vector2D: '<2f', IntPoint: '<2i',
                 Guid: '<4I', Plane: '<4f', Quat: '<4f', Box: null };
const ATOMIC_SIZE = { '<3f': 12, '<3i': 12, '<4B': 4, '<4f': 16, '<2f': 8, '<2i': 8, '<4I': 16 };

function fname(pkg, p) {
  const [index, number] = unpackFrom('<ii', pkg.data, p);
  const base = pkg.names[index];
  return number ? `${base}_${number - 1}` : base;
}

function decode(pkg, start, end) {                // tagged properties as [{name: value}, end]; nested values best-effort
  const props = {};
  let p = start;
  while (p < end) {
    const name = fname(pkg, p);
    p += 8;
    if (name === 'None') break;
    const ptype = fname(pkg, p);
    const [size, index] = unpackFrom('<ii', pkg.data, p + 8);
    p += 16;
    let extra = null;
    if (ptype === 'StructProperty' || ptype === 'ByteProperty') {
      extra = fname(pkg, p);
      p += 8;
    } else if (ptype === 'BoolProperty') {
      props[name] = !!pkg.data[p];
      p += 1;
      continue;
    }
    props[index === 0 ? name : `${name}[${index}]`] = readValue(pkg, ptype, extra, p, size);
    p += size;
  }
  return [props, p];
}

function readValue(pkg, ptype, extra, p, size) {
  const d = pkg.data;
  if (ptype === 'IntProperty') return unpackFrom('<i', d, p)[0];
  if (ptype === 'FloatProperty') return unpackFrom('<f', d, p)[0];
  if (['ObjectProperty', 'ClassProperty', 'ComponentProperty', 'InterfaceProperty'].includes(ptype)) return unpackFrom('<i', d, p)[0];
  if (ptype === 'NameProperty') return fname(pkg, p);
  if (ptype === 'StrProperty') {
    const n = unpackFrom('<i', d, p)[0];
    return (n >= 0 ? latin1(d.subarray(p + 4, p + 4 + n)) : utf16(d.subarray(p + 4, p + 4 - 2 * n))).replace(/\0+$/, '');
  }
  if (ptype === 'ByteProperty') return size === 8 ? fname(pkg, p) : d[p];
  if (ptype === 'StructProperty') {
    const fmt = ATOMIC[extra];
    if (fmt && size === ATOMIC_SIZE[fmt]) return unpackFrom(fmt, d, p);
    return decode(pkg, p, p + size)[0];
  }
  if (ptype === 'ArrayProperty') {
    const n = unpackFrom('<i', d, p)[0];
    let body = p + 4;
    if (n === 0) return [];
    if (size === 4 + 4 * n && !looksTagged(pkg, body)) return unpackFrom(`<${n}i`, d, body);
    const items = [];
    for (let k = 0; k < n; k++) {
      if (!looksTagged(pkg, body)) return `<${n} items, ${size} bytes>`;
      let item;
      [item, body] = decode(pkg, body, p + size);
      items.push(item);
    }
    return items;
  }
  return `<${ptype} ${size}B>`;
}

function looksTagged(pkg, p) {                    // bytes at p start a property tag (a name, then a property type or None)
  if (p + 12 > pkg.data.length) return false;
  const [idx, num, tidx] = unpackFrom('<iii', pkg.data, p);
  if (!(idx >= 0 && idx < pkg.names.length) || num < 0 || num > 100000) return false;
  if (pkg.names[idx] === 'None') return true;
  return tidx >= 0 && tidx < pkg.names.length && pkg.names[tidx].endsWith('Property');
}

export const nodeProps = (pkg, e) => decode(pkg, pkg.netIndexAt(e) + 4, e.off + e.size)[0];   // any object's tagged properties

const [I, F, B, O, N, S, A, T] = ['IntProperty', 'FloatProperty', 'BoolProperty', 'ObjectProperty', 'NameProperty', 'StrProperty', 'ArrayProperty', 'StructProperty'];

class Encoder {                                   // tagged-property writer; names go through the Additions
  constructor(add) { this.add = add; }
  props(props) { return concat(...props.map(p => this.prop(...p)), this.add.fname('None')); }
  prop(name, ptype, value) {
    const head = concat(this.add.fname(name), this.add.fname(ptype));
    if (ptype === B) return concat(head, pack('<ii', 0, 0), Uint8Array.of(value ? 1 : 0));
    if (ptype === T) {                            // [struct name, its bytes]: raw for atomic structs, else tagged properties
      const [struct, bytes] = value;
      return concat(head, pack('<ii', bytes.length, 0), this.add.fname(struct), bytes);
    }
    const body = this.value(ptype, value);
    return concat(head, pack('<ii', body.length, 0), body);
  }
  value(ptype, value) {
    if (ptype === I || ptype === O) return pack('<i', value);
    if (ptype === F) return pack('<f', value);
    if (ptype === N) return this.add.fname(value);
    if (ptype === S) {
      const text = concat(latin1Bytes(value), new Uint8Array(1));
      return concat(pack('<i', text.length), text);
    }
    if (ptype === A) {
      if (value.length && Array.isArray(value[0])) return concat(pack('<i', value.length), ...value.map(v => this.props(v)));   // structs
      return pack(`<i${value.length}i`, value.length, ...value);                            // object refs
    }
    throw new Error(ptype);
  }
}

// Link records exactly as UDK 2015 saves them (every field, in this order).
const inputLink = (y, desc = 'In', delta = 11) => [['LinkDesc', S, desc], ['bHasImpulse', B, false], ['QueuedActivations', I, 0], ['bDisabled', B, false],
  ['bDisabledPIE', B, false], ['LinkedOp', O, 0], ['DrawY', I, y], ['bHidden', B, false],
  ['ActivateDelay', F, 0.0], ['bClampedMax', B, false], ['bClampedMin', B, false], ['OverrideDelta', I, delta]];

// targets: node refs, or [ref, input index] to enter a node through another input than its first
const outputLink = (desc, targets, y, delta = 11) => [['Links', A, targets.map(t => [t].flat()).map(([t, k = 0]) => [['LinkedOp', O, t], ['InputLinkIdx', I, k]])],
  ['LinkDesc', S, desc], ['bHasImpulse', B, false], ['bDisabled', B, false], ['bDisabledPIE', B, false], ['LinkedOp', O, 0],
  ['ActivateDelay', F, 0.0], ['DrawY', I, y], ['bHidden', B, false], ['bClampedMax', B, false],
  ['bClampedMin', B, false], ['OverrideDelta', I, delta]];

const varLink = (desc, expected, linked, x, { prop = 'None', writeable = false, hidden = false, delta = 16, minVars = 1, maxVars = 255 } = {}) => [
  ['ExpectedType', O, expected], ['LinkedVariables', A, linked], ['LinkDesc', S, desc], ['LinkVar', N, 'None'],
  ['PropertyName', N, prop], ['bWriteable', B, writeable], ['bSequenceNeverReadsOnlyWritesToThisVar', B, false],
  ['bModifiesLinkedObject', B, false], ['bHidden', B, hidden], ['MinVars', I, minVars], ['MaxVars', I, maxVars],
  ['DrawX', I, x], ['bAllowAnyType', B, false], ['bClampedMax', B, false], ['bClampedMin', B, false],
  ['OverrideDelta', I, delta]];

const layout = (version, parent, x, y, w, h, name = null) => [['ObjInstanceVersion', I, version], ['ParentSequence', O, parent],
  ['ObjPosX', I, x], ['ObjPosY', I, y], ...(name ? [['ObjName', S, name]] : []), ['DrawWidth', I, w], ['DrawHeight', I, h]];

export function mainSequence(pkg) {
  const level = pkg.levelIndex() + 1;
  return pkg.exports.findIndex(e => pkg.classOf(e) === 'Sequence' && e.outer === level);
}


// Nodes the main sequence runs. Maps keep nodes taken out of it (a fresh start empties it), so lookups skip those.
function liveNodes(pkg) {
  const seq = mainSequence(pkg);
  if (seq < 0) return new Set();                  // a map without Kismet
  const refs = nodeProps(pkg, pkg.exports[seq]).SequenceObjects;
  return new Set(Array.isArray(refs) ? refs.map(r => r - 1) : []);
}

// export index of the live variable called `name`, or null
function namedVar(pkg, name, live = liveNodes(pkg), cls = 'SeqVar_Object') {
  const i = pkg.exports.findIndex((e, k) => live.has(k) && pkg.classOf(e) === cls && nodeProps(pkg, e).VarName === name);
  return i >= 0 ? i : null;
}

// Checkpoint zones as [{i, ball}]: every zone stored into LastCheckpoint when touched; ball checkpoints also go
// into LastBallCheckpoint.
// Checkpoints as [{i, dest, valueVar, ball, ballOnTop, modeVar}]: i is the trigger zone (the Touch event's
// originator), dest what a reset teleports to (the zone itself, or a marker just past a gate) and valueVar the
// SeqVar_Object holding dest. Ball checkpoints also store whether the respawned ball goes on top of the car:
// modeVar is the SeqVar_Int their SetInt writes into BallOnTop (null in maps made before that setting existed,
// where it always goes on top).
function graph(pkg, live) {                       // node properties, variable links by name, and the Touch event a node runs from
  const props = new Map([...live].map(k => [k, nodeProps(pkg, pkg.exports[k])]));
  const links = k => new Map((props.get(k)?.VariableLinks || []).map(l => [l.LinkDesc, l.LinkedVariables || []]));
  const callers = new Map();                      // node -> nodes whose outputs lead into it
  for (const [k, p] of props) {
    for (const out of Array.isArray(p.OutputLinks) ? p.OutputLinks : []) {
      for (const l of out.Links || []) if (l.LinkedOp > 0) callers.set(l.LinkedOp - 1, [...(callers.get(l.LinkedOp - 1) || []), k]);
    }
  }
  const touchOf = k => {
    for (let hops = 0; hops < 4 && k !== undefined; hops++, k = callers.get(k)?.[0]) {
      if (pkg.classOf(pkg.exports[k]) === 'SeqEvent_Touch') return k;
    }
    return -1;
  };
  return { props, links, touchOf };
}

export function checkpointZones(pkg) {
  const live = liveNodes(pkg), last = namedVar(pkg, 'LastCheckpoint', live), lastBall = namedVar(pkg, 'LastBallCheckpoint', live);
  if (last === null) return [];
  const onTop = namedVar(pkg, 'BallOnTop', live, 'SeqVar_Int');
  const { props, links, touchOf } = graph(pkg, live);
  const touchedZone = k => { const t = touchOf(k); return t < 0 ? -1 : (props.get(t).Originator || 0) - 1; };
  const found = [], balls = new Map();
  for (const k of live) {
    if (pkg.classOf(pkg.exports[k]) !== 'SeqAct_SetObject') continue;
    const target = links(k).get('Target') || [];
    for (const v of links(k).get('Value') || []) {
      const dest = v > 0 ? (props.get(v - 1) ?? nodeProps(pkg, pkg.exports[v - 1])).ObjValue - 1 : -1;
      if (dest < 0) continue;
      if (target.includes(last + 1)) {
        const zone = touchedZone(k);
        found.push({ i: zone >= 0 ? zone : dest, dest, valueVar: v - 1 });
      }
      if (lastBall === null || !target.includes(lastBall + 1)) continue;
      const next = (props.get(k).OutputLinks?.[0]?.Links || [])[0]?.LinkedOp;
      const setInt = next > 0 && pkg.classOf(pkg.exports[next - 1]) === 'SeqAct_SetInt' ? links(next - 1) : null;
      const modeVar = onTop !== null && setInt && (setInt.get('Target') || []).includes(onTop + 1) ? (setInt.get('Value') || [])[0] - 1 : null;
      const value = modeVar === null ? null : (props.get(modeVar) ?? nodeProps(pkg, pkg.exports[modeVar])).IntValue;
      balls.set(dest, { ballOnTop: modeVar === null || value === 1, modeVar });
    }
  }
  return found.map(c => ({ ...c, ball: balls.has(c.dest), ballOnTop: balls.get(c.dest)?.ballOnTop ?? false, modeVar: balls.get(c.dest)?.modeVar ?? null }));
}

// Lava zones as [{i, ball}]: touching one (with the car, or the ball when `ball`) teleports the car back to
// LastCheckpoint, the way a Touch event leads into a Teleport there.
export function lavaZones(pkg) {
  const live = liveNodes(pkg), last = namedVar(pkg, 'LastCheckpoint', live);
  if (last === null) return [];
  const { props, links, touchOf } = graph(pkg, live), found = [];
  for (const k of live) {
    if (pkg.classOf(pkg.exports[k]) !== 'SeqAct_Teleport' || !(links(k).get('Destination') || []).includes(last + 1)) continue;
    const t = touchOf(k);
    if (t >= 0) found.push({ i: (props.get(t).Originator || 0) - 1, ball: props.get(t).bPlayerOnly === false });
  }
  return found;
}

// The ball a map hands you at the spawn `spawn` (an actor index), when the spawn counts as a ball checkpoint (ball
// lava): {onTop}; else null
export function spawnBall(pkg, spawn) {
  const live = liveNodes(pkg), lastBall = namedVar(pkg, 'LastBallCheckpoint', live);
  if (spawn === null || lastBall === null || nodeProps(pkg, pkg.exports[lastBall]).ObjValue !== spawn + 1) return null;
  const onTop = namedVar(pkg, 'BallOnTop', live, 'SeqVar_Int');
  return { onTop: onTop === null || nodeProps(pkg, pkg.exports[onTop]).IntValue === 1 };
}

export function ballSpawnMarker(pkg) {            // the actor index of the ball's own spawn marker, or null
  const v = namedVar(pkg, 'BallSpawn');
  return v === null ? null : (nodeProps(pkg, pkg.exports[v]).ObjValue || 0) - 1;
}

function ballChainEntries(pkg, live, lastBall) {  // the respawn chain's first check (is there a ball checkpoint?) and its ball remover
  let hasBall = null, clear = null;
  for (const k of live) {
    const e = pkg.exports[k], cls = pkg.classOf(e), p = nodeProps(pkg, e);
    const a = (p.VariableLinks || []).find(l => l.LinkDesc === 'A')?.LinkedVariables || [];
    if (cls === 'SeqCond_CompareObject' && a.includes(lastBall + 1)) hasBall = k + 1;
    if (cls === 'SeqAct_AddGameBall_TA' && p.OutputLinks?.[2]?.Links?.length) clear = k + 1;
  }
  return { hasBall, clear };
}

const PACKAGES = { SeqEvent_CarSpawned_TA: 'TAGame', SeqAct_AddGameBall_TA: 'TAGame' };   // the others live in Engine
// Where a respawned ball starts, from the spot the car is teleported to (30 above the ground when there is ground):
// on top, just over the roof; in front, this far ahead the way the checkpoint faces, just over the ground.
export const BALL_LIFT = 130;
export const BALL_AHEAD = 250;
export const BALL_FRONT_LIFT = 65;

// Copy trigger zone `template` once per checkpoint ({values: {prop: [fmt, values]}, ball, ballOnTop, respawn}) and
// wire Kismet; `respawn` (transform values) puts a reset at a marker zone there instead of the checkpoint itself:
// touching a car checkpoint with the car, or a ball checkpoint with the ball, makes it the respawn point, and a
// reset teleports the car there (with a fresh ball dropped onto it for ball checkpoints). The respawn logic is
// created once per map, or again when `fresh` (the main sequence was just emptied). Entries with `lava` are lava
// zones instead: touching one with the car (or the ball, when `ball`) teleports the car back to the last checkpoint,
// stopped, with a fresh ball as after a reset (always, for ball lava). With lava, the spawn `spawn` (an actor index)
// counts as the first checkpoint, a ball one when there is ball lava. `ballSpawn` (transform values) gives the ball
// a spawn of its own, a marker zone there: while the car is still at its spawn, the fresh ball goes to that marker.
// A checkpoint that becomes the respawn point shows "Checkpoint N" on screen for 2 seconds.
// Returns the new trigger indices.
export function addCheckpoints(add, template, checkpoints, fresh = false, spawn = null, ballSpawn = null) {
  const pkg = add.pkg, enc = new Encoder(add);
  const seq = mainSequence(pkg), parent = seq + 1;
  if (seq < 0) throw new Error('this map has no Kismet sequence to hold checkpoints');
  const classes = new Map();
  const cls = name => {
    if (!classes.has(name)) classes.set(name, add.classRef(name, PACKAGES[name] || 'Engine'));
    return classes.get(name);
  };
  const nodes = [];
  const node = (className, props) => {
    const i = add.addObject(cls(className), parent, className, concat(pack('<i', 0), enc.props(props)));
    nodes.push(i);
    return i;
  };
  const refs = names => Object.fromEntries(names.map((n, k) => [n, pkg.exports.length + add.added.length + 1 + k]));
  const placed = (r, from) => { if (nodes.slice(-Object.keys(r).length).some((n, k) => n + 1 !== Object.values(r)[k])) throw new Error(`${from}: node order`); };
  const obj = cls('SeqVar_Object');
  const vars = (x, y, extra = []) => [...extra, ...layout(1, parent, x, y, 32, 32)];

  const x0 = 40000, y0 = 40000;
  const live = fresh ? new Set() : liveNodes(pkg);
  if (ballSpawn && (spawn === null || namedVar(pkg, 'BallSpawn', live) !== null)) throw new Error('ball spawn: no car spawn, or the map has one already');
  const marker = ballSpawn ? add.duplicate(template, [0, 0, 0], ballSpawn) : null;
  const lava = checkpoints.filter(c => c.lava), startAt = spawn === null ? [] : [['ObjValue', O, spawn + 1]];
  const startFrom = (v, when) => { if (v !== null && when && spawn !== null) add.setProps(v, { ObjValue: add.tag('ObjValue', O, pack('<i', spawn + 1)) }); };
  const last = namedVar(pkg, 'LastCheckpoint', live);
  let lastRef = last === null ? null : last + 1;
  startFrom(last, lava.length || ballSpawn);
  if (last === null) {
    const r = refs(['car', 'last', 'teleport', 'spawned']);
    lastRef = r.last;
    node('SeqVar_Object', vars(x0 + 100, y0 + 200));
    node('SeqVar_Object', vars(x0 + 300, y0 + 200, [...(lava.length || ballSpawn ? startAt : []), ['VarName', N, 'LastCheckpoint']]));
    node('SeqAct_Teleport', [
      ['InputLinks', A, [inputLink(y0 + 34)]],
      ['OutputLinks', A, [outputLink('Out', [], y0 + 34)]],
      ['VariableLinks', A, [varLink('Target', obj, [r.car], x0 + 238, { prop: 'Targets' }),
                            varLink('Destination', obj, [r.last], x0 + 313, { delta: 76 }),
                            varLink('Teleport Volumes', obj, [], 0, { prop: 'TeleportVolumes', hidden: true, delta: 0 })]],
      ...layout(2, parent, x0 + 200, y0, 166, 61)]);
    node('SeqEvent_CarSpawned_TA', [
      ['MaxWidth', I, 97],
      ['OutputLinks', A, [outputLink('Out', [r.teleport], y0 + 66)]],
      ['VariableLinks', A, [varLink('Instigator', obj, [r.car], x0 + 48, { writeable: true })]],
      ...layout(1, parent, x0, y0, 68, 128)]);
    placed(r, 'car respawn');
  }

  const lastBall = namedVar(pkg, 'LastBallCheckpoint', live), ballLava = lava.some(c => c.ball), ballFirst = ballLava || ballSpawn;
  let lastBallRef = lastBall === null ? null : lastBall + 1;
  startFrom(lastBall, ballFirst);
  // the ball's own spawn: at the start (the car still at its spawn) the added ball goes there instead
  const SPAWN_NODES = ['ballSpawn', 'startVar', 'spawnAt', 'atStart', 'getSpawn', 'putSpawn'];
  const spawnNodes = (r, ballVar, elsewhere, x, y) => {
    node('SeqVar_Object', vars(x, y + 220, [['ObjValue', O, marker + 1], ['VarName', N, 'BallSpawn']]));
    node('SeqVar_Object', vars(x + 60, y + 220, startAt));
    node('SeqVar_Vector', vars(x + 120, y + 220));
    node('SeqCond_CompareObject', [
      ['InputLinks', A, [inputLink(y + 36, 'In', 23)]],
      ['OutputLinks', A, [outputLink('A == B', [r.getSpawn], y + 26, 13), outputLink('A != B', elsewhere, y + 46, 33)]],
      ['VariableLinks', A, [varLink('A', obj, [lastRef], x + 49, { delta: 45 }), varLink('B', obj, [r.startVar], x + 74, { delta: 70 })]],
      ...layout(1, parent, x, y, 123, 85)]);
    node('SeqAct_GetLocationAndRotation', [
      ['InputLinks', A, [inputLink(y + 34)]],
      ['OutputLinks', A, [outputLink('Out', [r.putSpawn], y + 34)]],
      ['VariableLinks', A, [varLink('Target', obj, [r.ballSpawn], x + 238, { prop: 'Targets', maxVars: 1 }),
                            varLink('Location', cls('SeqVar_Vector'), [r.spawnAt], x + 304, { prop: 'Location', writeable: true, delta: 76 }),
                            varLink('Rotation Vector', cls('SeqVar_Vector'), [], x + 375, { prop: 'RotationVector', writeable: true, delta: 148 }),
                            varLink('Rotation', cls('SeqVar_Vector'), [], x + 446, { prop: 'Rotation', writeable: true, delta: 219 })]],
      ...layout(3, parent, x + 200, y, 290, 77)]);
    node('SeqAct_SetLocation', [
      ['InputLinks', A, [inputLink(y + 34)]],
      ['OutputLinks', A, [outputLink('Out', [], y + 34)]],
      ['VariableLinks', A, [varLink('Location', cls('SeqVar_Vector'), [r.spawnAt], x + 544, { maxVars: 1 }),
                            varLink('Rotation', cls('SeqVar_Vector'), [], x + 615, { maxVars: 1, delta: 88 }),
                            varLink('Target', obj, [ballVar], x + 681, { prop: 'Target', writeable: true, maxVars: 1, delta: 159 })]],
      ...layout(3, parent, x + 500, y, 219, 61)]);
    placed(r, 'ball spawn');
  };
  const onTop = namedVar(pkg, 'BallOnTop', live, 'SeqVar_Int');
  let onTopRef = onTop === null ? null : onTop + 1;
  let { hasBall: hasBallRef, clear: clearRef } = lastBall === null ? {} : ballChainEntries(pkg, live, lastBall);
  if (lastBallRef === null && (checkpoints.some(c => c.ball || c.lava) || ballSpawn)) {
    // on reset, if the last checkpoint was a ball one: remove the balls, add one, and put it above the checkpoint
    // (on the car) or ahead of it along the way it faces
    const r = refs(['lastBall', 'onTop', 'one', 'none', 'player', 'ball', 'at', 'dir', 'x', 'y', 'z', 'fx', 'fy', 'fz', 'lift', 'ahead',
                    'z2', 'dx', 'dy', 'x2', 'y2', 'above', 'front', 'spawned', 'hasBall', 'isBall', 'clear', 'addBall', 'where', 'split',
                    'which', 'raise', 'join', 'place', 'splitDir', 'mulX', 'mulY', 'subX', 'subY', 'joinFront', 'placeFront', 'frontLift', 'z3', 'raiseFront',
                    ...(ballSpawn ? SPAWN_NODES : [])]);
    lastBallRef = r.lastBall;
    onTopRef = r.onTop;
    [hasBallRef, clearRef] = [r.hasBall, r.clear];
    const [vx, vy, x, y] = [x0 + 1000, y0 + 220, x0 + 800, y0];
    const vec = cls('SeqVar_Vector'), flt = cls('SeqVar_Float'), int = cls('SeqVar_Int');
    node('SeqVar_Object', vars(vx, vy, [...(ballFirst ? startAt : []), ['VarName', N, 'LastBallCheckpoint']]));
    node('SeqVar_Int', vars(vx + 60, vy, [['VarName', N, 'BallOnTop']]));
    node('SeqVar_Int', vars(vx + 120, vy, [['IntValue', I, 1]]));
    node('SeqVar_Object', vars(vx + 180, vy));
    node('SeqVar_Player', vars(vx + 240, vy));
    node('SeqVar_Object', vars(vx + 300, vy));
    for (let k = 0; k < 2; k++) node('SeqVar_Vector', vars(vx + 360 + 60 * k, vy));
    for (let k = 0; k < 6; k++) node('SeqVar_Float', vars(vx + 480 + 60 * k, vy));
    node('SeqVar_Float', vars(vx + 840, vy, [['FloatValue', F, -BALL_LIFT]]));
    node('SeqVar_Float', vars(vx + 900, vy, [['FloatValue', F, -BALL_AHEAD]]));
    for (let k = 0; k < 5; k++) node('SeqVar_Float', vars(vx + 960 + 60 * k, vy));
    for (let k = 0; k < 2; k++) node('SeqVar_Vector', vars(vx + 1260 + 60 * k, vy));
    node('SeqEvent_CarSpawned_TA', [
      ['MaxWidth', I, 97],
      ['OutputLinks', A, [outputLink('Out', [r.hasBall], y + 66)]],
      ['VariableLinks', A, [varLink('Instigator', obj, [], x + 48, { writeable: true })]],
      ...layout(1, parent, x, y, 68, 128)]);
    const compare = (a, b, same, differ, px) => [
      ['InputLinks', A, [inputLink(y + 36, 'In', 23)]],
      ['OutputLinks', A, [outputLink('A == B', same, y + 26, 13), outputLink('A != B', differ, y + 46, 33)]],
      ['VariableLinks', A, [varLink('A', obj, [a], px + 49, { delta: 45 }), varLink('B', obj, [b], px + 74, { delta: 70 })]],
      ...layout(1, parent, px, y, 123, 85)];
    node('SeqCond_CompareObject', compare(r.lastBall, r.none, [], [r.isBall], x + 200));
    node('SeqCond_CompareObject', compare(lastRef, r.lastBall, [[r.clear, 2]], [], x + 400));
    const ballLinks = ['Add', 'Destroy', 'DestroyAll', 'Wake'], ballOuts = ['Added', 'Destroyed', 'DestroyedAll', 'Awake'];
    const addBall = (outs, spawnAt, spawned, px) => [
      ['InputLinks', A, ballLinks.map((d, k) => inputLink(y + 37 + 22 * k, d, 14 + 22 * k))],
      ['OutputLinks', A, ballOuts.map((d, k) => outputLink(d, outs[d] || [], y + 37 + 22 * k, 14 + 22 * k))],
      ['VariableLinks', A, [varLink('Instigator', obj, [r.player], px + 48, { prop: 'Instigator' }),
                            varLink('SpawnTransform', obj, spawnAt, px + 129, { prop: 'SpawnTransform', delta: 96 }),
                            varLink('SpawnedBall', obj, spawned, px + 208, { prop: 'SpawnedBall', writeable: true, delta: 178 })]],
      ...layout(1, parent, px, y, 254, 149)];
    node('SeqAct_AddGameBall_TA', addBall({ DestroyedAll: [r.addBall] }, [], [], x + 600));
    node('SeqAct_AddGameBall_TA', addBall({ Added: [ballSpawn ? r.atStart : r.where] }, [lastRef], [r.ball], x + 900));
    const step = (outTo, links, px, py, w, version = 1) => [
      ['InputLinks', A, [inputLink(py + 34)]],
      ['OutputLinks', A, [outputLink('Out', outTo, py + 34)]],
      ['VariableLinks', A, links],
      ...layout(version, parent, px, py, w, 77)];
    node('SeqAct_GetLocationAndRotation', step([r.split], [
      varLink('Target', obj, [lastRef], x + 1238, { prop: 'Targets', maxVars: 1 }),
      varLink('Location', vec, [r.at], x + 1304, { prop: 'Location', writeable: true, delta: 76 }),
      varLink('Rotation Vector', vec, [r.dir], x + 1375, { prop: 'RotationVector', writeable: true, delta: 148 }),
      varLink('Rotation', vec, [], x + 1446, { prop: 'Rotation', writeable: true, delta: 219 })], x + 1200, y, 290, 3));
    const xyz = (first, firstProp, vector, [vX, vY, vZ], px, writeable) => [
      varLink(first, vec, [vector], px + 46, { prop: firstProp, writeable, delta: 22 }),
      varLink('X', flt, [vX], px + 91, { prop: 'X', delta: 87 }), varLink('Y', flt, [vY], px + 116, { prop: 'Y', delta: 112 }),
      varLink('Z', flt, [vZ], px + 141, { prop: 'Z', delta: 137 })];
    const math = (a, b, result, px) => [
      varLink('A', flt, [a], px + 20, { prop: 'ValueA' }), varLink('B', flt, [b], px + 45, { prop: 'ValueB', delta: 41 }),
      varLink('FloatResult', flt, [result], px + 85, { prop: 'FloatResult', writeable: true, delta: 65 }),
      varLink('IntResult', int, [], px + 150, { prop: 'IntResult', writeable: true, delta: 121 })];
    node('SeqAct_GetVectorComponents', step([r.which], xyz('Input Vector', 'InVector', r.at, [r.x, r.y, r.z], x + 1550, false), x + 1550, y, 168));
    node('SeqCond_CompareInt', [
      ['InputLinks', A, [inputLink(y + 59, 'In', 59)]],
      ['OutputLinks', A, [['A <= B', [], 15], ['A > B', [], 37], ['A == B', [r.raise], 59], ['A < B', [r.splitDir], 81], ['A >= B', [], 103]]
        .map(([d, to, delta]) => outputLink(d, to, y + delta, delta))],
      ['VariableLinks', A, [varLink('A', int, [r.onTop], x + 1780, { prop: 'ValueA', delta: 29 }),
                            varLink('B', int, [r.one], x + 1805, { prop: 'ValueB', delta: 54 })]],
      ...layout(1, parent, x + 1750, y, 91, 157)]);
    const y2 = y + 250, setLocation = (at, px, py) => [
      ['InputLinks', A, [inputLink(py + 34)]],
      ['OutputLinks', A, [outputLink('Out', [], py + 34)]],
      ['VariableLinks', A, [varLink('Location', vec, [at], px + 44, { maxVars: 1 }),
                            varLink('Rotation', vec, [], px + 115, { maxVars: 1, delta: 88 }),
                            varLink('Target', obj, [r.ball], px + 181, { prop: 'Target', writeable: true, maxVars: 1, delta: 159 })]],
      ...layout(3, parent, px, py, 219, 61)];
    node('SeqAct_SubtractFloat', step([r.join], math(r.z, r.lift, r.z2, x + 1950), x + 1950, y, 196));
    node('SeqAct_SetVectorComponents', step([r.place], xyz('Output Vector', 'OutVector', r.above, [r.x, r.y, r.z2], x + 2200, true), x + 2200, y, 168));
    node('SeqAct_SetLocation', setLocation(r.above, x + 2400, y));
    node('SeqAct_GetVectorComponents', step([r.mulX], xyz('Input Vector', 'InVector', r.dir, [r.fx, r.fy, r.fz], x + 1950, false), x + 1950, y2, 168));
    node('SeqAct_MultiplyFloat', step([r.mulY], math(r.fx, r.ahead, r.dx, x + 2150), x + 2150, y2, 196));
    node('SeqAct_MultiplyFloat', step([r.subX], math(r.fy, r.ahead, r.dy, x + 2380), x + 2380, y2, 196));
    node('SeqAct_SubtractFloat', step([r.subY], math(r.x, r.dx, r.x2, x + 2610), x + 2610, y2, 196));
    node('SeqAct_SubtractFloat', step([r.raiseFront], math(r.y, r.dy, r.y2, x + 2840), x + 2840, y2, 196));
    node('SeqAct_SetVectorComponents', step([r.placeFront], xyz('Output Vector', 'OutVector', r.front, [r.x2, r.y2, r.z3], x + 3070, true), x + 3070, y2, 168));
    node('SeqAct_SetLocation', setLocation(r.front, x + 3270, y2));
    node('SeqVar_Float', vars(vx + 1380, vy, [['FloatValue', F, -BALL_FRONT_LIFT]]));
    node('SeqVar_Float', vars(vx + 1440, vy));
    node('SeqAct_SubtractFloat', step([r.joinFront], math(r.z, r.frontLift, r.z3, x + 2840), x + 2840, y2 + 120, 196));
    if (ballSpawn) spawnNodes(r, r.ball, [r.where], x + 900, y + 400);
    placed(r, 'ball respawn');
  } else if (ballSpawn) {                         // an existing respawn script: its added ball goes through the check
    const added = nodeProps(pkg, pkg.exports[clearRef - 1]).OutputLinks[2].Links[0].LinkedOp - 1, p = nodeProps(pkg, pkg.exports[added]);
    const ballVar = p.VariableLinks.find(l => l.LinkDesc === 'SpawnedBall').LinkedVariables[0];
    const r = refs(SPAWN_NODES), linked = o => (o.Links || []).map(l => [l.LinkedOp, l.InputLinkIdx]);
    spawnNodes(r, ballVar, linked(p.OutputLinks[0]), x0 + 1700, y0 + 400);
    add.setProps(added, { OutputLinks: enc.prop('OutputLinks', A, p.OutputLinks.map((o, k) =>
      outputLink(o.LinkDesc, k === 0 ? [r.atStart] : linked(o), o.DrawY, o.OverrideDelta))) });
  }

  const triggers = [];
  let number = fresh ? 0 : checkpointZones(pkg).length;   // checkpoints are numbered on screen in the order they were added
  checkpoints.forEach(({ values, ball, ballOnTop = false, respawn = null, lava: isLava = false }, k) => {
    const trig = add.duplicate(template, [0, 0, 0], values);
    const dest = respawn ? add.duplicate(template, [0, 0, 0], respawn) : trig;   // the marker has no Touch event
    triggers.push(trig);
    const x = x0 + 600 * (k + 1), y = y0 + (isLava ? 1400 : 600);
    const setObject = (value, target, next, px, py) => [
      ['InputLinks', A, [inputLink(py + 34)]],
      ['OutputLinks', A, [outputLink('Out', next, py + 34)]],
      ['VariableLinks', A, [varLink('Value', obj, [value], px + 34, { prop: 'Value' }),
                            varLink('Target', obj, [target], px + 90, { prop: 'Targets', delta: 68 })]],
      ...layout(2, parent, px, py, 128, 61)];
    // lava re-arms fast: a touch within the delay is dropped, and a car resting in lava never touches it again
    const touch = (playerOnly, touched, instigator) => [
      ['Originator', O, trig + 1], ['MaxTriggerCount', I, 0], ['ReTriggerDelay', F, isLava ? 0.1 : 1.0], ...(playerOnly ? [] : [['bPlayerOnly', B, false]]),
      ['MaxWidth', I, 173],
      ['OutputLinks', A, [outputLink('Touched', touched, y + 69, 14), outputLink('UnTouched', [], y + 90, 35), outputLink('Empty', [], y + 111, 56)]],
      ['VariableLinks', A, [varLink('Instigator', obj, instigator, x + 86, { writeable: true, delta: 54 })]],
      ...layout(2, parent, x, y, 131, 176, `${ball ? 'Ball' : 'Car'} ${isLava ? 'lava' : 'checkpoint'} ${k + 1} Touch`)];
    const differs = (a, b, next, px) => [
      ['InputLinks', A, [inputLink(y + 36, 'In', 23)]],
      ['OutputLinks', A, [outputLink('A == B', [], y + 26, 13), outputLink('A != B', next, y + 46, 33)]],
      ['VariableLinks', A, [varLink('A', obj, [a], px + 49, { delta: 45 }), varLink('B', obj, [b], px + 74, { delta: 70 })]],
      ...layout(1, parent, px, y, 123, 85)];
    const say = (text, player, px, py) => [      // on screen for 2 seconds, set like the messages in Lethamyr's maps
      ['DisplayTimeSeconds', F, 2],
      ['DrawTextInfo', T, ['KismetDrawTextInfo', enc.props([['MessageText', S, text], ['MessageFontScale', T, ['Vector2D', pack('<2f', 2, 2)]],
                                                              ['MessageOffset', T, ['Vector2D', pack('<2f', -80, -300)]]])]],
      ['InputLinks', A, [inputLink(py + 36, 'Show', 13), inputLink(py + 56, 'Hide', 33)]],
      ['OutputLinks', A, [outputLink('Out', [], py + 46, 23)]],
      ['VariableLinks', A, [varLink('Target', obj, [player], px + 40, { prop: 'Targets', delta: 17 }),
                            varLink('String', cls('SeqVar_String'), [], 0, { hidden: true, delta: 0, minVars: 0 })]],
      ...layout(3, parent, px, py, 150, 77)];
    if (isLava) {
      if (ball && !clearRef) throw new Error("ball lava: this map's ball respawn script was not found");
      // teleport the car back and stop it, so it does not carry its speed on; a fresh ball as after a reset, and for
      // ball lava always one: in front of the car when the last checkpoint was a car one
      const r = refs(['player', 'dir', 'mag', 'teleport', 'stop', 'touch', ...(ball ? ['instigator', 'notCar', 'sameBall'] : []),
                      ...(ball && onTopRef ? ['zero', 'front'] : [])]);
      const vec = cls('SeqVar_Vector'), flt = cls('SeqVar_Float');
      node('SeqVar_Player', vars(x + 30, y + 220));
      node('SeqVar_Vector', vars(x + 80, y + 220));
      node('SeqVar_Float', vars(x + 130, y + 220));
      const [px, py] = [x + (ball ? 400 : 200), y];
      node('SeqAct_Teleport', [
        ['InputLinks', A, [inputLink(py + 34)]],
        ['OutputLinks', A, [outputLink('Out', [r.stop], py + 34)]],
        ['VariableLinks', A, [varLink('Target', obj, [r.player], px + 38, { prop: 'Targets' }),
                              varLink('Destination', obj, [lastRef], px + 113, { delta: 76 }),
                              varLink('Teleport Volumes', obj, [], 0, { prop: 'TeleportVolumes', hidden: true, delta: 0 })]],
        ...layout(2, parent, px, py, 166, 61)]);
      node('SeqAct_SetVelocity', [
        ['InputLinks', A, [inputLink(py + 34)]],
        ['OutputLinks', A, [outputLink('Out', [], py + 34)]],
        ['VariableLinks', A, [varLink('Target', obj, [r.player], px + 238, { prop: 'Targets' }),
                              varLink('Velocity Dir', vec, [r.dir], px + 302, { prop: 'VelocityDir', delta: 76 }),
                              varLink('Velocity Mag', flt, [r.mag], px + 371, { prop: 'VelocityMag', delta: 145 })]],
        ...layout(1, parent, px + 200, py, 214, 77)]);
      if (!ball) {
        node('SeqEvent_Touch', touch(true, [r.teleport, ...(hasBallRef ? [hasBallRef] : [])], []));
        placed(r, 'car lava');
        return;
      }
      node('SeqEvent_Touch', touch(false, [r.notCar], [r.instigator]));
      node('SeqVar_Object', vars(x + 180, y + 220));
      node('SeqCond_CompareObject', differs(r.instigator, r.player, [r.teleport, r.sameBall], x + 200));
      node('SeqCond_CompareObject', [
        ['InputLinks', A, [inputLink(py + 136, 'In', 23)]],
        ['OutputLinks', A, [outputLink('A == B', [[clearRef, 2]], py + 126, 13), outputLink('A != B', [onTopRef ? r.front : [clearRef, 2]], py + 146, 33)]],
        ['VariableLinks', A, [varLink('A', obj, [lastRef], px + 49, { delta: 45 }), varLink('B', obj, [lastBallRef], px + 74, { delta: 70 })]],
        ...layout(1, parent, px, py + 100, 123, 85)]);
      if (onTopRef) {
        const int = cls('SeqVar_Int');
        node('SeqVar_Int', vars(x + 230, y + 220));
        node('SeqAct_SetInt', [
          ['InputLinks', A, [inputLink(py + 134)]],
          ['OutputLinks', A, [outputLink('Out', [[clearRef, 2]], py + 134)]],
          ['VariableLinks', A, [varLink('Value', int, [r.zero], px + 234, { prop: 'Value' }),
                                varLink('Target', int, [onTopRef], px + 290, { prop: 'Target', writeable: true, delta: 68 })]],
          ...layout(2, parent, px + 200, py + 100, 128, 61)]);
      }
      placed(r, 'ball lava');
      return;
    }
    // only a checkpoint that isn't the last one already counts, and says so on screen: a reset inside a box
    // checkpoint touches it again
    number += 1;
    if (!ball) {
      const r = refs(['value', 'player', 'isNew', 'setLast', 'say', 'touch']);
      node('SeqVar_Object', vars(x + 30, y + 220, [['ObjValue', O, dest + 1]]));
      node('SeqVar_Player', vars(x + 80, y + 220));
      node('SeqCond_CompareObject', differs(lastRef, r.value, [r.setLast, r.say], x + 200));
      node('SeqAct_SetObject', setObject(r.value, lastRef, [], x + 360, y));
      node('SeqAct_DrawText', say(`Checkpoint ${number}`, r.player, x + 360, y + 100));
      node('SeqEvent_Touch', touch(true, [r.isNew], []));
      placed(r, 'car checkpoint');
      return;
    }
    // the zone fires for anything; only when what touched it is not the player's car was it the ball
    const r = refs(['value', 'instigator', 'player', 'notCar', 'isNew', 'setLast', 'setBall', 'say', 'touch', ...(onTopRef ? ['mode', 'setMode'] : [])]);
    node('SeqVar_Object', vars(x + 30, y + 220, [['ObjValue', O, dest + 1]]));
    node('SeqVar_Object', vars(x + 80, y + 220));
    node('SeqVar_Player', vars(x + 130, y + 220));
    node('SeqCond_CompareObject', differs(r.instigator, r.player, [r.isNew], x + 200));
    node('SeqCond_CompareObject', differs(lastRef, r.value, [r.setLast, r.say], x + 360));
    node('SeqAct_SetObject', setObject(r.value, lastRef, [r.setBall], x + 520, y));
    node('SeqAct_SetObject', setObject(r.value, lastBallRef, onTopRef ? [r.setMode] : [], x + 680, y));
    node('SeqAct_DrawText', say(`Checkpoint ${number}`, r.player, x + 520, y + 100));
    node('SeqEvent_Touch', touch(false, [r.notCar], [r.instigator]));
    if (onTopRef) {                               // maps made before the setting always put the ball on top
      const int = cls('SeqVar_Int');
      node('SeqVar_Int', vars(x + 180, y + 220, [['IntValue', I, ballOnTop ? 1 : 0]]));
      node('SeqAct_SetInt', [
        ['InputLinks', A, [inputLink(y + 34)]],
        ['OutputLinks', A, [outputLink('Out', [], y + 34)]],
        ['VariableLinks', A, [varLink('Value', int, [r.mode], x + 874, { prop: 'Value' }),
                              varLink('Target', int, [onTopRef], x + 930, { prop: 'Target', writeable: true, delta: 68 })]],
        ...layout(2, parent, x + 840, y, 128, 61)]);
    }
    placed(r, 'ball checkpoint');
  });

  add.appendRefs(seq, 'SequenceObjects', nodes.map(n => n + 1));
  return triggers;
}
