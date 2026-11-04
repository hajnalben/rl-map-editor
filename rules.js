// A map script's plan (script.js) in Kismet: event nodes, a chain of nodes per reaction list, a Matinee per clip
// and variables for its state, built from the node layouts working maps use (airdribblegauntlet, tower, The Path,
// Leth's maps). The nodes are listed in a store node that also keeps the script's source and the objects its names
// stand for, so the next save takes them all out before writing the script anew.
import { A, B, E, F, I, N, O, S, T, checkpointZones, inputLink, lavaZones, layout, liveNodes, mainSequence, nodeProps, outputLink, textInfo, varLink, writer } from './kismet.js';
import { concat, pack } from './bytes.js';
import { BUTTONS } from './script.js';

const STORE = 'Script';
export function scriptOf(pkg) {                   // {source, names: {name: export index}, nodes, hooked, store} of the map's script, or null
  for (const k of liveNodes(pkg)) {
    if (pkg.classOf(pkg.exports[k]) !== 'SeqEvent_LevelLoaded') continue;
    const p = nodeProps(pkg, pkg.exports[k]);
    if (p.ObjName === STORE && typeof p.ObjComment === 'string') return { ...JSON.parse(p.ObjComment), store: k };
  }
  return null;
}

const CLIP_INPUT = { play: 0, reverse: 1, stop: 2, pause: 3, flip: 4 };

// Replace the map's script with `script` ({source, names: {name: export index}, plan}, each plan clip with
// motionKeys' {keys, length}), or take it out (null).
export function setScript(add, script) {
  const pkg = add.pkg, seq = mainSequence(pkg), old = scriptOf(pkg), { enc, parent, cls, node: put } = writer(add);
  if (old) { const gone = new Set([old.store, ...old.nodes]); add.appendRefs(seq, 'SequenceObjects', [], r => !gone.has(r - 1)); }
  const hooks = new Map((old?.hooked ?? []).map(t => [t, []]));   // checkpoint texts -> the reaction chains they start
  const placed = [];
  if (script) {
    const { plan, names } = script, list = [];
    const ref = name => { if (!(name in names)) throw new Error(`script: no object for "${name}"`); return names[name]; };
    // nodes: props(R, outs, x, y) is called on writing, R mapping node ids to object references
    const make = (className, props, outs = 0, extra = {}) => list.push({ className, props, outs: Array.from({ length: outs }, () => []), ...extra }) - 1;
    const link = (from, to, input = 0) => from.forEach(([id, out]) => list[id].outs[out].push([to, input]));
    const op = (className, version, ins, outs, links, { pre = [], post = () => [], size = [150, 77], name = null, tail } = {}) =>
      make(className, (R, o, x, y) => [...pre, ['InputLinks', A, ins.map(([d, k]) => inputLink(y + k, d, k))],
        ['OutputLinks', A, outs.map(([d, k], j) => outputLink(d, o[j], y + k, k))], ['VariableLinks', A, links(R, x)], ...post(x),
        ...layout(version, parent, x, y, ...size, name)], outs.length, { tail });
    const variable = (className, props = []) => make(className, (R, o, x, y) => [...props.map(p => typeof p === 'function' ? p(R) : p), ...layout(1, parent, x, y, 32, 32)]);
    const obj = cls('SeqVar_Object'), bool = cls('SeqVar_Bool'), int = cls('SeqVar_Int'), flt = cls('SeqVar_Float'), vec = cls('SeqVar_Vector'), str = cls('SeqVar_String');
    const player = variable('SeqVar_Player'), actors = new Map(), ints = new Map(), bools = new Map();
    const actorVar = i => actors.get(i) ?? actors.set(i, variable('SeqVar_Object', [['ObjValue', O, i + 1]])).get(i);
    const intVar = (n, cache = true) => cache && ints.has(n) ? ints.get(n) : (v => (cache && ints.set(n, v), v))(variable('SeqVar_Int', n ? [['IntValue', I, n]] : []));
    const boolVar = (b, cache = true) => cache && bools.has(b) ? bools.get(b) : (v => (cache && bools.set(b, v), v))(variable('SeqVar_Bool', b ? [['bValue', I, 1]] : []));
    const vecVar = v => variable('SeqVar_Vector', [['VectValue', T, ['Vector', pack('<3f', ...v)]]]);
    const flags = new Map(plan.flags.map(f => [f.id, boolVar(f.value, false)])), counters = new Map(plan.counters.map(c => [c.id, intVar(c.value, false)]));
    const eventLinks = x => [['EventLinks', A, [[['ExpectedType', O, cls('SequenceEvent')], ['LinkedEvents', A, []], ['LinkDesc', S, 'Event'], ['DrawX', I, x + 119],
      ['bHidden', B, false], ['bClampedMax', B, false], ['bClampedMin', B, false], ['OverrideDelta', I, 119]]]]];
    const N_ = n => () => [n];                     // links to node ids, resolved on writing
    const v = (id, R) => [R(id)];

    // node kinds
    const levelLoaded = () => op('SeqEvent_LevelLoaded', 3, [], [['Loaded and Visible', 14], ['Beginning of Level', 35], ['Level Reset', 56]], () => [],
                                 { pre: [['MaxWidth', I, 136]], size: [98, 85], name: `${STORE}: start` });
    const touch = (zone, playerOnly, it) => op('SeqEvent_Touch', 2, [], [['Touched', 14], ['UnTouched', 35], ['Empty', 56]],
      (R, x) => [varLink('Instigator', obj, it === null ? [] : v(it, R), x + 86, { writeable: true, delta: 54 })],
      { pre: [['Originator', O, zone + 1], ['MaxTriggerCount', I, 0], ['ReTriggerDelay', F, 0.1], ...(playerOnly ? [] : [['bPlayerOnly', B, false]]), ['MaxWidth', I, 173]],
        size: [131, 176], name: `${STORE}: touch` });
    const delay = s => op('SeqAct_Delay', 1, [['Start', 14], ['Stop', 35], ['Pause', 56]], [['Finished', 19], ['Aborted', 51]],
      (R, x) => [varLink('Duration', flt, [], x + 25, { prop: 'Duration', delta: 25 })], { pre: [['Duration', F, s]] });
    const compareBool = b => op('SeqCond_CompareBool', 2, [['In', 23]], [['True', 13], ['False', 33]],
      (R, x) => [varLink('Bool', bool, v(b, R), x + 16), varLink('Result', bool, [], x + 59, { prop: 'bResult', writeable: true, delta: 59 })]);
    const setBool = (target, value) => op('SeqAct_SetBool', 1, [['In', 11]], [['Out', 11]],
      (R, x) => [varLink('Value', bool, v(value, R), x + 16, { minVars: 0 }), varLink('Target', bool, v(target, R), x + 68, { writeable: true, delta: 68 })]);
    const compareInt = (a, b) => op('SeqCond_CompareInt', 1, [['In', 59]], [['A <= B', 15], ['A > B', 37], ['A == B', 59], ['A < B', 81], ['A >= B', 103]],
      (R, x) => [varLink('A', int, v(a, R), x + 29, { prop: 'ValueA', delta: 29 }), varLink('B', int, v(b, R), x + 54, { prop: 'ValueB', delta: 54 })], { size: [91, 157] });
    const compareObject = (a, b) => op('SeqCond_CompareObject', 1, [['In', 23]], [['A == B', 13], ['A != B', 33]],
      (R, x) => [varLink('A', obj, v(a, R), x + 49, { delta: 45 }), varLink('B', obj, v(b, R), x + 74, { delta: 70 })], { size: [123, 85] });
    const addInt = (a, b) => op('SeqAct_AddInt', 1, [['In', 11]], [['Out', 11]], (R, x) => [
      varLink('A', int, v(a, R), x + 16, { prop: 'ValueA' }), varLink('B', int, v(b, R), x + 41, { prop: 'ValueB', delta: 41 }),
      varLink('IntResult', int, v(a, R), x + 65, { prop: 'IntResult', writeable: true, delta: 65 }),
      varLink('FloatResult', flt, [], x + 140, { prop: 'FloatResult', writeable: true, delta: 140 })]);
    const setInt = (target, value) => op('SeqAct_SetInt', 2, [['In', 11]], [['Out', 11]],
      (R, x) => [varLink('Value', int, v(value, R), x + 34, { prop: 'Value' }), varLink('Target', int, v(target, R), x + 90, { prop: 'Target', writeable: true, delta: 68 })], { size: [128, 61] });
    const drawText = a => op('SeqAct_DrawText', 3, [['Show', 13], ['Hide', 33]], [['Out', 23]],
      (R, x) => [varLink('Target', obj, v(player, R), x + 17, { prop: 'Targets', delta: 17 }), varLink('String', str, [], x + 76, { minVars: 0, delta: 76 })],
      { pre: [['DisplayTimeSeconds', F, a.seconds], ['DrawTextInfo', T, ['KismetDrawTextInfo', textInfo(add, a.text, a.at, a.size, a.color)]]] });
    const toggles = (className, ins, target) => op(className, 1, ins, [['Out', 35]],
      (R, x) => [varLink('Target', obj, v(target, R), x + 16, { prop: 'Targets' }), varLink('Bool', bool, [], x + 76, { minVars: 0, delta: 76 })], { post: eventLinks });
    const setVelocity = (target, velocity) => {
      const mag = Math.hypot(...velocity);
      return op('SeqAct_SetVelocity', 1, [['In', 11]], [['Out', 11]], (R, x) => [varLink('Target', obj, v(target, R), x + 38, { prop: 'Targets' }),
        varLink('Velocity Dir', vec, [], x + 102, { prop: 'VelocityDir', delta: 76 }), varLink('Velocity Mag', flt, [], x + 171, { prop: 'VelocityMag', delta: 145 })],
        { pre: [['VelocityDir', T, ['Vector', pack('<3f', ...velocity.map(c => mag ? c / mag : 0))]], ['VelocityMag', F, mag]], size: [214, 77] });
    };
    const teleport = (target, dest) => op('SeqAct_Teleport', 2, [['In', 11]], [['Out', 11]], (R, x) => [varLink('Target', obj, v(target, R), x + 38, { prop: 'Targets' }),
      varLink('Destination', obj, v(dest, R), x + 113, { delta: 76 }), varLink('Teleport Volumes', obj, [], 0, { prop: 'TeleportVolumes', hidden: true, delta: 0 })], { size: [166, 61] });
    const setLocation = (target, at) => op('SeqAct_SetLocation', 3, [['In', 11]], [['Out', 11]], (R, x) => [varLink('Location', vec, v(at, R), x + 44, { maxVars: 1 }),
      varLink('Rotation', vec, [], x + 115, { maxVars: 1, delta: 88 }), varLink('Target', obj, v(target, R), x + 181, { prop: 'Target', writeable: true, maxVars: 1, delta: 159 })],
      { pre: [['bSetRotation', B, false]], size: [219, 61] });
    const remote = (className, name, ins, version) => op(className, version, ins, ins.length ? [['Out', 11]] : [['Out', 11]],
      (R, x) => [varLink('Instigator', obj, ins.length ? v(player, R) : [], x + 30, ins.length ? { prop: 'Instigator' } : { writeable: true })], { pre: [['EventName', N, name]] });

    // clips: a Matinee each, as setMovers writes them, played from reactions
    const clips = new Map(plan.clips.map(c => {
      const target = actorVar(ref(c.target)), data = make('InterpData', (R, o, x, y) => [['InterpLength', F, c.length], ['InterpGroups', A, [R(group)]], ...layout(1, parent, x, y, 32, 32)]);
      const group = make('InterpGroup', R => [['InterpTracks', A, [R(track)]], ['GroupName', N, 'Mover'], ['GroupColor', T, ['Color', Uint8Array.of(140, 194, 0, 255)]]], 0, { outer: data });
      const point = (t, p, arrive, leave) => [['InVal', F, t], ['OutVal', T, ['Vector', pack('<3f', ...p)]], ['ArriveTangent', T, ['Vector', pack('<3f', ...arrive)]],
                                           ['LeaveTangent', T, ['Vector', pack('<3f', ...leave)]], ['InterpMode', E, ['EInterpCurveMode', 'CIM_CurveBreak']]];
      const curve = slot => ['InterpCurveVector', enc.props([['Points', A, c.keys.map(k => point(k.t, slot ? k.rot : k.pos, k.arrive[slot], k.leave[slot]))]])];
      const track = make('InterpTrackMove', () => [['PosTrack', T, curve(0)], ['EulerTrack', T, curve(1)],
        ['LookupTrack', T, ['InterpLookupTrack', enc.props([['Points', A, c.keys.map(k => [['GroupName', N, 'None'], ['Time', F, k.t]])]])]],
        ['MoveFrame', E, ['EInterpTrackMoveFrame', 'IMF_RelativeToInitial']]], 0, { outer: group });
      const interp = op('SeqAct_Interp', 2, [['Play', 15], ['Reverse', 37], ['Stop', 59], ['Pause', 81], ['Change Dir', 103]], [['Completed', 31], ['Reversed', 87]],
        (R, x) => [varLink('Data', cls('InterpData'), v(data, R), x + 31, { maxVars: 1 }), varLink('Mover', obj, v(target, R), x + 96, { minVars: 0, delta: 63 }),
                   varLink('PlayRate', flt, [], x + 150, { prop: 'PlayRate', minVars: 0, delta: 117 })],
        { pre: [c.loop ? ['bLooping', B, true] : ['bRewindOnPlay', B, true]], size: [191, 173], tail: new Uint8Array(4) });
      return [c.id, interp];
    }));

    const it = ctx => { if (ctx.it === null) throw new Error('script: "it" is what set off a zone, checkpoint or lava event; this event has none'); return ctx.it; };
    const who = (what, ctx) => what === 'car' ? player : it(ctx);
    const sayOf = new Map(checkpointZones(pkg).map(z => [z.i, z.textNode]));
    const lava = lavaZones(pkg);
    function start(e, ctx) {                       // the event's node outputs the reactions hang from
      if (e.on === 'start') return [[levelLoaded(), 0]];
      if (e.on === 'after' || e.on === 'every') {
        const d = delay(e.seconds);
        link([[levelLoaded(), 0]], d);
        if (e.on === 'every') link([[d, 0]], d);   // a Delay starting itself again, as tower's and airdribblegauntlet's loops do
        return [[d, 0]];
      }
      if (e.on === 'enter' || e.on === 'leave' || e.on === 'lava') {
        ctx.it = variable('SeqVar_Object');
        const out = e.on === 'leave' ? 1 : 0, zones = e.on === 'lava' ? lava.filter(z => e.by === 'any' || (e.by === 'ball') === z.ball).map(z => [z.i, z.ball ? 'ball' : 'car'])
          : [[ref(e.zone), e.by]];
        if (!zones.length) throw new Error(`script: lava(${JSON.stringify(e.by)}): the map has no such lava`);
        return zones.flatMap(([zone, by]) => {
          const t = touch(zone, by === 'car', ctx.it);
          if (by !== 'ball') return [[t, out]];
          const c = compareObject(ctx.it, player);  // the zone fires for anything; what isn't the car is the ball
          link([[t, out]], c);
          return [[c, 1]];
        });
      }
      if (e.on === 'reached') {
        const text = sayOf.get(ref(e.checkpoint));
        if (text == null) throw new Error(`script: checkpoint "${e.checkpoint}" was made before checkpoints had a text; delete it and add it again`);
        const relay = compareBool(boolVar(true));
        hooks.set(text, [...(hooks.get(text) ?? []), relay]);
        return [[relay, 0]];
      }
      if (e.on === 'reset') {                      // every car spawn after the first
        const spawned = op('SeqEvent_CarSpawned_TA', 1, [], [['Out', 66]], (R, x) => [varLink('Instigator', obj, [], x + 48, { writeable: true })],
                           { pre: [['MaxWidth', I, 97]], size: [68, 128], name: `${STORE}: reset` });
        const was = boolVar(false, false), c = compareBool(was), set = setBool(was, boolVar(true));
        link([[spawned, 0]], c); link([[c, 1]], set);
        return [[c, 0]];
      }
      if (e.on === 'finished' || e.on === 'reversed') return [[clips.get(e.clip), e.on === 'finished' ? 0 : 1]];
      if (e.on === 'pressed') {                    // polled, as airdribblegauntlet and The Path do; only a fresh press counts
        const d = delay(0.03), check = op('SeqAct_IsActionPressed_TA', 1, [['Check', 23]], [['True', 13], ['False', 33]],
          (R, x) => [varLink('Instigator', obj, v(player, R), x + 30, { prop: 'Instigator', delta: 30 })], { pre: [['ActionName', N, BUTTONS[e.button]]] });
        const down = boolVar(false, false), c = compareBool(down), press = setBool(down, boolVar(true)), release = setBool(down, boolVar(false));
        link([[levelLoaded(), 0]], d); link([[d, 0]], check);
        link([[check, 0]], d); link([[check, 0]], c); link([[check, 1]], d); link([[check, 1]], release);
        link([[c, 1]], press);
        return [[press, 0]];
      }
      if (e.on === 'signal') return [[remote('SeqEvent_RemoteEvent', e.name, [], 2), 0]];
      if (e.on === 'goal') {
        const g = op('SeqEvent_GoalScored_TA', 1, [], [['Blue', 14], ['Red', 35], ['Kill Effects', 56]], (R, x) => [varLink('Instigator', obj, [], x + 16, { writeable: true })]);
        return { blue: [[g, 0]], orange: [[g, 1]], any: [[g, 0], [g, 1]] }[e.team];
      }
      throw new Error(`script: unknown event ${e.on}`);
    }
    function chain(actions, from, ctx) { for (const a of actions) from = step(a, from, ctx); }
    function step(a, from, ctx) {                  // links `from` into the reaction; returns where the next one hangs from
      const then = n => { link(from, n); return [[n, 0]]; };
      switch (a.do) {
        case 'play': case 'reverse': case 'stop': case 'pause': case 'flip': link(from, clips.get(a.clip), CLIP_INPUT[a.do]); return from;
        case 'text': return then(drawText(a));
        case 'light': { const n = toggles('SeqAct_Toggle', [['Turn On', 14], ['Turn Off', 35], ['Toggle', 56]], actorVar(ref(a.light)));
                        link(from, n, { on: 0, off: 1, toggle: 2 }[a.to]); return [[n, 0]]; }
        case 'hide': case 'show': {                // hidden and moved far below, so nothing hits it either
          const shape = ref(a.shape), at = script.homes[a.shape], h = toggles('SeqAct_ToggleHidden', [['Hide', 14], ['UnHide', 35], ['Toggle', 56]], actorVar(shape));
          const s = setLocation(actorVar(shape), vecVar(a.do === 'hide' ? [at[0], at[1], at[2] - 100000] : at));
          if (a.do === 'hide') { link(from, h, 0); link([[h, 0]], s); return [[s, 0]]; }
          link(from, s); link([[s, 0]], h, 1); return [[h, 0]];
        }
        case 'launch': return then(setVelocity(who(a.what, ctx), a.velocity));
        case 'teleport': {
          const target = who(a.what, ctx), n = teleport(target, actorVar(ref(a.to)));
          link(from, n);
          if (!a.stop) return [[n, 0]];
          const s = setVelocity(target, [0, 0, 0]);
          link([[n, 0]], s);
          return [[s, 0]];
        }
        case 'emit': return then(remote('SeqAct_ActivateRemoteEvent', a.name, [['In', 11]], 3));
        case 'set': return then(setBool(flags.get(a.flag), boolVar(a.value)));
        case 'toggle': {
          const c = compareBool(flags.get(a.flag)), off = setBool(flags.get(a.flag), boolVar(false)), on = setBool(flags.get(a.flag), boolVar(true));
          link(from, c); link([[c, 0]], off); link([[c, 1]], on);
          return [[off, 0], [on, 0]];
        }
        case 'add': return then(addInt(counters.get(a.counter), intVar(a.by)));
        case 'count': return then(setInt(counters.get(a.counter), intVar(a.value)));
        case 'wait': { const d = delay(a.seconds); link(from, d); chain(a.then, [[d, 0]], ctx); return from; }
        case 'when': {
          let yes, no;
          if (a.test.flag) {
            const c = compareBool(flags.get(a.test.flag));
            [yes, no] = a.test.is ? [[[c, 0]], [[c, 1]]] : [[[c, 1]], [[c, 0]]];
            link(from, c);
          } else {
            const c = compareInt(counters.get(a.test.counter), intVar(a.test.value));
            [yes, no] = { '==': [[[c, 2]], [[c, 1], [c, 3]]], '>=': [[[c, 4]], [[c, 3]]], '<': [[[c, 3]], [[c, 4]]] }[a.test.op];
            link(from, c);
          }
          chain(a.then, yes, ctx); chain(a.otherwise, no, ctx);
          return from;
        }
        case 'once': {
          const done = boolVar(false, false), c = compareBool(done), set = setBool(done, boolVar(true));
          link(from, c); link([[c, 1]], set); chain(a.then, [[set, 0]], ctx);
          return from;
        }
      }
      throw new Error(`script: unknown reaction ${a.do}`);
    }
    for (const r of plan.rules) { const ctx = { it: null }; chain(r.actions, start(r.event, ctx), ctx); }

    // write: sequence objects in order, a Matinee's group and track inside its data
    const base = pkg.exports.length + add.added.length + 1, R = id => base + id;
    list.forEach((n, id) => {
      const x = 30000 + 260 * (id % 30), y = 70000 + 300 * Math.floor(id / 30);
      const props = n.props(R, n.outs.map(o => o.map(([to, k]) => [R(to), k])), x, y), tail = n.tail ?? new Uint8Array(0);
      const i = n.outer === undefined ? put(n.className, props, tail) : add.addObject(cls(n.className), R(n.outer), n.className, concat(pack('<i', 0), enc.props(props), tail));
      if (i + 1 !== R(id)) throw new Error('script: object order');
      if (n.outer === undefined) placed.push(i);
    });
    for (const [text, entries] of hooks) hooks.set(text, entries.map(R));
    const store = put('SeqEvent_LevelLoaded', [['MaxWidth', I, 136], ['ObjComment', S, JSON.stringify({ source: script.source, names, nodes: placed, hooked: [...hooks.keys()] })],
      ['InputLinks', A, []], ['OutputLinks', A, [outputLink('Loaded and Visible', [], 30014, 14), outputLink('Beginning of Level', [], 30035, 35), outputLink('Level Reset', [], 30056, 56)]],
      ['VariableLinks', A, []], ...layout(3, parent, 29000, 70000, 98, 85, STORE)]);
    placed.push(store);
  }
  for (const [text, entries] of hooks) {          // checkpoint texts start the chains for "reached", and no longer the old ones
    const o = nodeProps(pkg, pkg.exports[text]).OutputLinks[0];
    add.setProps(text, { OutputLinks: enc.prop('OutputLinks', A, [outputLink(o.LinkDesc, entries, o.DrawY, o.OverrideDelta)]) });
  }
  if (placed.length) add.appendRefs(seq, 'SequenceObjects', placed.map(i => i + 1));
}
