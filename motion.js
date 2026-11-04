// Moving shapes. A motion is how a shape moves in the game; motionKeys turns it into the keyframes of a Matinee move
// track and keysAt plays those keyframes back, so the editor previews exactly what the game plays. Offsets (`to`,
// `points`) are world units from where the shape stands. Keys are in the shape's own frame, as Matinee's "relative
// to initial" tracks apply them: positions turned by the shape's rotation, rotations applied before it.
//
// {kind: 'slide' | 'spin' | 'path' | 'swing',
//  seconds   one move (slide, path), one step (spin), one whole swing there and back (swing)
//  smooth    eases into and out of every stop (a swing: like a pendulum); else steady speed
//  pause     seconds it waits at each stop (spot, step, end of a swing)
//  delay     seconds after its start before it moves; trigger: null (the map starting) or the checkpoint touched
//  once      plays through once instead of over and over
//  to        slide: where it goes, [x, y, z]
//  points    path: the spots it visits after its start, [[x, y, z], ...]
//  back      slide, path: 'same' (back the way it came), 'start' (path: straight back to the start), 'jump' (jumps
//            back to the start; one that runs once stays at its last spot)
//  axis      spin, swing: 'yaw' (flat, like a turntable), 'roll' (upright, across the way it faces), 'pitch'
//  reverse   spin: turns the other way; steps: turns in this many steps (4: quarter turns)
//  angle     swing: degrees each way from where it hangs; hinge: 'top', 'middle' or 'bottom' of the shape}
export const MOTIONS = { slide: 'Slide', spin: 'Spin', path: 'Path', swing: 'Swing' };
export const newMotion = kind => ({ kind, seconds: { slide: 2, spin: 4, path: 2, swing: 3 }[kind], smooth: kind !== 'spin', pause: 0, delay: 0, once: false,
  trigger: null, ...{ slide: { to: [1000, 0, 0], back: 'same' }, path: { points: [[1500, 0, 0], [1500, 1500, 0]], back: 'same' },
                      spin: { axis: 'yaw', reverse: false, steps: 1 }, swing: { axis: 'roll', angle: 45, hinge: 'top' } }[kind] });
const FIELDS = { slide: ['to', 'back'], path: ['points', 'back'], spin: ['axis', 'reverse', 'steps'], swing: ['axis', 'angle', 'hinge'] };
const COMMON = ['kind', 'seconds', 'smooth', 'pause', 'delay', 'once', 'trigger'];
export const motionFields = kind => [...COMMON, ...FIELDS[kind]];

// What is wrong with motion `m` (a list; empty when it is fine). `limit`: how far offsets may reach.
export function motionErrors(m, limit = 100000) {
  if (!m || typeof m !== 'object' || !Object.hasOwn(MOTIONS, m.kind)) return [`kind: one of ${Object.keys(MOTIONS).join(', ')}`];
  const out = [], num = (k, lo, hi) => { if (k in m && !(typeof m[k] === 'number' && m[k] >= lo && m[k] <= hi)) out.push(`${k}: a number from ${lo} to ${hi}`); };
  const vec = v => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Math.abs(x) <= limit);
  for (const k of Object.keys(m)) if (!motionFields(m.kind).includes(k)) out.push(`${k}: not a setting of a ${m.kind}`);
  num('seconds', 0.1, 600); num('pause', 0, 600); num('delay', 0, 600); num('angle', 1, 180); num('steps', 1, 36);
  for (const k of ['smooth', 'once', 'reverse']) if (k in m && typeof m[k] !== 'boolean') out.push(`${k}: true or false`);
  if ('steps' in m && !Number.isInteger(m.steps)) out.push('steps: a whole number');
  if ('to' in m && !vec(m.to)) out.push(`to: [x, y, z] within ±${limit}`);
  if ('points' in m && !(Array.isArray(m.points) && m.points.length >= 1 && m.points.length <= 20 && m.points.every(vec))) out.push(`points: 1 to 20 [x, y, z] within ±${limit}`);
  if ('back' in m && !(m.kind === 'path' ? ['same', 'start', 'jump'] : ['same', 'jump']).includes(m.back)) out.push(`back: ${m.kind === 'path' ? '"same", "start" or "jump"' : '"same" or "jump"'}`);
  if ('axis' in m && !['yaw', 'roll', 'pitch'].includes(m.axis)) out.push('axis: "yaw", "roll" or "pitch"');
  if ('hinge' in m && !['top', 'middle', 'bottom'].includes(m.hinge)) out.push('hinge: "top", "middle" or "bottom"');
  return out;
}

const UU = Math.PI / 32768, DEG = 65536 / 360;
export function ueAxes([pitch, yaw, roll]) {      // FRotationMatrix rows: local X, Y, Z in world space
  const [SP, CP, SY, CY, SR, CR] = [Math.sin(pitch * UU), Math.cos(pitch * UU), Math.sin(yaw * UU), Math.cos(yaw * UU), Math.sin(roll * UU), Math.cos(roll * UU)];
  return [[CP * CY, CP * SY, SP],
          [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP],
          [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP]];
}
export const eulerRotator = ([roll, pitch, yaw]) => [pitch, yaw, roll].map(d => Math.round(d * DEG));   // track degrees -> rotator units
const SLOT = { roll: 0, pitch: 1, yaw: 2 };       // where each axis sits in a track's [roll, pitch, yaw]
const ZERO = [0, 0, 0];
const turned = (euler, v) => {                    // v in the shape's frame, after the relative rotation `euler`
  const ax = ueAxes([euler[1] * DEG, euler[2] * DEG, euler[0] * DEG]);
  return [0, 1, 2].map(k => v[0] * ax[0][k] + v[1] * ax[1][k] + v[2] * ax[2][k]);
};

// {length, keys: [{t, pos, rot, arrive: [posTangent, rotTangent], leave: [...]}]} for motion `m` of a shape facing
// `rot` (rotator units) whose box in its own frame, scaled, is `box` [cx, cy, cz, ex, ey, ez]. Tangents are per
// second, for Hermite pieces between keys (Matinee's CIM_CurveBreak).
export function motionKeys(m, rot, box) {
  const ax = ueAxes(rot), local = v => ax.map(a => a[0] * v[0] + a[1] * v[1] + a[2] * v[2]);
  const keys = [{ t: 0, pos: ZERO, rot: ZERO, arrive: [ZERO, ZERO], leave: [ZERO, ZERO] }];
  const STEADY = [u => u, () => 1], SMOOTH = [u => u * u * (3 - 2 * u), u => 6 * u * (1 - u)];
  // d seconds of f(u) = [pos, rot, dpos/du, drot/du], u from 0 to 1, as `pieces` Hermite pieces
  const segment = (d, f, pieces = 1) => {
    const last = keys.at(-1), per = v => v.map(x => x / d);
    const [, , p0, r0] = f(0);
    last.leave = [per(p0), per(r0)];
    for (let j = 1; j <= pieces; j++) {
      const [pos, r, dp, dr] = f(j / pieces), tan = [per(dp), per(dr)];
      keys.push({ t: last.t + d * j / pieces, pos, rot: r, arrive: tan, leave: tan });
    }
  };
  const hold = s => { if (s > 0) { const k = keys.at(-1); segment(s, () => [k.pos, k.rot, ZERO, ZERO]); } };
  const move = (a, b, [e, de] = m.smooth ? SMOOTH : STEADY) =>
    segment(m.seconds, u => [a.map((v, k) => v + (b[k] - v) * e(u)), ZERO, a.map((v, k) => (b[k] - v) * de(u)), ZERO]);
  // turn about `pivot` from a to b degrees on `axis`, the pivot staying put; in pieces of at most 15° when the turn
  // carries the shape around (or eases unevenly), so the curve follows the circle
  const spin = (d, a, b, axis, pivot, [e, de], uneven = false) => {
    const slot = SLOT[axis], euler = th => ZERO.map((_, k) => k === slot ? th : 0);
    const off = Math.hypot(...pivot.filter((_, k) => k !== slot)) > 1;   // slots match the local axes: roll X, pitch Y, yaw Z
    const posAt = th => pivot.map((v, k) => v - turned(euler(th), pivot)[k]);
    segment(d, u => {
      const th = a + (b - a) * e(u), w = (b - a) * de(u), p1 = posAt(th + 0.01), p0 = posAt(th - 0.01);
      return [posAt(th), euler(th), p1.map((v, k) => (v - p0[k]) / 0.02 * w), euler(w)];
    }, off || uneven ? Math.max(1, Math.ceil(Math.abs(b - a) / 15)) : 1);
  };
  const [cx, cy, cz, , , ez] = box;
  if (m.kind === 'slide' || m.kind === 'path') {
    const spots = [ZERO, ...(m.kind === 'slide' ? [m.to] : m.points).map(local)];
    const route = m.back === 'jump' ? spots : m.back === 'start' ? [...spots, ZERO] : [...spots, ...spots.slice(0, -1).reverse()];
    if (m.back === 'jump') hold(m.pause);         // it waits at the start too, after jumping back there
    route.slice(1).forEach((s, k) => { move(route[k], s); hold(m.pause); });
  } else if (m.kind === 'spin') {
    const steps = m.steps ?? 1, step = 360 / steps * (m.reverse ? -1 : 1);
    for (let k = 0; k < steps; k++) { spin(m.seconds, k * step, (k + 1) * step, m.axis, [cx, cy, cz], m.smooth ? SMOOTH : STEADY); hold(m.pause); }
  } else {
    const pivot = [cx, cy, cz + { top: ez, middle: 0, bottom: -ez }[m.hinge]], A = m.angle, d = m.seconds;
    const out = m.smooth ? [u => Math.sin(u * Math.PI / 2), u => Math.PI / 2 * Math.cos(u * Math.PI / 2)] : STEADY;   // a pendulum: fastest as it hangs
    const across = m.smooth ? [u => (1 - Math.cos(u * Math.PI)) / 2, u => Math.PI / 2 * Math.sin(u * Math.PI)] : STEADY;
    const back = m.smooth ? [u => 1 - Math.cos(u * Math.PI / 2), u => Math.PI / 2 * Math.sin(u * Math.PI / 2)] : STEADY;
    spin(d / 4, 0, A, m.axis, pivot, out, m.smooth);
    hold(m.pause);
    spin(d / 2, A, -A, m.axis, pivot, across, m.smooth);
    hold(m.pause);
    spin(d / 4, -A, 0, m.axis, pivot, back, m.smooth);
  }
  keys.at(-1).leave = [ZERO, ZERO];
  return { length: keys.at(-1).t, keys };
}

// {pos, rot} of the keys at time t (clamped to their span)
export function keysAt(keys, t) {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t < t) i++;
  const a = keys[i], b = keys[i + 1] ?? a, d = b.t - a.t;
  const u = d > 0 ? Math.min(1, Math.max(0, (t - a.t) / d)) : 0, u2 = u * u, u3 = u2 * u;
  const h = [2 * u3 - 3 * u2 + 1, u3 - 2 * u2 + u, -2 * u3 + 3 * u2, u3 - u2];
  const curve = n => [0, 1, 2].map(k => h[0] * a[n][k] + h[1] * d * a.leave[n === 'pos' ? 0 : 1][k] + h[2] * b[n][k] + h[3] * d * b.arrive[n === 'pos' ? 0 : 1][k]);
  return { pos: curve('pos'), rot: curve('rot') };
}

// The shape's box in its own frame, scaled: what motionKeys takes, from an actor's mesh bounds and scale
export const scaledBox = (bounds, scale3d, scale = 1) => {
  const s = scale3d.map(v => v * scale);
  return bounds ? [...[0, 1, 2].map(k => bounds[k] * s[k]), ...[0, 1, 2].map(k => Math.abs(bounds[3 + k] * s[k]))] : [0, 0, 0, 0, 0, 0];
};
