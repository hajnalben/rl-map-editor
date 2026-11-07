# Building Rocket League maps as an AI agent

This editor runs in the browser. If you can run JavaScript in its page and take screenshots, you can build a map
here on your own with `window.mapAI`. Build it in steps, read back the facts, look at the result, and fix what's
wrong. Nothing leaves the user's computer. Saving the map, or loading it into the game, needs the user's click.

## Calls

| Call | What it does |
|---|---|
| `await mapAI.help()` | This guide. |
| `await mapAI.apply(step)` | Changes the map (see Steps; `script` sets the map's script, see Scripts). Returns `{ok: true, objects, warnings}`, or `{ok: false, errors}`. A step with errors changes nothing. |
| `mapAI.state()` | The map as it is now: floor height, surfaces, lighting, lava, spawn, ball, every object (id, kind, `at`, `size`, rotation, world `box`, and where a reset at each checkpoint puts the car), plus warnings. |
| `mapAI.ground(x, y)` | The top surface at x, y: `{z, on}` (`on` is an object id, `"floor"` or `"terrain"`), or `null`. |
| `await mapAI.look(view)` | Points the editor camera and labels objects with their ids. **Take a screenshot afterwards.** `view` is `"top"` (the whole map from above), `"overview"` (at an angle from behind the spawn), `"spawn"` (behind the car, looking ahead), an object id (close-up), or `{from: [x, y, z], at: [x, y, z]}`. The bar in the corner is the scale at the middle of the view. Add `{labels: false}` as a second argument to hide the labels. |

## How to work

1. `await mapAI.apply({new: true, name: "…", …})` starts over on a blank map (it discards the open map) and adds
   the first pieces. Without `new`, a step adds to the map that is open.
2. Read `mapAI.state()`. Check the warnings, and the numbers: gaps between boxes, heights, where resets land.
   Use `mapAI.ground(x, y)` for exact heights, for example on a ramp.
3. Run `await mapAI.look("top")`, take a screenshot, then `look("spawn")` and `look("<id>")` for details.
4. Fix and repeat. An `add` with an id that is already there replaces that object; `remove: ["id"]` deletes one.
5. When done, `look("overview")`, show the user, and ask them to click **Save as…**, or **Game ▾ → Load into
   game**. The game must be at its main menu; the map then plays in Free Play → Underpass.

## Units and axes

- Unreal units: about 1 cm each. **X** is forward (the car faces +X at yaw 0), **Y** is to the right, and
  **Z** is up. Yaw 90 turns +X toward +Y. In the top view, +X points right and +Y points down.
- The blank map's floor is flat, its top at z = 0 (`state().floor`), and it reaches 100000 in every direction.
  Coordinates must stay within ±100000.
- Angles are in degrees.

## Steps

A step is an object with any of these fields:

```js
{
  new: true,                   // start over on a blank map
  name: "Lava Climb",          // file name for Save as
  lighting: "warm",            // "day", "warm" (golden hour), "cool" (overcast), "dim", or "map" (as the map has it)
  lava: "both",                // the floor resets you: "car", "ball", "both" or "none"
  timer: true,                 // on screen "Time: M:SS", frozen once the last checkpoint is the respawn point
  deaths: true,                // on screen "Deaths: N": lava touches and resets
  spawn: { at: [x, y, z], yaw: 0 },   // where the car starts: a point on a surface
  ball: "roof",                // "roof" (on the car), {at: [x, y, z]} (on the surface there), or "start" (the game's default)
  add: [ /* shapes, checkpoints and lights, below */ ],
  remove: ["pad3"],            // ids to delete
  script: "on(start, text('Go!'))"   // the map's script (see Scripts), run after the step's other changes
}
```

Within a step, removals happen first, then additions, lava, the spawn and the ball. That way the spawn and the
ball settle onto shapes added in the same step.

### Shapes

```js
{ id: "pad1", shape: "platform", at: [x, y, z], size: [x, y, z], yaw: 0, pitch: 0, roll: 0, surface: "White" }
```

`at` is where the bottom centre of the shape's box goes. Rotation turns the shape about that point. `size` is the
box size; leave it out for the natural size. Only `shape` and `at` are needed. Ids are up to 40 letters, digits,
`-` or `_`; leave the id out and the editor gives one. The map keeps ids, so they are the same when it is opened again.

| shape | natural size (x × y × z) | notes |
|---|---|---|
| `platform` | 1000 × 1000 × 100 | a flat slab; its top is at `at` z + size z |
| `ramp` | 1200 × 1000 × 400 | rises toward +X, from the floor at -X to 400 high at +X |
| `pillar` | 240 × 240 × 800 | a 20-sided column |
| `ring` | 104 × 1110 × 1110 | upright: fly through it along X. Inner radius about 500; the centre is 555 above `at` |
| `quarter pipe` | 860 × 1000 × 800 | curves up from the floor at -X into a wall at +X |

Surfaces come from `state().surfaces`. The blank map has Sand, White, Gray, Dark, Blue, Orange, Green, FieldGlass,
Metal_Master, CS_Concrete, Concrete_Hexagons, BCH_Plastic_White and Ice_02. Every shape is solid: cars drive on it,
and the car and the ball bounce off it.

### Moving shapes

A shape with `motion` moves in the game (a Matinee, as Leth's maps move their platforms). The car and the ball ride
on it and bounce off it, but as its box: a moving ring or ramp is a solid block to them, and a pillar has corners.
Keep moving shapes box-like (platforms, walls, pillars). `look()` shows shapes where they start; the editor plays the
motions.

```js
{ id: "lift", shape: "platform", at: [0, 0, 300], motion: { kind: "slide", to: [0, 0, 800], seconds: 3, pause: 1 } }
```

| kind | what it does | its own settings (defaults) |
|---|---|---|
| `slide` | goes to a second spot and back | `to`: [x, y, z] from where it stands ([1000, 0, 0]); `back`: `"same"` or `"jump"` |
| `path` | visits spots in order, then back | `points`: up to 20 [x, y, z] from where it stands; `back`: `"same"` (retraces), `"start"` (straight back) or `"jump"` |
| `spin` | keeps turning about its middle | `axis`: `"yaw"` (flat, a turntable), `"roll"` (a windmill facing the way it points), `"pitch"` (tumbling); `steps` (1): turns in that many steps; `reverse` (false) |
| `swing` | swings back and forth like a pendulum | `axis` (`"roll"`), `angle` (45): degrees each way; `hinge`: `"top"`, `"middle"` or `"bottom"` of the shape |

Every kind also takes:
- `seconds`: one move (slide, path), one step (spin: a whole turn with 1 step), or one whole swing there and back.
  Defaults 2, 2, 4, 3.
- `smooth` (true, spin false): eases into and out of every stop; a swing moves like a pendulum. False is steady speed.
- `pause` (0): seconds it waits at each stop: a spot, after a spin step, at the ends of a swing.
- `delay` (0): seconds after its start before it moves.
- `trigger` (null): a checkpoint id; it starts when the car or ball touches that checkpoint, else with the map.
- `once` (false): goes through its round once instead of over and over. With `back: "jump"` it then stays at its
  last spot, which makes a door that opens or a bridge that drops when a checkpoint is touched.

Offsets are world units from where the shape starts, whatever way it faces. Give a moving shape room: a car
standing on a platform that slides under another shape gets pushed off.

### Checkpoints

```js
{ id: "gate1", checkpoint: "ball", at: [x, y, z], yaw: 0, gate: true, size: [20, 1200, 700], ballOnTop: true, visible: true }
```

- `checkpoint: "car"`: the car passing through it saves the spot. `"ball"`: the ball passing through saves it, and
  a reset there also brings a new ball, on the car's roof a little ahead of its middle (`ballOnTop: true`), or 250
  ahead of it.
- In game the quick-chat keys work every checkpoint map: chat 1 resets to the last checkpoint at once, chat 2 and
  chat 3 go to the previous and next one (the spawn first). Scripts shouldn't use `chat1`…`chat3` for their own.
- A reset (Backspace in Free Play, or touching lava) puts the car at the last saved checkpoint, 30 above the ground
  under it, facing the checkpoint's yaw. The spawn counts as the first checkpoint.
- `at` is a point on the ground or pad where the checkpoint stands; the zone reaches 50 below it. The natural size
  is 1024 × 1024 × 704 (depth along its facing × width × height).
- `gate: true` makes it 20 thick: a doorway you pass through, facing its yaw. A reset there puts the car 250 past
  it, so leave pad under that spot. Boxes (no `gate`) are zones you drive or dribble into.
- `visible: true` shows a panel of its size in the game, in the map's glass surface; nothing collides with it. A
  surface name instead of `true` uses that surface. Checkpoints without it are invisible in the game.
- When a checkpoint becomes the respawn point, its `title` (up to 60 characters, e.g. `"The Stairs"`) shows on screen
  for 2 seconds; without one it shows "Checkpoint N", numbered in the order checkpoints were added. Titles that
  name the regions of a course read well.

### Lights

```js
{ id: "lamp1", light: "point", at: [x, y, z], color: "#ffaa44", brightness: 2, radius: 2000, shadows: false, on: true }
```

| light | what it is | fields besides `at`, `color`, `brightness`, `shadows`, `on` | new one |
|---|---|---|---|
| `point` | a bulb shining every way, fading out to `radius` | `radius` | brightness 2, radius 2000 |
| `spot` | a cone along `yaw` and `pitch` (−90 points straight down); full brightness inside `core`, fading out to `cone` (degrees from its middle) | `radius`, `cone`, `core`, `yaw`, `pitch` | brightness 3, radius 3000, cone 30, core 15, pitch −90 |
| `sun` | light from far away along `yaw` and `pitch`; where it stands doesn't matter | `yaw`, `pitch` | brightness 0.5, pitch −45 |
| `sky` | even light from all around | | brightness 0.3 |

- `at` is where the light itself is, not a point on the ground. A point or spot light lights what is within `radius`
  of it, so put it a few hundred units over a pad, or along a course every 1500–3000.
- Brightness 1 is a plain light; most maps' suns are 0.3 to 1.3 and the blank map's add up to about 2. Coloured
  point lights of 2–10 show well. Shadows cost frame rate; leave them off unless one light matters.
- The map's own lights are in `state().objects` with `kind: "light"`; an `add` with one's id replaces it. `lighting`
  tints the suns and sky lights as a whole.
- `look()` shows point and spot lights as they light the view (up to 12 points and 4 spots near the middle of
  the view).

### Trigger zones

```js
{ id: "pad", zone: "box", at: [x, y, z], size: [x, y, z], yaw: 0, visible: false }
```

A box (`"box"`) or 20-thick doorway (`"gate"`) that does nothing by itself: scripts react to the car or ball going
in or out. Sized and placed like checkpoints; `visible` shows a glass panel in the game.

With `gravity` it is a **gravity zone** instead: inside it the car and ball fall with that gravity, not the map's.
Rocket League's own is `-650`; `-200` floats, `-2000` is heavy, a positive number pulls up. Workshop maps use -5000
(ThePath), -1000 and +1000.

## Scripts

A map's script is JavaScript that says what happens when: `apply({script: "..."})`, or the editor's **Script**
panel. It runs once in the editor and is written into the map as Kismet, which is all the game runs. So it reacts to
events, but only with what it set up beforehand: nothing follows the car around, and code doesn't run while you play.
Objects are found by their id (the inspector's Name).

```js
const lift = shape('lift'), pad = zone('pad'), gate = checkpoint('gate1'), lamp = light('lamp');
const up = lift.clip({ kind: 'slide', to: [0, 0, 600], seconds: 2 });          // a movement, played on demand
const bob = lift.clip(3, t => ({ move: [0, 0, 80 * Math.sin(t * 2 * Math.PI / 3)] }), { loop: true });
const open = flag('open'), hits = counter('hits');

on(start, bob.play, text('Welcome!', 3, { color: '#40c0ff' }));
on(pad.enter('car'), up.play, open.set(true));
on(pad.leave(), up.reverse);
on(gate.reached, emit('bridge'), once(text('First time here')));
on(signal('bridge'), lamp.toggle, wait(2, lamp.off));
on(every(5), when(open.is(true), launch('car', [0, 0, 900])).else(text('closed', 1)));
on(pressed('jump'), hits.add(1), when(hits.atLeast(3), text('Three jumps!'), hits.set(0)));
on(reset, up.stop, open.set(false));
```

`on(event, ...reactions)`: reactions run in order, right away; `wait` and `when` run theirs on the side.

| events | when |
|---|---|
| `start` | the map starts |
| `after(s)`, `every(s)` | s seconds after the start; every s seconds |
| `zone(id).enter(by)`, `.leave(by)` | the car, ball or either (`"car"`, `"ball"`, `"any"`, the default) goes in or out |
| `checkpoint(id).enter(by)`, `.leave(by)`, `.reached` | the same for a checkpoint; `reached`: it becomes the respawn point |
| `reset` | the car respawns (a reset, the chat 1 reset key, lava, falling; not the first spawn) |
| `lava(by)` | the car touches lava that resets on the car, or the ball lava that resets on the ball |
| `pressed(button)` | a fresh press of `jump`, `boost`, `handbrake`, `ballcam`, `reset`, `chat1`…`chat4` |
| `signal(name)` | `emit(name)` ran |
| `goal(team)` | a goal: `"blue"`, `"orange"` or `"any"` (maps with goals) |
| `clip.finished`, `clip.reversed` | a clip got to its end, or back to its start |

| reactions | what they do |
|---|---|
| `clip.play`, `.reverse`, `.stop`, `.pause`, `.flip` | play a movement from its start (or on, if looping), back, stop it, pause or go on, turn around |
| `text(message, seconds = 2, {size, at, color})` | on screen; `size` 2, `at` [x, y] pixels from the middle of the screen ([-80, -300]), `color` "#rrggbb" |
| `light(id).on`, `.off`, `.toggle` | point and spot lights (the switchable kind) |
| `shape(id).hide`, `.show` | gone (moved far below, so nothing hits it) and back |
| `launch(what, [x, y, z])` | sets the velocity of `"car"` or `"it"` (what set off a zone, checkpoint or lava event) |
| `teleport(what, id, {stop: true})` | moves `"car"` or `"it"` to an object, stopped unless `stop: false` |
| `emit(name)` | sets off `signal(name)` |
| `wait(s, ...reactions)` | those, s seconds later |
| `when(test, ...reactions).else(...reactions)` | only if the test holds |
| `once(...reactions)` | only the first time |
| `flag(name, initial)`: `.set(v)`, `.toggle` / `.is(v)` | an on/off switch and its test |
| `counter(name, initial)`: `.add(n)`, `.set(n)` / `.is(n)`, `.atLeast(n)`, `.below(n)` | a whole number and its tests |

Clips: `shape(id).clip(motion, {loop})` takes a motion as in "Moving shapes" (kind slide, spin, path, swing);
`shape(id).clip(seconds, t => ({move: [x, y, z], turn: [yaw, pitch, roll]}), {loop})` is any movement over time:
`move` in world units from where the shape stands, `turn` in degrees about its middle, sampled 30 times a second.
A clip plays from wherever the shape is when it starts. Shapes a script moves, shows or hides must be added in the
editor (they are written as movers).

### Lava

`lava: "car"` resets the car when the car touches the floor. `"ball"` resets the car and the ball when the ball
touches it. `"both"` does both, which suits dribbling courses. Lava covers the whole floor and shows in a fiery surface. So
the spawn and every checkpoint's reset spot must be on shapes above the floor; the warnings tell you when one is not.

## Play facts for sizing a course

- Car (Octane): about 118 long, 84 wide and 36 tall; it rests 17 above the ground. Ball: radius 91 (183 across).
- Driving speed is about 1400 per second, and up to 2300 with boost. Gravity is 650 per second squared.
- A full jump lifts the car about 230; a quick double jump about 500. A jump at driving speed carries it roughly
  2000 forward (an estimate, not tested here).
- Tested in the game with the ball on the roof (a 10-level lava dribble course rated right for a solid dribbler):
  gaps between pads of 300 (easy) up to 800 (hard), steps up of 100–150, drops of 120, pads 650–1700 wide.
- Without `ball`, Free Play puts the ball at the field centre (0, 0), resting at z = 0, even under a shape built
  over that spot. With ball lava, a ball comes at the spawn instead. `state().ball.centre` shows where.
- For a dribbling course, use `lava: "both"`, ball checkpoints with `ballOnTop: true`, and `ball: "roof"`.

## Example

```js
await mapAI.apply({
  new: true, name: "Example Course", lighting: "warm", lava: "both",
  add: [
    { id: "start", shape: "platform", at: [0, 0, 400], size: [1600, 1600, 100], surface: "Gray" },
    { id: "pad1", shape: "platform", at: [1800, 0, 400], size: [1200, 1200, 100], surface: "White" },
    { id: "gate1", checkpoint: "ball", at: [1500, 0, 500], gate: true, size: [20, 1200, 700], ballOnTop: true, visible: true },
    { id: "pad2", shape: "platform", at: [3400, 0, 500], size: [1200, 1200, 100], surface: "Blue" },
  ],
  spawn: { at: [0, 0, 500], yaw: 0 },
  ball: "roof",
});
mapAI.state().warnings;                 // [] when the course is sound
await mapAI.look("top");                // then take a screenshot
```
