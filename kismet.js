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

export const [I, F, B, O, N, S, A, T, E] = ['IntProperty', 'FloatProperty', 'BoolProperty', 'ObjectProperty', 'NameProperty', 'StrProperty', 'ArrayProperty', 'StructProperty', 'ByteProperty'];

class Encoder {                                   // tagged-property writer; names go through the Additions
  constructor(add) { this.add = add; }
  props(props) { return concat(...props.map(p => this.prop(...p)), this.add.fname('None')); }
  prop(name, ptype, value) {
    const head = concat(this.add.fname(name), this.add.fname(ptype));
    if (ptype === B) return concat(head, pack('<ii', 0, 0), Uint8Array.of(value ? 1 : 0));
    if (ptype === T) return this.add.tag(name, T, value[1], value[0]);   // [struct name, its bytes]: raw for atomic structs, else tagged properties
    if (ptype === E) return concat(head, pack('<ii', 8, 0), this.add.fname(value[0]), this.add.fname(value[1]));   // [enum, value]
    const body = this.value(ptype, value);
    return concat(head, pack('<ii', body.length, 0), body);
  }
  value(ptype, value) {
    if (ptype === I || ptype === O) return pack('<i', value);
    if (ptype === F) return pack('<f', value);
    if (ptype === N) return this.add.fname(value);
    if (ptype === S) {                            // Latin-1, or UTF-16 (a negative length) for anything beyond it
      if (/^[\x00-\xff]*$/.test(value)) return concat(pack('<i', value.length + 1), latin1Bytes(value), new Uint8Array(1));
      return concat(pack('<i', -(value.length + 1)), new Uint8Array(Uint16Array.from((value + '\0').split(''), ch => ch.charCodeAt(0)).buffer));
    }
    if (ptype === A) {
      if (value.length && Array.isArray(value[0])) return concat(pack('<i', value.length), ...value.map(v => this.props(v)));   // structs
      return pack(`<i${value.length}i`, value.length, ...value);                            // object refs
    }
    throw new Error(ptype);
  }
}

// Link records exactly as UDK 2015 saves them (every field, in this order).
export const inputLink = (y, desc = 'In', delta = 11) => [['LinkDesc', S, desc], ['bHasImpulse', B, false], ['QueuedActivations', I, 0], ['bDisabled', B, false],
  ['bDisabledPIE', B, false], ['LinkedOp', O, 0], ['DrawY', I, y], ['bHidden', B, false],
  ['ActivateDelay', F, 0.0], ['bClampedMax', B, false], ['bClampedMin', B, false], ['OverrideDelta', I, delta]];

// targets: node refs, or [ref, input index] to enter a node through another input than its first
export const outputLink = (desc, targets, y, delta = 11) => [['Links', A, targets.map(t => [t].flat()).map(([t, k = 0]) => [['LinkedOp', O, t], ['InputLinkIdx', I, k]])],
  ['LinkDesc', S, desc], ['bHasImpulse', B, false], ['bDisabled', B, false], ['bDisabledPIE', B, false], ['LinkedOp', O, 0],
  ['ActivateDelay', F, 0.0], ['DrawY', I, y], ['bHidden', B, false], ['bClampedMax', B, false],
  ['bClampedMin', B, false], ['OverrideDelta', I, delta]];

export const varLink = (desc, expected, linked, x, { prop = 'None', writeable = false, hidden = false, delta = 16, minVars = 1, maxVars = 255, any = false } = {}) => [
  ['ExpectedType', O, expected], ['LinkedVariables', A, linked], ['LinkDesc', S, desc], ['LinkVar', N, 'None'],
  ['PropertyName', N, prop], ['bWriteable', B, writeable], ['bSequenceNeverReadsOnlyWritesToThisVar', B, false],
  ['bModifiesLinkedObject', B, false], ['bHidden', B, hidden], ['MinVars', I, minVars], ['MaxVars', I, maxVars],
  ['DrawX', I, x], ['bAllowAnyType', B, any], ['bClampedMax', B, false], ['bClampedMin', B, false],
  ['OverrideDelta', I, delta]];

export const layout = (version, parent, x, y, w, h, name = null) => [['ObjInstanceVersion', I, version], ['ParentSequence', O, parent],
  ['ObjPosX', I, x], ['ObjPosY', I, y], ...(name ? [['ObjName', S, name]] : []), ['DrawWidth', I, w], ['DrawHeight', I, h]];

// on-screen text (SeqAct_DrawText's DrawTextInfo), set like the messages in Lethamyr's maps; `at` is its offset from
// the middle of the screen (checkpoint titles by default)
export const textInfo = (add, text, at = [-80, -300], size = 2, color = null) => new Encoder(add).props([['MessageText', S, text],
  ['MessageFontScale', T, ['Vector2D', pack('<2f', size, size)]], ['MessageOffset', T, ['Vector2D', pack('<2f', ...at)]],
  ...(color ? [['MessageColor', T, ['Color', Uint8Array.of(color[2], color[1], color[0], 255)]]] : [])]);

export function mainSequence(pkg) {
  const level = pkg.levelIndex() + 1;
  return pkg.exports.findIndex(e => pkg.classOf(e) === 'Sequence' && e.outer === level);
}


// Nodes the main sequence runs. Maps keep nodes taken out of it (a fresh start empties it), so lookups skip those.
export function liveNodes(pkg) {
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
// where it always goes on top). textNode is the SeqAct_DrawText showing its title when it becomes the respawn point
// (title its text), null in maps made before checkpoints had one.
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
  return { props, links, callers, touchOf };
}

export function checkpointZones(pkg) {
  const all = liveNodes(pkg), keys = new Set(keyNodes(pkg, all)), live = new Set([...all].filter(k => !keys.has(k)));   // the keys set LastCheckpoint too
  const last = namedVar(pkg, 'LastCheckpoint', live), lastBall = namedVar(pkg, 'LastBallCheckpoint', live);
  if (last === null) return [];
  const onTop = namedVar(pkg, 'BallOnTop', live, 'SeqVar_Int');
  const { props, links, callers, touchOf } = graph(pkg, live);
  const touchedZone = k => { const t = touchOf(k); return t < 0 ? -1 : (props.get(t).Originator || 0) - 1; };
  const textOf = k => {                           // the DrawText beside the SetObject, run by the same check
    const check = callers.get(k)?.[0];
    const ops = check === undefined ? [] : (props.get(check).OutputLinks || []).flatMap(o => o.Links || []).map(l => l.LinkedOp - 1);
    return ops.find(j => j >= 0 && pkg.classOf(pkg.exports[j]) === 'SeqAct_DrawText') ?? null;
  };
  const found = [], balls = new Map();
  for (const k of live) {
    if (pkg.classOf(pkg.exports[k]) !== 'SeqAct_SetObject') continue;
    const target = links(k).get('Target') || [];
    for (const v of links(k).get('Value') || []) {
      const dest = v > 0 ? (props.get(v - 1) ?? nodeProps(pkg, pkg.exports[v - 1])).ObjValue - 1 : -1;
      if (dest < 0) continue;
      if (target.includes(last + 1)) {
        const zone = touchedZone(k), textNode = textOf(k);
        found.push({ i: zone >= 0 ? zone : dest, dest, valueVar: v - 1, textNode,
                     title: textNode === null ? null : props.get(textNode)?.DrawTextInfo?.MessageText ?? '' });
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

const packageOf = name => /_TA$/.test(name) ? 'TAGame' : /_X$/.test(name) ? 'ProjectX' : 'Engine';   // Rocket League's own classes, then UE3's
// Where a respawned ball starts, from the spot the car is teleported to (30 above the ground when there is ground):
// on top, just over the roof; in front, this far ahead the way the checkpoint faces, just over the ground.
export const BALL_LIFT = 130;
export const BALL_AHEAD = 250;
export const BALL_FRONT_LIFT = 65;
export const BALL_TOP_AHEAD = 40;                 // a ball on the car sits this far ahead of the car's middle

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
// Kismet nodes added to the main sequence: node(class, props) adds one; refs(names) gives the references the next
// nodes will get, in order, so they can link to each other before they exist; placed() checks that order held.
export function writer(add) {
  const pkg = add.pkg, enc = new Encoder(add), parent = mainSequence(pkg) + 1, classes = new Map(), nodes = [];
  const cls = name => {
    if (!classes.has(name)) classes.set(name, add.classRef(name, packageOf(name)));
    return classes.get(name);
  };
  const node = (className, props, tail = new Uint8Array(0)) => {
    const i = add.addObject(cls(className), parent, className, concat(pack('<i', 0), enc.props(props), tail));
    nodes.push(i);
    return i;
  };
  const refs = names => Object.fromEntries(names.map((n, k) => [n, pkg.exports.length + add.added.length + 1 + k]));
  const placed = (r, from) => { if (nodes.slice(-Object.keys(r).length).some((n, k) => n + 1 !== Object.values(r)[k])) throw new Error(`${from}: node order`); };
  const vars = (x, y, extra = []) => [...extra, ...layout(1, parent, x, y, 32, 32)];
  return { enc, parent, cls, node, nodes, refs, placed, vars };
}

export function addCheckpoints(add, template, checkpoints, fresh = false, spawn = null, ballSpawn = null) {
  const pkg = add.pkg, seq = mainSequence(pkg);
  if (seq < 0) throw new Error('this map has no Kismet sequence to hold checkpoints');
  const { enc, parent, cls, node, nodes, refs, placed, vars } = writer(add);
  const obj = cls('SeqVar_Object');

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
    // on reset, if the last checkpoint was a ball one: remove the balls, add one, and put it over the checkpoint (on the
    // car, a little ahead of its middle) or ahead of it along the way it faces
    const r = refs(['lastBall', 'onTop', 'one', 'none', 'player', 'ball', 'at', 'dir', 'x', 'y', 'z', 'fx', 'fy', 'fz', 'lift', 'ahead',
                    'z2', 'dx', 'dy', 'x2', 'y2', 'above', 'front', 'spawned', 'hasBall', 'isBall', 'clear', 'addBall', 'where', 'split',
                    'which', 'raise', 'join', 'place', 'splitDir', 'mulX', 'mulY', 'subX', 'subY', 'joinFront', 'placeFront', 'frontLift', 'z3', 'raiseFront',
                    'topAhead', 'tdx', 'tdy', 'tx', 'ty', 'topDir', 'topMulX', 'topMulY', 'topSubX', 'topSubY',
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
    node('SeqAct_SubtractFloat', step([r.topDir], math(r.z, r.lift, r.z2, x + 1950), x + 1950, y, 196));
    node('SeqAct_SetVectorComponents', step([r.place], xyz('Output Vector', 'OutVector', r.above, [r.tx, r.ty, r.z2], x + 2200, true), x + 2200, y, 168));
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
    // on top: a little ahead of the car's middle, along the way the checkpoint faces
    const yTop = y - 250;
    node('SeqVar_Float', vars(vx + 1500, vy, [['FloatValue', F, -BALL_TOP_AHEAD]]));
    for (let k = 0; k < 4; k++) node('SeqVar_Float', vars(vx + 1560 + 60 * k, vy));
    node('SeqAct_GetVectorComponents', step([r.topMulX], xyz('Input Vector', 'InVector', r.dir, [r.fx, r.fy, r.fz], x + 1950, false), x + 1950, yTop, 168));
    node('SeqAct_MultiplyFloat', step([r.topMulY], math(r.fx, r.topAhead, r.tdx, x + 2150), x + 2150, yTop, 196));
    node('SeqAct_MultiplyFloat', step([r.topSubX], math(r.fy, r.topAhead, r.tdy, x + 2380), x + 2380, yTop, 196));
    node('SeqAct_SubtractFloat', step([r.topSubY], math(r.x, r.tdx, r.tx, x + 2610), x + 2610, yTop, 196));
    node('SeqAct_SubtractFloat', step([r.join], math(r.y, r.tdy, r.ty, x + 2840), x + 2840, yTop, 196));
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
  checkpoints.forEach(({ values, ball, ballOnTop = false, respawn = null, lava: isLava = false, title = '' }, k) => {
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
    const say = (text, player, px, py) => [      // on screen for 2 seconds
      ['DisplayTimeSeconds', F, 2],
      ['DrawTextInfo', T, ['KismetDrawTextInfo', textInfo(add, text)]],
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
      node('SeqAct_DrawText', say(title || `Checkpoint ${number}`, r.player, x + 360, y + 100));
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
    node('SeqAct_DrawText', say(title || `Checkpoint ${number}`, r.player, x + 520, y + 100));
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

// Timer and death counter, drawn like Medieval Rings' clock: a loop that waits a second, counts, and shows
// "Time: M:SS" for that second. The timer freezes for good once the last checkpoint is the respawn point.
// "Deaths: N" stays on screen until the next death redraws it; deaths are lava touches and resets, counted from a
// second after the car first spawns (Free Play's own ball may land in lava at the start). The block hangs off events
// named "HUD: ..." and reaches LastCheckpoint only by name, so all of it can be taken out again (blockNodes).
const HUD = 'HUD: ';
export function hudOf(pkg) {                      // the {timer, deaths} a map shows, or null
  for (const k of liveNodes(pkg)) {
    if (pkg.classOf(pkg.exports[k]) !== 'SeqEvent_LevelLoaded') continue;
    const name = nodeProps(pkg, pkg.exports[k]).ObjName;
    if (typeof name === 'string' && name.startsWith(HUD)) return { timer: name.includes('timer'), deaths: name.includes('deaths') };
  }
  return null;
}
function blockNodes(pkg, live, prefix) {          // a block: its events named `prefix`..., and everything they lead to or link
  const props = k => nodeProps(pkg, pkg.exports[k]);
  const todo = [...live].filter(k => /^SeqEvent/.test(pkg.classOf(pkg.exports[k])) && String(props(k).ObjName ?? '').startsWith(prefix));
  const seen = new Set(todo);
  while (todo.length) {
    const p = props(todo.pop());
    for (const r of [...(p.OutputLinks || []).flatMap(o => (o.Links || []).map(l => l.LinkedOp)), ...(p.VariableLinks || []).flatMap(v => v.LinkedVariables || [])]) {
      if (r > 0 && live.has(r - 1) && !seen.has(r - 1)) { seen.add(r - 1); todo.push(r - 1); }
    }
  }
  return seen;
}

// Replace the map's timer and death counter with `want` ({timer, deaths}; both off takes it out). `finish` is the
// actor the last checkpoint makes the respawn point (null: there is none, and the timer never stops); `lava` the
// lava zones ([{i, ball}]) whose touches count as deaths.
export function setHud(add, { timer = false, deaths = false }, finish, lava) {
  const pkg = add.pkg, seq = mainSequence(pkg), old = blockNodes(pkg, liveNodes(pkg), HUD);
  if (old.size) add.appendRefs(seq, 'SequenceObjects', [], r => !old.has(r - 1));
  if (!timer && !deaths) return;
  const { parent, cls, node, nodes, refs, placed, vars } = writer(add);
  const obj = cls('SeqVar_Object'), int = cls('SeqVar_Int'), bool = cls('SeqVar_Bool'), str = cls('SeqVar_String'), flt = cls('SeqVar_Float');
  const x0 = 40000, y0 = 30000, stops = timer && finish !== null;
  const names = ['player', 'one', ...(stops || deaths ? ['yes'] : []),
    ...(timer ? ['seconds', 'minutes', 'sixty', 'ten', 'zero', 'secText', 'timeText'] : []), ...(stops ? ['done', 'last', 'finish'] : []),
    ...(deaths ? ['deaths', 'started', 'deathText'] : []), 'loaded', ...(timer ? ['wait'] : []), ...(stops ? ['isDone', 'atFinish', 'setDone'] : []),
    ...(timer ? ['tick', 'minute', 'wrap', 'addMinute', 'pad', 'padded', 'plain', 'join', 'showTime'] : []),
    ...(deaths ? ['spawned', 'wasStarted', 'arm', 'setStarted', 'ifStarted', 'keyReset', 'addDeath', 'hideDeaths', 'countText', 'showDeaths'] : [])];
  const r = refs(names);
  const at = n => [x0 + 220 * (names.indexOf(n) % 12), y0 + 200 * Math.floor(names.indexOf(n) / 12)];
  const op = (n, version, ins, outs, links, extra = [], w = 150, h = 77, name = null) => {
    const [x, y] = at(n);
    return [...extra, ['InputLinks', A, ins.map(([desc, delta]) => inputLink(y + delta, desc, delta))],
            ['OutputLinks', A, outs.map(([desc, to, delta]) => outputLink(desc, to, y + delta, delta))], ['VariableLinks', A, links(x)],
            ...layout(version, parent, x, y, w, h, name)];
  };
  const value = (n, extra = []) => vars(...at(n), extra);
  const math = (n, a, b, result, next, sub = false) => op(n, 1, [['In', 11]], [['Out', next, 11]], x => [
    varLink('A', int, [a], x + 16, { prop: 'ValueA' }), varLink('B', int, [b], x + 41, { prop: 'ValueB', delta: 41 }),
    varLink('IntResult', int, [result], x + 65, { prop: 'IntResult', writeable: true, delta: 65 }),
    varLink('FloatResult', flt, [], x + 140, { prop: 'FloatResult', writeable: true, delta: 140 })]);
  const compareInt = (n, a, b, below, atLeast) => op(n, 1, [['In', 59]],
    [['A <= B', [], 15], ['A > B', [], 37], ['A == B', [], 59], ['A < B', below, 81], ['A >= B', atLeast, 103]],
    x => [varLink('A', int, [a], x + 29, { prop: 'ValueA', delta: 29 }), varLink('B', int, [b], x + 54, { prop: 'ValueB', delta: 54 })], [], 91, 157);
  const compareBool = (n, v, yes, no) => op(n, 2, [['In', 23]], [['True', yes, 13], ['False', no, 33]],
    x => [varLink('Bool', bool, [v], x + 16), varLink('Result', bool, [], x + 59, { prop: 'bResult', writeable: true, delta: 59 })]);
  const setTrue = (n, target, next) => op(n, 1, [['In', 11]], [['Out', next, 11]],
    x => [varLink('Value', bool, [r.yes], x + 16, { minVars: 0 }), varLink('Target', bool, [target], x + 68, { writeable: true, delta: 68 })]);
  const toText = (n, inputs, out, next, separator = '') => op(n, 2, [['In', 11]], [['Out', next, 11]], x => [
    ...inputs.map((v, k) => varLink('Inputs', obj, [v], x + 16 + 58 * k, { prop: 'Targets', any: true, delta: 16 + 58 * k })),
    varLink('Output', str, [out], x + 132, { writeable: true, delta: 132 })],
    [['VarSeparator', S, separator], ...(inputs.length > 1 ? [['NumberOfInputs', I, inputs.length]] : [])]);
  // seconds null: on screen until a Hide at the same offset
  const show = (n, label, text, offset, next, seconds = 1) => op(n, 3, [['Show', 13], ['Hide', 33]], [['Out', next, 23]], x => [
    varLink('Target', obj, [r.player], x + 17, { prop: 'Targets', delta: 17 }), varLink('String', str, [text], x + 76, { minVars: 0, delta: 76 })],
    [...(seconds === null ? [] : [['DisplayTimeSeconds', F, seconds]]), ['DrawTextInfo', T, ['KismetDrawTextInfo', textInfo(add, label, offset)]]]);
  const delay = (n, next) => op(n, 1, [['Start', 14], ['Stop', 35], ['Pause', 56]], [['Finished', next, 19], ['Aborted', [], 51]],
    x => [varLink('Duration', flt, [], x + 25, { prop: 'Duration', delta: 25 })], [['Duration', F, 1]]);
  const deathsAt = [-40, timer ? -180 : -220];
  const spec = {
    player: ['SeqVar_Player', value('player')], yes: ['SeqVar_Bool', value('yes', [['bValue', I, 1]])], one: ['SeqVar_Int', value('one', [['IntValue', I, 1]])],
    seconds: ['SeqVar_Int', value('seconds')], minutes: ['SeqVar_Int', value('minutes')],
    sixty: ['SeqVar_Int', value('sixty', [['IntValue', I, 60]])], ten: ['SeqVar_Int', value('ten', [['IntValue', I, 10]])],
    zero: ['SeqVar_String', value('zero', [['StrValue', S, '0']])], secText: ['SeqVar_String', value('secText')], timeText: ['SeqVar_String', value('timeText')],
    done: ['SeqVar_Bool', value('done')], last: ['SeqVar_Named', value('last', [['ExpectedType', O, obj], ['FindVarName', N, 'LastCheckpoint']])],
    finish: ['SeqVar_Object', value('finish', finish === null ? [] : [['ObjValue', O, finish + 1]])],
    deaths: ['SeqVar_Int', value('deaths')], started: ['SeqVar_Bool', value('started')], deathText: ['SeqVar_String', value('deathText')],
    loaded: ['SeqEvent_LevelLoaded', op('loaded', 3, [], [['Loaded and Visible', timer ? [[r.wait, 0]] : [], 14], ['Beginning of Level', [], 35], ['Level Reset', [], 56]],
                                        () => [], [['MaxWidth', I, 136]], 98, 85, `${HUD}${[timer && 'timer', deaths && 'deaths'].filter(Boolean).join(' and ')}`)],
    wait: ['SeqAct_Delay', delay('wait', stops ? [r.isDone] : [r.tick])],
    isDone: ['SeqCond_CompareBool', compareBool('isDone', r.done, [r.showTime], [r.atFinish])],
    atFinish: ['SeqCond_CompareObject', op('atFinish', 1, [['In', 23]], [['A == B', [r.setDone], 13], ['A != B', [r.tick], 33]],
                                           x => [varLink('A', obj, [r.last], x + 49, { delta: 45 }), varLink('B', obj, [r.finish], x + 74, { delta: 70 })], [], 123, 85)],
    setDone: ['SeqAct_SetBool', setTrue('setDone', r.done, [r.showTime])],
    tick: ['SeqAct_AddInt', math('tick', r.seconds, r.one, r.seconds, [r.minute])],
    minute: ['SeqCond_CompareInt', compareInt('minute', r.seconds, r.sixty, [r.pad], [r.wrap])],
    wrap: ['SeqAct_SubtractInt', math('wrap', r.seconds, r.sixty, r.seconds, [r.addMinute])],
    addMinute: ['SeqAct_AddInt', math('addMinute', r.minutes, r.one, r.minutes, [r.pad])],
    pad: ['SeqCond_CompareInt', compareInt('pad', r.seconds, r.ten, [r.padded], [r.plain])],
    padded: ['SeqAct_ConvertToString', toText('padded', [r.zero, r.seconds], r.secText, [r.join])],
    plain: ['SeqAct_ConvertToString', toText('plain', [r.seconds], r.secText, [r.join])],
    join: ['SeqAct_ConvertToString', toText('join', [r.minutes, r.secText], r.timeText, [r.showTime], ':')],
    showTime: ['SeqAct_DrawText', show('showTime', 'Time: ', r.timeText, [-40, -220], [[r.wait, 0]])],
    spawned: ['SeqEvent_CarSpawned_TA', op('spawned', 1, [], [['Out', [r.wasStarted], 66]],
                                          x => [varLink('Instigator', obj, [], x + 48, { writeable: true })], [['MaxWidth', I, 97]], 68, 128, `${HUD}reset death`)],
    wasStarted: ['SeqCond_CompareBool', compareBool('wasStarted', r.started, [r.addDeath], [[r.arm, 0]])],
    arm: ['SeqAct_Delay', delay('arm', [r.setStarted])],
    setStarted: ['SeqAct_SetBool', setTrue('setStarted', r.started, [[r.hideDeaths, 1]])],
    ifStarted: ['SeqCond_CompareBool', compareBool('ifStarted', r.started, [r.addDeath], [])],
    keyReset: ['SeqEvent_RemoteEvent', op('keyReset', 2, [], [['Out', [r.ifStarted], 11]], x => [varLink('Instigator', obj, [], x + 30, { writeable: true })],
                                          [['EventName', N, KEY_RESET]], 150, 77, `${HUD}key reset death`)],
    addDeath: ['SeqAct_AddInt', math('addDeath', r.deaths, r.one, r.deaths, [[r.hideDeaths, 1]])],
    hideDeaths: ['SeqAct_DrawText', show('hideDeaths', 'Deaths: ', r.deathText, deathsAt, [r.countText], null)],
    countText: ['SeqAct_ConvertToString', toText('countText', [r.deaths], r.deathText, [r.showDeaths])],
    showDeaths: ['SeqAct_DrawText', show('showDeaths', 'Deaths: ', r.deathText, deathsAt, [], null)],
  };
  for (const n of names) node(...spec[n]);
  placed(r, 'timer and deaths');

  if (deaths) lava.forEach(({ i, ball }, k) => {     // a touch of its own on each lava zone, beside the zone's reset
    const [x, y] = [x0 + 300 * k, y0 + 1000];
    const z = refs(ball ? ['instigator', 'notCar', 'touch'] : ['touch']);
    if (ball) {
      node('SeqVar_Object', vars(x + 30, y + 220));
      node('SeqCond_CompareObject', [['InputLinks', A, [inputLink(y + 36, 'In', 23)]],
        ['OutputLinks', A, [outputLink('A == B', [], y + 26, 13), outputLink('A != B', [r.ifStarted], y + 46, 33)]],
        ['VariableLinks', A, [varLink('A', obj, [z.instigator], x + 249, { delta: 45 }), varLink('B', obj, [r.player], x + 274, { delta: 70 })]],
        ...layout(1, parent, x + 200, y, 123, 85)]);
    }
    node('SeqEvent_Touch', [['Originator', O, i + 1], ['MaxTriggerCount', I, 0], ['ReTriggerDelay', F, 0.1], ...(ball ? [['bPlayerOnly', B, false]] : []),
      ['MaxWidth', I, 173], ['OutputLinks', A, [outputLink('Touched', ball ? [z.notCar] : [r.ifStarted], y + 69, 14), outputLink('UnTouched', [], y + 90, 35), outputLink('Empty', [], y + 111, 56)]],
      ['VariableLinks', A, [varLink('Instigator', obj, ball ? [z.instigator] : [], x + 86, { writeable: true, delta: 54 })]],
      ...layout(2, parent, x, y, 131, 176, `${HUD}${ball ? 'ball' : 'car'} lava death`)]);
    placed(z, 'lava death');
  });
  add.appendRefs(seq, 'SequenceObjects', nodes.map(n => n + 1));
}

// Quick-chat keys on checkpoint maps: ChatPreset1 resets to the last checkpoint at once (as lava does, without the
// respawn's wait), ChatPreset2 and ChatPreset3 go to the previous and next checkpoint, the spawn counting as the
// first, as Kaokor's maps step through levels. Each key is polled and acts once per press. A key reset also fires the
// remote event KEY_RESET, which the death counter and scripts' reset hear. The block is written anew on every save;
// it links into the checkpoints' own nodes, so it keeps its node list in its event's comment and that is what goes.
const KEYS = 'Keys';
export const KEY_RESET = 'Keys reset';
export const keysOf = pkg => keyNodes(pkg).length > 0;
function keyNodes(pkg, live = liveNodes(pkg)) {
  return [...live].flatMap(k => {
    if (pkg.classOf(pkg.exports[k]) !== 'SeqEvent_LevelLoaded') return [];
    const p = nodeProps(pkg, pkg.exports[k]);
    return p.ObjName === KEYS ? [k, ...JSON.parse(p.ObjComment).nodes] : [];
  });
}
export function setKeys(add, spawn) {
  const pkg = add.pkg, seq = mainSequence(pkg), live = liveNodes(pkg), old = new Set(keyNodes(pkg, live));
  if (old.size) add.appendRefs(seq, 'SequenceObjects', [], r => !old.has(r - 1));
  const last = namedVar(pkg, 'LastCheckpoint', live), zones = checkpointZones(pkg);
  if (last === null || spawn === null || !zones.length) return;
  const lastBall = namedVar(pkg, 'LastBallCheckpoint', live), onTop = namedVar(pkg, 'BallOnTop', live, 'SeqVar_Int');
  const { hasBall } = lastBall === null ? {} : ballChainEntries(pkg, live, lastBall), atSpawn = spawnBall(pkg, spawn);
  const stops = [{ dest: spawn, ball: !!atSpawn, ballOnTop: !!atSpawn?.onTop, textNode: null, modeVar: atSpawn ? 0 : null }, ...zones];
  const { parent, cls, node, nodes, refs, placed, vars } = writer(add);
  const obj = cls('SeqVar_Object'), bool = cls('SeqVar_Bool'), int = cls('SeqVar_Int');
  const keys = [['reset', 'ChatPreset1'], ['prev', 'ChatPreset2'], ['next', 'ChatPreset3']], x0 = 40000, y0 = 20000;
  const names = ['loaded', 'player', 'yes', 'no', 'dir', 'mag', 'teleport', 'stop', 'activate',
    ...keys.flatMap(([k]) => [`${k}Wait`, `${k}Check`, `${k}Down`, `${k}IsDown`, `${k}Press`, `${k}Release`]),
    ...stops.flatMap((s, k) => [`dest${k}`, `set${k}`, `next${k}`, `prev${k}`,
      ...(s.ball && lastBall !== null ? [`setBall${k}`, ...(s.modeVar !== null && onTop !== null ? [`mode${k}`, `setMode${k}`] : [])] : [])])];
  const r = refs(names), n = stops.length;
  const at = name => { const k = names.indexOf(name); return [x0 + 260 * (k % 10), y0 + 220 * Math.floor(k / 10)]; };
  const op = (name, version, ins, outs, links, extra = [], w = 150, h = 77, objName = null) => {
    const [x, y] = at(name);
    return [...extra, ['InputLinks', A, ins.map(([desc, delta]) => inputLink(y + delta, desc, delta))],
            ['OutputLinks', A, outs.map(([desc, to, delta]) => outputLink(desc, to, y + delta, delta))], ['VariableLinks', A, links(x)],
            ...layout(version, parent, x, y, w, h, objName)];
  };
  const setBool = (name, value, target) => op(name, 1, [['In', 11]], [['Out', [], 11]],
    x => [varLink('Value', bool, [value], x + 16, { minVars: 0 }), varLink('Target', bool, [target], x + 68, { writeable: true, delta: 68 })]);
  const setObject = (name, value, target, next) => op(name, 2, [['In', 11]], [['Out', next, 11]],
    x => [varLink('Value', obj, [value], x + 34, { prop: 'Value' }), varLink('Target', obj, [target], x + 90, { prop: 'Targets', delta: 68 })], [], 128, 61);
  const compare = (name, b, same, other) => op(name, 1, [['In', 23]], [['A == B', same, 13], ['A != B', other, 33]],
    x => [varLink('A', obj, [last + 1], x + 49, { delta: 45 }), varLink('B', obj, [b], x + 74, { delta: 70 })], [], 123, 85);
  const arrive = k => {                            // after LastCheckpoint (and the ball's) is set: there, with its title
    const text = stops[k].textNode;
    return [r.teleport, ...(text === null ? [] : [[text + 1, 0]])];
  };
  const go = k => [r[`set${k}`]];
  const spec = {
    loaded: ['SeqEvent_LevelLoaded', op('loaded', 3, [], [['Loaded and Visible', keys.map(([k]) => [r[`${k}Wait`], 0]), 14], ['Beginning of Level', [], 35], ['Level Reset', [], 56]],
                                        () => [], [['MaxWidth', I, 136], ['ObjComment', S, '']], 98, 85, KEYS)],
    player: ['SeqVar_Player', vars(...at('player'))], yes: ['SeqVar_Bool', vars(...at('yes'), [['bValue', I, 1]])], no: ['SeqVar_Bool', vars(...at('no'))],
    dir: ['SeqVar_Vector', vars(...at('dir'))], mag: ['SeqVar_Float', vars(...at('mag'))],
    teleport: ['SeqAct_Teleport', op('teleport', 2, [['In', 34]], [['Out', [r.stop, ...(hasBall ? [hasBall] : [])], 34]], x => [
      varLink('Target', obj, [r.player], x + 38, { prop: 'Targets' }), varLink('Destination', obj, [last + 1], x + 113, { delta: 76 }),
      varLink('Teleport Volumes', obj, [], 0, { prop: 'TeleportVolumes', hidden: true, delta: 0 })], [], 166, 61)],
    stop: ['SeqAct_SetVelocity', op('stop', 1, [['In', 34]], [['Out', [], 34]], x => [
      varLink('Target', obj, [r.player], x + 38, { prop: 'Targets' }), varLink('Velocity Dir', cls('SeqVar_Vector'), [r.dir], x + 102, { prop: 'VelocityDir', delta: 76 }),
      varLink('Velocity Mag', cls('SeqVar_Float'), [r.mag], x + 171, { prop: 'VelocityMag', delta: 145 })], [], 214, 77)],
    activate: ['SeqAct_ActivateRemoteEvent', op('activate', 1, [['In', 11]], [['Out', [], 11]],
      x => [varLink('Instigator', obj, [r.player], x + 30, { prop: 'Instigator' })], [['EventName', N, KEY_RESET]])],
  };
  for (const [k, action] of keys) {                // poll; only a fresh press counts
    spec[`${k}Wait`] = ['SeqAct_Delay', op(`${k}Wait`, 1, [['Start', 14], ['Stop', 35], ['Pause', 56]], [['Finished', [r[`${k}Check`]], 19], ['Aborted', [], 51]],
      x => [varLink('Duration', cls('SeqVar_Float'), [], x + 25, { prop: 'Duration', delta: 25 })], [['Duration', F, 0.03]])];
    spec[`${k}Check`] = ['SeqAct_IsActionPressed_TA', op(`${k}Check`, 1, [['Check', 23]],
      [['True', [[r[`${k}Wait`], 0], r[`${k}IsDown`]], 13], ['False', [[r[`${k}Wait`], 0], r[`${k}Release`]], 33]],
      x => [varLink('Instigator', obj, [r.player], x + 30, { prop: 'Instigator', delta: 30 })], [['ActionName', N, action]])];
    spec[`${k}Down`] = ['SeqVar_Bool', vars(...at(`${k}Down`))];
    spec[`${k}IsDown`] = ['SeqCond_CompareBool', op(`${k}IsDown`, 2, [['In', 23]], [['True', [], 13], ['False', [r[`${k}Press`]], 33]],
      x => [varLink('Bool', bool, [r[`${k}Down`]], x + 16), varLink('Result', bool, [], x + 59, { prop: 'bResult', writeable: true, delta: 59 })])];
    const then = { reset: [r.activate, r.teleport], prev: [r.prev0], next: [r.next0] }[k];
    spec[`${k}Press`] = ['SeqAct_SetBool', setBool(`${k}Press`, r.yes, r[`${k}Down`])];
    spec[`${k}Press`][1].find(([p]) => p === 'OutputLinks')[2] = [outputLink('Out', then, at(`${k}Press`)[1] + 11)];
    spec[`${k}Release`] = ['SeqAct_SetBool', setBool(`${k}Release`, r.no, r[`${k}Down`])];
  }
  stops.forEach((s, k) => {                        // a chain of checks finds where LastCheckpoint is; none: the spawn
    const ball = s.ball && lastBall !== null, mode = ball && s.modeVar !== null && onTop !== null;
    spec[`dest${k}`] = ['SeqVar_Object', vars(...at(`dest${k}`), [['ObjValue', O, s.dest + 1]])];
    spec[`set${k}`] = ['SeqAct_SetObject', setObject(`set${k}`, r[`dest${k}`], last + 1, ball ? [r[`setBall${k}`]] : arrive(k))];
    spec[`next${k}`] = ['SeqCond_CompareObject', compare(`next${k}`, r[`dest${k}`], go(Math.min(k + 1, n - 1)), k + 1 < n ? [r[`next${k + 1}`]] : go(Math.min(1, n - 1)))];
    spec[`prev${k}`] = ['SeqCond_CompareObject', compare(`prev${k}`, r[`dest${k}`], go(Math.max(k - 1, 0)), k + 1 < n ? [r[`prev${k + 1}`]] : go(0))];
    if (ball) spec[`setBall${k}`] = ['SeqAct_SetObject', setObject(`setBall${k}`, r[`dest${k}`], lastBall + 1, mode ? [r[`setMode${k}`]] : arrive(k))];
    if (mode) {
      spec[`mode${k}`] = ['SeqVar_Int', vars(...at(`mode${k}`), [['IntValue', I, s.ballOnTop ? 1 : 0]])];
      spec[`setMode${k}`] = ['SeqAct_SetInt', op(`setMode${k}`, 2, [['In', 11]], [['Out', arrive(k), 11]],
        x => [varLink('Value', int, [r[`mode${k}`]], x + 34, { prop: 'Value' }), varLink('Target', int, [onTop + 1], x + 90, { prop: 'Target', writeable: true, delta: 68 })], [], 128, 61)];
    }
  });
  spec.loaded[1].find(([p]) => p === 'ObjComment')[2] = JSON.stringify({ nodes: names.slice(1).map(name => r[name] - 1) });
  for (const name of names) node(...spec[name]);
  placed(r, 'keys');
  add.appendRefs(seq, 'SequenceObjects', nodes.map(k => k + 1));
}

// Moving shapes (motion.js): per mover a Matinee (SeqAct_Interp) playing its InterpData's one move track on the
// shape's InterpActor, as Leth's maps move their platforms; it loops unless the motion runs once. An event named
// "Mover: ..." starts it: the map loading, or a touch (car or ball) of the checkpoint zone that triggers it, with a
// Delay first when it waits. The motion's settings ride along as JSON in the Matinee's comment, so the editor reads
// them back; all mover blocks are taken out and written anew whenever the movers change.
const MOVER = 'Mover: ', GROUP = 'Mover';
export function moversOf(pkg) {                   // [{i: actor, motion}] of the map's moving shapes
  const out = [];
  for (const k of blockNodes(pkg, liveNodes(pkg), MOVER)) {
    if (pkg.classOf(pkg.exports[k]) !== 'SeqAct_Interp') continue;
    const p = nodeProps(pkg, pkg.exports[k]), v = (p.VariableLinks || []).find(l => l.LinkDesc === GROUP)?.LinkedVariables?.[0];
    if (v) out.push({ i: nodeProps(pkg, pkg.exports[v - 1]).ObjValue - 1, motion: JSON.parse(p.ObjComment) });
  }
  return out;
}

// Replace the map's movers with `movers` ([{actor, motion, keys, length}]: motionKeys' keys, the motion's trigger
// the zone actor's export index or null).
export function setMovers(add, movers) {
  const pkg = add.pkg, seq = mainSequence(pkg), old = blockNodes(pkg, liveNodes(pkg), MOVER);
  if (old.size) add.appendRefs(seq, 'SequenceObjects', [], r => !old.has(r - 1));
  if (!movers.length) return;
  const { enc, parent, cls, node, nodes, refs, placed, vars } = writer(add);
  const obj = cls('SeqVar_Object');
  movers.forEach(({ actor, motion, keys, length }, n) => {
    const x = 40000 + 1000 * (n % 16), y = 20000 - 700 * Math.floor(n / 16), wait = motion.delay > 0, name = `${MOVER}${pkg.exports[actor].name}`;
    const r = refs(['event', ...(wait ? ['wait'] : []), 'interp', 'data', 'target']), group = r.target + 1, track = r.target + 2;
    const start = [[wait ? r.wait : r.interp, 0]];
    if (motion.trigger !== null) {
      node('SeqEvent_Touch', [['Originator', O, motion.trigger + 1], ['MaxTriggerCount', I, motion.once ? 1 : 0], ['ReTriggerDelay', F, 1.0], ['bPlayerOnly', B, false],
        ['MaxWidth', I, 173], ['OutputLinks', A, [outputLink('Touched', start, y + 69, 14), outputLink('UnTouched', [], y + 90, 35), outputLink('Empty', [], y + 111, 56)]],
        ['VariableLinks', A, [varLink('Instigator', obj, [], x + 86, { writeable: true, delta: 54 })]], ...layout(2, parent, x, y, 131, 176, name)]);
    } else {
      node('SeqEvent_LevelLoaded', [['MaxWidth', I, 136], ['InputLinks', A, []],
        ['OutputLinks', A, [outputLink('Loaded and Visible', start, y + 14, 14), outputLink('Beginning of Level', [], y + 35, 35), outputLink('Level Reset', [], y + 56, 56)]],
        ['VariableLinks', A, []], ...layout(3, parent, x, y, 98, 85, name)]);
    }
    if (wait) {
      node('SeqAct_Delay', [['Duration', F, motion.delay], ['InputLinks', A, [inputLink(y + 14, 'Start', 14), inputLink(y + 35, 'Stop', 35), inputLink(y + 56, 'Pause', 56)]],
        ['OutputLinks', A, [outputLink('Finished', [[r.interp, 0]], y + 19, 19), outputLink('Aborted', [], y + 51, 51)]],
        ['VariableLinks', A, [varLink('Duration', cls('SeqVar_Float'), [], x + 225, { prop: 'Duration', delta: 25 })]], ...layout(1, parent, x + 200, y, 150, 77)]);
    }
    node('SeqAct_Interp', [...(motion.once ? [] : [['bLooping', B, true]]), ['ObjComment', S, JSON.stringify(motion)],
      ['InputLinks', A, [['Play', 15], ['Reverse', 37], ['Stop', 59], ['Pause', 81], ['Change Dir', 103]].map(([d, k]) => inputLink(y + k, d, k))],
      ['OutputLinks', A, [outputLink('Completed', [], y + 31, 31), outputLink('Reversed', [], y + 87, 87)]],
      ['VariableLinks', A, [varLink('Data', cls('InterpData'), [r.data], x + 431, { maxVars: 1 }),
                            varLink(GROUP, obj, [r.target], x + 496, { minVars: 0, delta: 63 }),
                            varLink('PlayRate', cls('SeqVar_Float'), [], x + 550, { prop: 'PlayRate', minVars: 0, delta: 117 })]],
      ...layout(2, parent, x + 400, y, 191, 173)], new Uint8Array(4));   // UDK saves 4 more bytes after its properties
    node('InterpData', [['InterpLength', F, length], ['InterpGroups', A, [group]], ...layout(1, parent, x + 400, y + 220, 32, 32)]);
    node('SeqVar_Object', vars(x + 480, y + 220, [['ObjValue', O, actor + 1]]));
    placed(r, 'mover');
    const point = (t, v, arrive, leave) => [['InVal', F, t], ['OutVal', T, ['Vector', pack('<3f', ...v)]], ['ArriveTangent', T, ['Vector', pack('<3f', ...arrive)]],
                                         ['LeaveTangent', T, ['Vector', pack('<3f', ...leave)]], ['InterpMode', E, ['EInterpCurveMode', 'CIM_CurveBreak']]];
    const curve = slot => ['InterpCurveVector', enc.props([['Points', A, keys.map(k => point(k.t, slot ? k.rot : k.pos, k.arrive[slot], k.leave[slot]))]])];
    const sub = (className, outer, props) => add.addObject(cls(className), outer, className, concat(pack('<i', 0), enc.props(props))) + 1;
    if (sub('InterpGroup', r.data, [['InterpTracks', A, [track]], ['GroupName', N, GROUP], ['GroupColor', T, ['Color', Uint8Array.of(140, 194, 0, 255)]]]) !== group
        || sub('InterpTrackMove', group, [['PosTrack', T, curve(0)], ['EulerTrack', T, curve(1)],
             ['LookupTrack', T, ['InterpLookupTrack', enc.props([['Points', A, keys.map(k => [['GroupName', N, 'None'], ['Time', F, k.t]])]])]],
             ['MoveFrame', E, ['EInterpTrackMoveFrame', 'IMF_RelativeToInitial']]]) !== track) throw new Error('mover: object order');
  });
  add.appendRefs(seq, 'SequenceObjects', nodes.map(n => n + 1));
}

// The editor's own notes on a map (each object's name, which are shapes or trigger zones): JSON in the comment of a
// level-loaded event named "Editor" that leads nowhere, so the game ignores it. Written anew on every save.
const EDITOR = 'Editor';
const editorNodes = pkg => [...liveNodes(pkg)].filter(k => pkg.classOf(pkg.exports[k]) === 'SeqEvent_LevelLoaded' && nodeProps(pkg, pkg.exports[k]).ObjName === EDITOR);
export function editorDataOf(pkg) {
  const k = editorNodes(pkg)[0];
  try { return k === undefined ? null : JSON.parse(nodeProps(pkg, pkg.exports[k]).ObjComment); } catch { return null; }
}
export function setEditorData(add, data) {
  const pkg = add.pkg, seq = mainSequence(pkg), old = new Set(editorNodes(pkg));
  if (old.size) add.appendRefs(seq, 'SequenceObjects', [], r => !old.has(r - 1));
  const { parent, node } = writer(add), [x, y] = [29000, 69000];
  const i = node('SeqEvent_LevelLoaded', [['MaxWidth', I, 136], ['ObjComment', S, JSON.stringify(data)], ['InputLinks', A, []],
    ['OutputLinks', A, [outputLink('Loaded and Visible', [], y + 14, 14), outputLink('Beginning of Level', [], y + 35, 35), outputLink('Level Reset', [], y + 56, 56)]],
    ['VariableLinks', A, []], ...layout(3, parent, x, y, 98, 85, EDITOR)]);
  add.appendRefs(seq, 'SequenceObjects', [i + 1]);
}
