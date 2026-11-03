# Building Rocket League maps as an AI agent

This editor runs in the browser. If you can run JavaScript in its page and take screenshots, you can build a map
here on your own with `window.mapAI`. Build it in steps, read back the facts, look at the result, and fix what's
wrong. Nothing leaves the user's computer. Saving the map, or loading it into the game, needs the user's click.

## Calls

| Call | What it does |
|---|---|
| `await mapAI.help()` | This guide. |
| `await mapAI.apply(step)` | Changes the map (see Steps). Returns `{ok: true, objects, warnings}`, or `{ok: false, errors}`. A step with errors changes nothing. |
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
  spawn: { at: [x, y, z], yaw: 0 },   // where the car starts: a point on a surface
  ball: "roof",                // "roof" (on the car), {at: [x, y, z]} (on the surface there), or "start" (the game's default)
  add: [ /* shapes and checkpoints, below */ ],
  remove: ["pad3"]             // ids to delete
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
`-` or `_`; leave the id out and the editor gives one.

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

### Checkpoints

```js
{ id: "gate1", checkpoint: "ball", at: [x, y, z], yaw: 0, gate: true, size: [20, 1200, 700], ballOnTop: true, visible: true }
```

- `checkpoint: "car"`: the car passing through it saves the spot. `"ball"`: the ball passing through saves it, and
  a reset there also brings a new ball, on the car's roof a little ahead of its middle (`ballOnTop: true`), or 250
  ahead of it.
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
