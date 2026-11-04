// Map scripts: events and what they set off, written as JavaScript against a small API (ai-guide.md, "Scripts").
// The editor runs a script once to get its plan, plain data: movements (clips), state (flags and counters) and rules
// ({event, actions}). rules.js turns the plan into Kismet, which is all the game runs; the editor previews it.
import { motionErrors, newMotion } from './motion.js';

export const BUTTONS = { jump: 'Jump', boost: 'Boost', handbrake: 'Handbrake', ballcam: 'SecondaryCamera', reset: 'ResetTraining',
                         chat1: 'ChatPreset1', chat2: 'ChatPreset2', chat3: 'ChatPreset3', chat4: 'ChatPreset4' };
export const CLIP_RATE = 30, MAX_SAMPLES = 1500;  // time functions are sampled this often, up to this many samples

// The API's names, for the editor's help and for scripts that shadow them
export const API = ['shape', 'zone', 'checkpoint', 'light', 'on', 'start', 'reset', 'after', 'every', 'pressed', 'signal', 'lava', 'goal',
                    'text', 'launch', 'teleport', 'emit', 'wait', 'when', 'once', 'flag', 'counter'];

const EVENT = Symbol('event'), ACTION = Symbol('action'), TEST = Symbol('test');
const mark = (tag, o) => Object.defineProperty(o, tag, { value: true });

// The plan of `source`, or throws an Error saying what is wrong. `kindOf(name)` tells what the object named so is:
// 'shape' (one that can move), 'mesh' (one that can't), 'zone', 'checkpoint', 'light', another word, or null.
export function runScript(source, kindOf) {
  const plan = { clips: [], flags: [], counters: [], rules: [] };
  let onces = 0;
  const fail = msg => { throw new Error(msg); };
  const num = (v, what, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi) ? v : fail(`${what}: a number from ${lo} to ${hi}`);
  const vec = (v, what, limit = 100000) => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Math.abs(x) <= limit) ? [...v] : fail(`${what}: [x, y, z] within ±${limit}`);
  const object = (name, kinds, what) => {
    const kind = typeof name === 'string' ? kindOf(name) : null;
    if (!kind) fail(`${what}: no object named ${JSON.stringify(name)} (names are in the Map list and the inspector's Name)`);
    if (kinds && !kinds.includes(kind)) fail(`${what}: "${name}" is a ${kind}, not ${kinds.join(' or ')}`);
    return name;
  };
  const by = (v, what) => ['car', 'ball', 'any'].includes(v) ? v : fail(`${what}: "car", "ball" or "any"`);
  const event = e => mark(EVENT, e), action = a => mark(ACTION, a), test = t => mark(TEST, t);
  const actions = (list, what) => list.flat().map(a => a?.[ACTION] ? a : fail(`${what}: ${typeof a === 'function' ? 'a function; reactions are values such as lift.play, not calls' : 'not a reaction'}`));
  const color = (v, what) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? [1, 3, 5].map(k => parseInt(v.slice(k, k + 2), 16)) : fail(`${what}: "#rrggbb"`);
  const touches = (name, kinds) => ({
    enter: (who = 'any') => event({ on: 'enter', zone: name, by: by(who, `${name}.enter`) }),
    leave: (who = 'any') => event({ on: 'leave', zone: name, by: by(who, `${name}.leave`) }),
  });
  const api = {
    shape: name => {
      object(name, ['shape'], 'shape()');
      return {
        clip(how, fn, options = {}) {
          const id = `clip${plan.clips.length + 1}`, clip = { id, target: name, loop: false };
          if (typeof how === 'object' && how !== null) {
            const { loop = false, ...m } = how;
            const errors = motionErrors({ ...newMotion(m.kind), ...m, trigger: null });
            if (errors.length) fail(`${name}.clip: ${errors.join('; ')}`);
            Object.assign(clip, { loop: !!loop, motion: { ...newMotion(m.kind), ...m, trigger: null, delay: 0, once: false } });
          } else {
            const seconds = num(how, `${name}.clip(seconds, t => ...)`, 0.1, 600);
            if (typeof fn !== 'function') fail(`${name}.clip(seconds, t => ({move, turn})): give a function of time`);
            const n = Math.min(MAX_SAMPLES, Math.ceil(seconds * CLIP_RATE)), samples = [];
            for (let k = 0; k <= n; k++) {
              const t = seconds * k / n, r = fn(t) ?? {};
              samples.push({ t, move: r.move === undefined ? [0, 0, 0] : vec(r.move, `${name}.clip: move at ${t.toFixed(2)} s`),
                             turn: r.turn === undefined ? [0, 0, 0] : vec(r.turn, `${name}.clip: turn at ${t.toFixed(2)} s`, 1e6) });
            }
            Object.assign(clip, { loop: !!options.loop, motion: { kind: 'samples', seconds, samples } });
          }
          plan.clips.push(clip);
          return { id, play: action({ do: 'play', clip: id }), reverse: action({ do: 'reverse', clip: id }), stop: action({ do: 'stop', clip: id }),
                   pause: action({ do: 'pause', clip: id }), flip: action({ do: 'flip', clip: id }),
                   finished: event({ on: 'finished', clip: id }), reversed: event({ on: 'reversed', clip: id }) };
        },
        show: action({ do: 'show', shape: name }), hide: action({ do: 'hide', shape: name }),
      };
    },
    zone: name => touches(object(name, ['zone'], 'zone()')),
    checkpoint: name => ({ ...touches(object(name, ['checkpoint'], 'checkpoint()')), reached: event({ on: 'reached', checkpoint: name }) }),
    light: name => {
      object(name, ['light'], 'light()');
      return { on: action({ do: 'light', light: name, to: 'on' }), off: action({ do: 'light', light: name, to: 'off' }), toggle: action({ do: 'light', light: name, to: 'toggle' }) };
    },
    on: (e, ...list) => {
      if (!e?.[EVENT]) fail('on(event, ...reactions): the first argument is no event');
      const done = actions(list, `on(${e.on})`);
      if (!done.length) fail(`on(${e.on}): no reactions`);
      plan.rules.push({ event: { ...e }, actions: done.map(a => ({ ...a })) });
    },
    start: event({ on: 'start' }),
    reset: event({ on: 'reset' }),
    after: s => event({ on: 'after', seconds: num(s, 'after(seconds)', 0.01, 3600) }),
    every: s => event({ on: 'every', seconds: num(s, 'every(seconds)', 0.05, 3600) }),
    pressed: b => event({ on: 'pressed', button: Object.hasOwn(BUTTONS, b) ? b : fail(`pressed(button): one of ${Object.keys(BUTTONS).join(', ')}`) }),
    signal: name => event({ on: 'signal', name: typeof name === 'string' && /^[\w -]{1,40}$/.test(name) ? name : fail('signal(name): up to 40 letters, digits, spaces, - or _') }),
    lava: (who = 'any') => event({ on: 'lava', by: by(who, 'lava(by)') }),
    goal: (team = 'any') => event({ on: 'goal', team: ['blue', 'orange', 'any'].includes(team) ? team : fail('goal(team): "blue", "orange" or "any"') }),
    text: (message, seconds = 2, { size = 2, at = [-80, -300], color: c = '#ffffff' } = {}) => {
      if (typeof message !== 'string' || !message.length || message.length > 200) fail('text(message): 1 to 200 characters');
      const where = Array.isArray(at) && at.length === 2 && at.every(v => typeof v === 'number' && Math.abs(v) <= 2000) ? [...at] : fail('text: at is [x, y] pixels from the middle of the screen');
      return action({ do: 'text', text: message, seconds: num(seconds, 'text: seconds', 0.1, 600), size: num(size, 'text: size', 0.2, 10), at: where, color: color(c, 'text: color') });
    },
    launch: (what, velocity) => action({ do: 'launch', what: ['car', 'it'].includes(what) ? what : fail('launch(what): "car", or "it" (what set off the event)'), velocity: vec(velocity, 'launch: velocity', 20000) }),
    teleport: (what, to, { stop = true } = {}) => action({ do: 'teleport', what: ['car', 'it'].includes(what) ? what : fail('teleport(what): "car" or "it"'), to: object(to, null, 'teleport(what, to)'), stop: !!stop }),
    emit: name => action({ do: 'emit', name: api.signal(name).name }),
    wait: (s, ...list) => action({ do: 'wait', seconds: num(s, 'wait(seconds)', 0.01, 3600), then: actions(list, 'wait').map(a => ({ ...a })) }),
    when: (t, ...list) => {
      if (!t?.[TEST]) fail('when(test, ...reactions): the first argument is no test, such as open.is(true) or hits.atLeast(3)');
      const a = action({ do: 'when', test: { ...t }, then: actions(list, 'when').map(x => ({ ...x })), otherwise: [] });
      return Object.defineProperty(a, 'else', { value: (...rest) => action({ ...a, otherwise: actions(rest, 'else').map(x => ({ ...x })) }) });
    },
    once: (...list) => action({ do: 'once', id: `once${++onces}`, then: actions(list, 'once').map(a => ({ ...a })) }),
    flag: (name, initial = false) => {
      const id = `flag${plan.flags.length + 1}`;
      plan.flags.push({ id, name: String(name), value: !!initial });
      return { set: (v = true) => action({ do: 'set', flag: id, value: !!v }), toggle: action({ do: 'toggle', flag: id }), is: (v = true) => test({ flag: id, is: !!v }) };
    },
    counter: (name, initial = 0) => {
      const id = `counter${plan.counters.length + 1}`, int = (v, what) => Number.isInteger(v) && Math.abs(v) < 1e9 ? v : fail(`${name}.${what}: a whole number`);
      plan.counters.push({ id, name: String(name), value: int(initial, 'initial value') });
      return { add: (n = 1) => action({ do: 'add', counter: id, by: int(n, 'add') }), set: n => action({ do: 'count', counter: id, value: int(n, 'set') }),
               is: n => test({ counter: id, op: '==', value: int(n, 'is') }), atLeast: n => test({ counter: id, op: '>=', value: int(n, 'atLeast') }),
               below: n => test({ counter: id, op: '<', value: int(n, 'below') }) };
    },
  };
  new Function(...API, `"use strict";\n${source}`)(...API.map(k => api[k]));
  return plan;
}

// The object names a plan refers to, with what each must be able to do: 'moves' for shapes it moves, shows or hides
export function planNames(plan) {
  const names = new Map(), use = (name, need = null) => { if (name && !(names.get(name) === 'moves')) names.set(name, need ?? names.get(name) ?? null); };
  for (const c of plan.clips) use(c.target, 'moves');
  const walk = list => list.forEach(a => {
    if (a.do === 'show' || a.do === 'hide') use(a.shape, 'moves');
    use(a.light);
    if (a.do === 'teleport') use(a.to);
    walk(a.then ?? []); walk(a.otherwise ?? []);
  });
  for (const r of plan.rules) { use(r.event.zone); use(r.event.checkpoint); walk(r.actions); }
  return names;
}

