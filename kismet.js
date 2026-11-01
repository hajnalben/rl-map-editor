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

const nodeProps = (pkg, e) => decode(pkg, pkg.netIndexAt(e) + 4, e.off + e.size)[0];

const [I, F, B, O, N, S, A] = ['IntProperty', 'FloatProperty', 'BoolProperty', 'ObjectProperty', 'NameProperty', 'StrProperty', 'ArrayProperty'];

class Encoder {                                   // tagged-property writer; names go through the Additions
  constructor(add) { this.add = add; }
  props(props) { return concat(...props.map(p => this.prop(...p)), this.add.fname('None')); }
  prop(name, ptype, value) {
    const head = concat(this.add.fname(name), this.add.fname(ptype));
    if (ptype === B) return concat(head, pack('<ii', 0, 0), Uint8Array.of(value ? 1 : 0));
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

const varLink = (desc, expected, linked, x, { prop = 'None', writeable = false, hidden = false, delta = 16, maxVars = 255 } = {}) => [
  ['ExpectedType', O, expected], ['LinkedVariables', A, linked], ['LinkDesc', S, desc], ['LinkVar', N, 'None'],
  ['PropertyName', N, prop], ['bWriteable', B, writeable], ['bSequenceNeverReadsOnlyWritesToThisVar', B, false],
  ['bModifiesLinkedObject', B, false], ['bHidden', B, hidden], ['MinVars', I, 1], ['MaxVars', I, maxVars],
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
  const refs = nodeProps(pkg, pkg.exports[mainSequence(pkg)]).SequenceObjects;
  return new Set(Array.isArray(refs) ? refs.map(r => r - 1) : []);
}

function namedVar(pkg, name, live = liveNodes(pkg)) {   // export index of the live object variable called `name`, or null
  const i = pkg.exports.findIndex((e, k) => live.has(k) && pkg.classOf(e) === 'SeqVar_Object' && nodeProps(pkg, e).VarName === name);
  return i >= 0 ? i : null;
}

// Checkpoint zones as [{i, ball}]: every zone stored into LastCheckpoint when touched; ball checkpoints also go
// into LastBallCheckpoint.
export function checkpointZones(pkg) {
  const live = liveNodes(pkg), last = namedVar(pkg, 'LastCheckpoint', live), lastBall = namedVar(pkg, 'LastBallCheckpoint', live);
  if (last === null) return [];
  const zones = [], ballZones = new Set();
  for (const k of live) {
    const e = pkg.exports[k];
    if (pkg.classOf(e) !== 'SeqAct_SetObject') continue;
    const links = new Map((nodeProps(pkg, e).VariableLinks || []).map(l => [l.LinkDesc, l.LinkedVariables || []]));
    const target = links.get('Target') || [];
    for (const v of links.get('Value') || []) {
      const zone = v > 0 ? nodeProps(pkg, pkg.exports[v - 1]).ObjValue : null;
      if (!zone) continue;
      if (target.includes(last + 1)) zones.push(zone - 1);
      if (lastBall !== null && target.includes(lastBall + 1)) ballZones.add(zone - 1);
    }
  }
  return zones.map(i => ({ i, ball: ballZones.has(i) }));
}

const PACKAGES = { SeqEvent_CarSpawned_TA: 'TAGame', SeqAct_AddGameBall_TA: 'TAGame' };   // the others live in Engine
const BALL_LIFT = 200;                            // a respawned ball starts this far above the checkpoint, over the car

// Copy trigger zone `template` once per checkpoint ({values: {prop: [fmt, values]}, ball}) and wire Kismet:
// touching a car checkpoint with the car, or a ball checkpoint with the ball, makes it the respawn point, and a
// reset teleports the car there (with a fresh ball dropped onto it for ball checkpoints). The respawn logic is
// created once per map, or again when `fresh` (the main sequence was just emptied). Returns the new trigger indices.
export function addCheckpoints(add, template, checkpoints, fresh = false) {
  const pkg = add.pkg, enc = new Encoder(add);
  const seq = mainSequence(pkg), parent = seq + 1;
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
  const last = namedVar(pkg, 'LastCheckpoint', live);
  let lastRef = last === null ? null : last + 1;
  if (last === null) {
    const r = refs(['car', 'last', 'teleport', 'spawned']);
    lastRef = r.last;
    node('SeqVar_Object', vars(x0 + 100, y0 + 200));
    node('SeqVar_Object', vars(x0 + 300, y0 + 200, [['VarName', N, 'LastCheckpoint']]));
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

  const lastBall = namedVar(pkg, 'LastBallCheckpoint', live);
  let lastBallRef = lastBall === null ? null : lastBall + 1;
  if (lastBallRef === null && checkpoints.some(c => c.ball)) {
    // on reset, if the last checkpoint was a ball one: remove the balls, add one, lift it above the checkpoint
    const r = refs(['lastBall', 'none', 'player', 'ball', 'at', 'x', 'y', 'z', 'lift', 'z2', 'above',
                    'spawned', 'hasBall', 'isBall', 'clear', 'addBall', 'where', 'split', 'raise', 'join', 'place']);
    lastBallRef = r.lastBall;
    const [vx, vy, x, y] = [x0 + 1000, y0 + 220, x0 + 800, y0];
    const vec = cls('SeqVar_Vector'), flt = cls('SeqVar_Float');
    node('SeqVar_Object', vars(vx, vy, [['VarName', N, 'LastBallCheckpoint']]));
    node('SeqVar_Object', vars(vx + 60, vy));
    node('SeqVar_Player', vars(vx + 120, vy));
    node('SeqVar_Object', vars(vx + 180, vy));
    node('SeqVar_Vector', vars(vx + 240, vy));
    for (let k = 0; k < 3; k++) node('SeqVar_Float', vars(vx + 300 + 60 * k, vy));
    node('SeqVar_Float', vars(vx + 480, vy, [['FloatValue', F, -BALL_LIFT]]));
    node('SeqVar_Float', vars(vx + 540, vy));
    node('SeqVar_Vector', vars(vx + 600, vy));
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
    node('SeqAct_AddGameBall_TA', addBall({ Added: [r.where] }, [lastRef], [r.ball], x + 900));
    const step = (outTo, links, px, w, version = 1) => [
      ['InputLinks', A, [inputLink(y + 34)]],
      ['OutputLinks', A, [outputLink('Out', outTo, y + 34)]],
      ['VariableLinks', A, links],
      ...layout(version, parent, px, y, w, 77)];
    node('SeqAct_GetLocationAndRotation', step([r.split], [
      varLink('Target', obj, [lastRef], x + 1238, { prop: 'Targets', maxVars: 1 }),
      varLink('Location', vec, [r.at], x + 1304, { prop: 'Location', writeable: true, delta: 76 }),
      varLink('Rotation Vector', vec, [], x + 1375, { prop: 'RotationVector', writeable: true, delta: 148 }),
      varLink('Rotation', vec, [], x + 1446, { prop: 'Rotation', writeable: true, delta: 219 })], x + 1200, 290, 3));
    const xyz = (first, firstProp, vector, zVar, px, writeable) => [
      varLink(first, vec, [vector], px + 46, { prop: firstProp, writeable, delta: 22 }),
      varLink('X', flt, [r.x], px + 91, { prop: 'X', delta: 87 }), varLink('Y', flt, [r.y], px + 116, { prop: 'Y', delta: 112 }),
      varLink('Z', flt, [zVar], px + 141, { prop: 'Z', delta: 137 })];
    node('SeqAct_GetVectorComponents', step([r.raise], xyz('Input Vector', 'InVector', r.at, r.z, x + 1550, false), x + 1550, 168));
    node('SeqAct_SubtractFloat', step([r.join], [
      varLink('A', flt, [r.z], x + 1770, { prop: 'ValueA' }), varLink('B', flt, [r.lift], x + 1795, { prop: 'ValueB', delta: 41 }),
      varLink('FloatResult', flt, [r.z2], x + 1835, { prop: 'FloatResult', writeable: true, delta: 65 }),
      varLink('IntResult', cls('SeqVar_Int'), [], x + 1900, { prop: 'IntResult', writeable: true, delta: 121 })], x + 1750, 196));
    node('SeqAct_SetVectorComponents', step([r.place], xyz('Output Vector', 'OutVector', r.above, r.z2, x + 2000, true), x + 2000, 168));
    node('SeqAct_SetLocation', [
      ['InputLinks', A, [inputLink(y + 34)]],
      ['OutputLinks', A, [outputLink('Out', [], y + 34)]],
      ['VariableLinks', A, [varLink('Location', vec, [r.above], x + 2244, { maxVars: 1 }),
                            varLink('Rotation', vec, [], x + 2315, { maxVars: 1, delta: 88 }),
                            varLink('Target', obj, [r.ball], x + 2381, { prop: 'Target', writeable: true, maxVars: 1, delta: 159 })]],
      ...layout(3, parent, x + 2200, y, 219, 61)]);
    placed(r, 'ball respawn');
  }

  const triggers = [];
  checkpoints.forEach(({ values, ball }, k) => {
    const trig = add.duplicate(template, [0, 0, 0], values);
    triggers.push(trig);
    const x = x0 + 600 * (k + 1), y = y0 + 600;
    const setObject = (value, target, next, px, py) => [
      ['InputLinks', A, [inputLink(py + 34)]],
      ['OutputLinks', A, [outputLink('Out', next, py + 34)]],
      ['VariableLinks', A, [varLink('Value', obj, [value], px + 34, { prop: 'Value' }),
                            varLink('Target', obj, [target], px + 90, { prop: 'Targets', delta: 68 })]],
      ...layout(2, parent, px, py, 128, 61)];
    const touch = (playerOnly, touched, instigator) => [
      ['Originator', O, trig + 1], ['MaxTriggerCount', I, 0], ['ReTriggerDelay', F, 1.0], ...(playerOnly ? [] : [['bPlayerOnly', B, false]]),
      ['MaxWidth', I, 173],
      ['OutputLinks', A, [outputLink('Touched', touched, y + 69, 14), outputLink('UnTouched', [], y + 90, 35), outputLink('Empty', [], y + 111, 56)]],
      ['VariableLinks', A, [varLink('Instigator', obj, instigator, x + 86, { writeable: true, delta: 54 })]],
      ...layout(2, parent, x, y, 131, 176, `${ball ? 'Ball' : 'Car'} checkpoint ${k + 1} Touch`)];
    if (!ball) {
      const r = refs(['value', 'setLast', 'touch']);
      node('SeqVar_Object', vars(x + 30, y + 220, [['ObjValue', O, trig + 1]]));
      node('SeqAct_SetObject', setObject(r.value, lastRef, [], x + 200, y));
      node('SeqEvent_Touch', touch(true, [r.setLast], []));
      placed(r, 'car checkpoint');
      return;
    }
    // the zone fires for anything; only when what touched it is not the player's car was it the ball
    const r = refs(['value', 'instigator', 'player', 'notCar', 'setLast', 'setBall', 'touch']);
    node('SeqVar_Object', vars(x + 30, y + 220, [['ObjValue', O, trig + 1]]));
    node('SeqVar_Object', vars(x + 80, y + 220));
    node('SeqVar_Player', vars(x + 130, y + 220));
    node('SeqCond_CompareObject', [
      ['InputLinks', A, [inputLink(y + 36, 'In', 23)]],
      ['OutputLinks', A, [outputLink('A == B', [], y + 26, 13), outputLink('A != B', [r.setLast], y + 46, 33)]],
      ['VariableLinks', A, [varLink('A', obj, [r.instigator], x + 249, { delta: 45 }), varLink('B', obj, [r.player], x + 274, { delta: 70 })]],
      ...layout(1, parent, x + 200, y, 123, 85)]);
    node('SeqAct_SetObject', setObject(r.value, lastRef, [r.setBall], x + 360, y));
    node('SeqAct_SetObject', setObject(r.value, lastBallRef, [], x + 520, y));
    node('SeqEvent_Touch', touch(false, [r.notCar], [r.instigator]));
    placed(r, 'ball checkpoint');
  });

  add.appendRefs(seq, 'SequenceObjects', nodes.map(n => n + 1));
  return triggers;
}
