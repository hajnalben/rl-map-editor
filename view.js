// The 3D view: three.js drawing the document (sync), the gizmo, snapping, the terrain's tiles, surfaces as the map
// shows them, and what the view finds under a point. It keeps no map state of its own: main.js commits what the
// gizmo and the brush do back into the document.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shapes } from './map.js';
import { BALL_AHEAD, BALL_FRONT_LIFT, BALL_LIFT, BALL_TOP_AHEAD } from './kismet.js';
import { eulerRotator, keysAt, motionKeys, scaledBox, ueAxes } from './motion.js';
import { corners } from './shapes.js';
import { nameLook, surfaceLook, textureImage } from './looks.js';
import { BALL_REST, GATE_PAST, RESPAWN_CLEARANCE, floorOf, isGate, isSolid, isVolume, isZone, single } from './doc.js';
import { docSig, ed, eyeOff, shapeData } from './state.js';
import { ui } from './ui.js';

// Unreal is left-handed Z-up, Three.js right-handed Y-up: swapping Y and Z converts without mirroring.
const UU = Math.PI / 32768;                       // rotator units to radians
export const toThree = v => new THREE.Vector3(v[0], v[2], v[1]);
export const fromThree = v => [v.x, v.z, v.y];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function ueToQuat(rot) {
  const [X, Y, Z] = ueAxes(rot);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(toThree(X), toThree(Z), toThree(Y)));
}
export function quatToUe(q) {                     // FMatrix::Rotator
  const c = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  new THREE.Matrix4().makeRotationFromQuaternion(q).extractBasis(c[0], c[1], c[2]);
  const X = fromThree(c[0]), Z = fromThree(c[1]), Y = fromThree(c[2]);
  const pitch = Math.atan2(X[2], Math.hypot(X[0], X[1]));
  const yaw = Math.atan2(X[1], X[0]);
  const sy = [-Math.sin(yaw), Math.cos(yaw), 0];
  return [pitch, yaw, Math.atan2(dot(Z, sy), dot(Y, sy))].map(a => Math.round(a / UU));
}
for (const rot of [[0, 0, 0], [3160, 25980, -4096], [-5728, 64096, -5328], [0, -21504, 16384], [12000, -9000, 30000]]) {
  const back = ueAxes(quatToUe(ueToQuat(rot))), want = ueAxes(rot);
  console.assert(back.every((ax, i) => ax.every((v, k) => Math.abs(v - want[i][k]) < 1e-3)), 'rotation round trip failed', rot);
}

// what main.js hears from the view: picks, drags (with [{uid, loc, rot, scale3d}] read back), brush strokes
/** @type {Record<'pick' | 'dragStart' | 'drag' | 'dragEnd' | 'strokeStart' | 'strokeStep' | 'strokeEnd', (...args: any[]) => void>} */
export const hooks = { pick() {}, dragStart() {}, drag() {}, dragEnd() {}, strokeStart() {}, strokeStep() {}, strokeEnd() {} };

export const el = document.getElementById('view');
export const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
el.appendChild(renderer.domElement);
export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111317);
const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x30343c, 2.2);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.4, 1, 0.3);
scene.add(hemi, sun);
let grid = null;
export function fitGrid(reach = 50000) {          // 1000-unit squares from the origin out to `reach` every way
  const size = 2 * Math.ceil(reach / 1000) * 1000;
  if (grid?.userData.size === size) return;
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(size, size / 1000, 0x2a2f38, 0x1d2128);
  grid.userData.size = size;
  scene.add(grid);
}
fitGrid();
export const camera = new THREE.PerspectiveCamera(60, 1, 10, 2e6);
export const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
export const gizmo = /** @type {any} */ (new TransformControls(camera, renderer.domElement));   // its drag state (pointStart, rotationAngle) isn't in its types
gizmo.setSize(0.9);
scene.add(gizmo);
const group = new THREE.Group();
scene.add(group);
const meshes = new Map();                         // uid -> the mesh drawing it
export const meshOf = uid => meshes.get(uid);
export function setMood(p) {                      // a LIGHTING mood (map.js) on the view's own lights; undefined: the map's
  const [r, g, b] = (p?.tint ?? [255, 255, 255]).map(v => v / 255);
  sun.color.setRGB(r, g, b, THREE.SRGBColorSpace);
  sun.intensity = 1.4 * (p?.brightness ?? 1);
  hemi.intensity = 2.2 * (p ? 0.5 + 0.5 * p.brightness : 1);
}

// The selection: a box round each, the gizmo on a helper at the middle of them all (Unreal pivots can sit far away
// from the mesh). One object turns and scales the way it stands, several the way the map does.
const pivot = new THREE.Object3D();
scene.add(pivot);
let selected = [], offsets = [], drag = null;
const selBoxes = /** @type {THREE.Group & {children: THREE.BoxHelper[]}} */ (new THREE.Group());
scene.add(selBoxes);
export function boxOf(obj) {                      // the object's own shape, leaving out helpers such as arrows
  if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
  obj.updateMatrixWorld();
  return obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
}
export const unionBox = list => list.reduce((box, o) => box.union(boxOf(o)), new THREE.Box3());
export function select(uids) {
  selected = uids.map(meshOf).filter(Boolean);
  showSelection();
  attach();
}
function attach() {
  if (!selected.length || !tools.modes.length) return gizmo.detach();
  const one = selected.length === 1 ? selected[0] : null;
  pivot.position.copy(unionBox(selected).getCenter(new THREE.Vector3()));
  pivot.quaternion.copy(one ? one.quaternion : new THREE.Quaternion());
  pivot.scale.copy(one ? one.scale : new THREE.Vector3(1, 1, 1));
  pivot.updateMatrixWorld();
  offsets = selected.map(o => { o.updateMatrixWorld(); return pivot.matrixWorld.clone().invert().multiply(o.matrixWorld); });
  gizmo.attach(pivot);
}
export function showSelection() {
  for (const b of selBoxes.children) b.dispose();
  selBoxes.clear();
  for (const o of selected) selBoxes.add(new THREE.BoxHelper(o, 0xffd24a));
  showLightGuide(selected.length === 1 ? selected[0] : null);
  showMotionGuide(selected.length === 1 ? selected[0] : null);
}
let tools = { modes: [], yawOnly: false };
export function setTools(mode, can) {             // the gizmo's mode, and what the selection allows ({modes, yawOnly})
  tools = can;
  gizmo.setMode(mode);
  gizmo.showX = gizmo.showZ = !(mode === 'rotate' && can.yawOnly);   // three's Y is up: yaw only
  attach();
}
export const readBack = o => ({ uid: o.userData.uid, loc: fromThree(o.position), rot: quatToUe(o.quaternion),
  scale3d: [o.scale.x, o.scale.z, o.scale.y].map((v, k) => v / (o.userData.e.scale * (o.userData.e.inner?.[k] ?? 1))) });
gizmo.addEventListener('dragging-changed', e => {
  orbit.enabled = !e.value;
  if (e.value) {
    drag = startDrag();
    hooks.dragStart(selected.map(o => o.userData.uid));
  } else {
    drag = null;
    endDrag();
    hooks.dragEnd(selected.map(readBack));
    attach();
  }
});
gizmo.addEventListener('objectChange', () => {
  if (drag) snapDrag();
  pivot.updateMatrixWorld();
  selected.forEach((o, k) => pivot.matrixWorld.clone().multiply(offsets[k]).decompose(o.position, o.quaternion, o.scale));
  if (drag) showDrag();
  for (const b of selBoxes.children) b.update();
  hooks.drag(selected.map(readBack));
});
export const dragging = () => gizmo.dragging;

// Snapping (G) while dragging: the selection's lower corner lands on the grid, unless one of its faces or its middle
// comes within a few pixels of a nearby shape's, which it then lines up with. Sizes go in grid steps, yaw in 15°
// turns of the map (other rings 15° from where they started). ⌘ held while dragging snaps the other way for that
// moment. Scaling keeps the side across from the grabbed handle in place; scaling all ways keeps the bottom.
const TURN = THREE.MathUtils.degToRad(15), YAW_STEP = 65536 / 24, AXES = ['x', 'y', 'z'];
const UE_AXIS = { x: 'X', y: 'Z', z: 'Y' };      // three's axes by their Unreal names
let freeDrag = false, dragAt = [0, 0];
window.addEventListener('pointermove', e => { freeDrag = e.metaKey || e.ctrlKey; dragAt = [e.clientX, e.clientY]; }, true);
const snapping = () => ui.snap.value !== freeDrag;
const snapStep = () => ui.snapStep.value;
const guideGeo = new THREE.BoxGeometry(1, 1, 1), guideEdges = new THREE.EdgesGeometry(guideGeo);
const guideFill = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.18, depthWrite: false });
const guideLine = new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false });   // over the shape's own edges
const snapGuides = AXES.map(() => {                // the shape being lined up with, one per snapped axis
  const g = new THREE.Mesh(guideGeo, guideFill);
  g.add(new THREE.LineSegments(guideEdges, guideLine));
  g.visible = false;
  return g;
});
scene.add(...snapGuides);
const showGuide = (g, box) => {
  box.getCenter(g.position);
  box.getSize(g.scale).addScalar(4);
  g.visible = true;
};
let snapGrid = null;
function startDrag() {
  const mine = new Set(selected);
  const others = [...meshes.values()].filter(o => !mine.has(o) && o.visible && o.userData.e.bounds && !single(o.userData.e));
  const one = selected.length === 1 ? selected[0] : null, box = unionBox(selected);
  return { pos: pivot.position.clone(), quat: pivot.quaternion.clone(), scale: pivot.scale.clone(), box,
           size: one ? (one.geometry.computeBoundingBox(), one.geometry.boundingBox.getSize(new THREE.Vector3())) : box.getSize(new THREE.Vector3()),
           others: others.map(boxOf), grab: gizmo.pointStart.clone().applyQuaternion(pivot.quaternion.clone().invert()) };   // which end of a scale axis
}
function snapDrag() {
  const used = AXES.filter(c => gizmo.axis.includes(c.toUpperCase()));
  for (const g of snapGuides) g.visible = false;
  if (gizmo.mode === 'translate') { if (snapping()) snapMove(used); }
  else if (gizmo.mode === 'scale') snapSize(used);
  else if (snapping()) snapTurn();
}
function snapMove(used) {
  const box = drag.box.clone().translate(pivot.position.clone().sub(drag.pos)), step = snapStep();
  const near = box.clone().expandByScalar(1000 + box.getSize(new THREE.Vector3()).length());
  const others = drag.others.filter(b => b.intersectsBox(near)), tol = 8 * pixelAt(pivot.position);
  const mid = (b, c) => (b.min[c] + b.max[c]) / 2;
  used.forEach((c, n) => {
    let best = null;
    for (const b of others) {
      for (const d of [b.min[c] - box.min[c], b.min[c] - box.max[c], b.max[c] - box.min[c], b.max[c] - box.max[c], mid(b, c) - mid(box, c)]) {
        if (Math.abs(d) < tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, b };
      }
    }
    const d = best ? best.d : Math.round(box.min[c] / step) * step - box.min[c];
    pivot.position[c] += d;
    box.min[c] += d;
    box.max[c] += d;
    if (best) showGuide(snapGuides[n], best.b);
  });
}
function snapSize(used) {
  const s = pivot.scale, start = drag.scale, size = drag.size, step = snapStep();
  if (snapping() && used.length === 3) {          // the longest side in whole steps, the others in proportion
    const longest = Math.max(...AXES.map(c => size[c] * Math.abs(start[c])));
    const f = Math.max(step, Math.round(longest * s.x / start.x / step) * step) / longest;
    s.copy(start).multiplyScalar(f);
  } else if (snapping()) {
    for (const c of used) s[c] = Math.sign(s[c] || 1) * Math.max(step, Math.round(size[c] * Math.abs(s[c]) / step) * step) / size[c];
  }
  pivot.position.copy(drag.pos);
  if (used.length === 3) pivot.position.y += (drag.pos.y - drag.box.min.y) * (s.x / start.x - 1);
  else for (const c of used) {
    const grown = size[c] * (Math.abs(s[c]) - Math.abs(start[c])), dir = new THREE.Vector3().setComponent(AXES.indexOf(c), 1);
    pivot.position.addScaledVector(dir.applyQuaternion(drag.quat), Math.sign(drag.grab[c] || 1) * grown / 2);
  }
}
function snapTurn() {
  if (gizmo.axis === 'Y') {                       // about the up axis only yaw changes: whole steps of it
    const r = quatToUe(pivot.quaternion);
    r[1] = Math.round(r[1] / YAW_STEP) * YAW_STEP;
    pivot.quaternion.copy(ueToQuat(r));
  } else pivot.quaternion.setFromAxisAngle(gizmo.rotationAxis, Math.round(gizmo.rotationAngle / TURN) * TURN).multiply(drag.quat);
}
const pixelAt = p => 2 * camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / el.clientHeight;
const dragInfo = document.getElementById('dragInfo');
function showDrag() {                             // the grid being snapped to, and what the drag has done so far
  const box = unionBox(selected), gridded = snapping() && gizmo.mode !== 'rotate', step = snapStep();
  if (snapGrid?.userData.step !== step) {
    if (snapGrid) { scene.remove(snapGrid); snapGrid.geometry.dispose(); snapGrid.material.dispose(); }
    snapGrid = new THREE.GridHelper(step * 40, 40, 0x00e5ff, 0x00e5ff);
    Object.assign(snapGrid.material, { transparent: true, opacity: 0.45 });
    snapGrid.userData.step = step;
    scene.add(snapGrid);
  }
  snapGrid.visible = gridded;
  snapGrid.position.set(Math.round(box.min.x / step) * step, box.min.y + 1, Math.round(box.min.z / step) * step);
  const used = AXES.filter(c => gizmo.axis.includes(c.toUpperCase())), moved = pivot.position.clone().sub(drag.pos);
  const signed = v => `${v > 0 ? '+' : ''}${Math.round(v)}`;
  const yaw = () => ((quatToUe(pivot.quaternion)[1] * 360 / 65536 % 360) + 540) % 360 - 180;
  dragInfo.textContent =
    gizmo.mode === 'translate' ? used.map(c => `${UE_AXIS[c]} ${signed(moved[c])}`).join('  ')
    : gizmo.mode === 'scale' ? ['x', 'z', 'y'].map(c => Math.round(drag.size[c] * Math.abs(pivot.scale[c]))).join(' × ')
    : gizmo.axis === 'Y' ? `yaw ${Math.round(yaw())}°` : `${Math.round(THREE.MathUtils.radToDeg(drag.quat.angleTo(pivot.quaternion)))}°`;
  const r = el.getBoundingClientRect();
  Object.assign(dragInfo.style, { left: `${dragAt[0] - r.left + 18}px`, top: `${dragAt[1] - r.top + 18}px` });
  dragInfo.hidden = false;
}
function endDrag() {
  for (const g of snapGuides) g.visible = false;
  if (snapGrid) snapGrid.visible = false;
  dragInfo.hidden = true;
}

let reframe = null;                               // an AI agent's last look(), fitted again to the view until you move the camera
export const setReframe = fn => { reframe = fn; };
for (const type of ['pointerdown', 'wheel', 'keydown']) window.addEventListener(type, () => { reframe = null; }, true);
function resize() {
  const { clientWidth: w, clientHeight: h } = el;
  if (!w || !h) return;                           // a hidden page measures 0 × 0; keep the last size
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  reframe?.();
}
new ResizeObserver(resize).observe(el);
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (stroking) hooks.strokeStep(dt, brushPoint);
  flyCamera(dt);
  orbit.update();
  renderNow();
});
export function renderNow() {
  syncLightPreview();
  const posed = ui.view.value.playMotion && !gizmo.dragging ? poseMovers() : [];
  renderer.render(scene, camera);
  for (const [o, p, q] of posed) { o.position.copy(p); o.quaternion.copy(q); o.visible = true; }
  drawLabels();
}
export const held = new Set();                    // keys down right now, read every frame by flyCamera
window.addEventListener('keyup', e => held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => held.clear());
function flyCamera(dt) {
  const forward = camera.getWorldDirection(new THREE.Vector3()).setY(0);
  if (forward.lengthSq() < 1e-4) forward.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0);   // looking straight down
  forward.normalize();
  const right = new THREE.Vector3(-forward.z, 0, forward.x), move = new THREE.Vector3();
  if (held.has('w')) move.add(forward);
  if (held.has('s')) move.sub(forward);
  if (held.has('d')) move.add(right);
  if (held.has('a')) move.sub(right);
  const fast = held.has('shift') ? 3 : 1;
  if (move.lengthSq()) {                          // speed follows zoom: about one view-distance per second
    move.normalize().multiplyScalar(Math.max(camera.position.distanceTo(orbit.target), 500) * dt * fast);
    camera.position.add(move);
    orbit.target.add(move);
  }
  const turn = (held.has('e') ? 1 : 0) - (held.has('q') ? 1 : 0);
  if (turn) {
    const offset = camera.position.clone().sub(orbit.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn * fast * dt * Math.PI / 2);
    camera.position.copy(orbit.target).add(offset);
  }
}
export function focus(uids) {
  const list = uids.map(meshOf).filter(Boolean);
  if (!list.length) return;
  const box = unionBox(list), c = box.getCenter(new THREE.Vector3());
  const d = Math.max(box.getSize(new THREE.Vector3()).length() * 1.6, 800);
  camera.position.copy(c).add(camera.position.clone().sub(orbit.target).normalize().multiplyScalar(d));
  orbit.target.copy(c);
}
export function lookAt(target, from) { orbit.target.copy(toThree(target)); camera.position.copy(toThree(from)); }

// Surfaces drawn the way the map shows them: its own textures, or a colour (see looks.js); the flat per-mesh colour
// when nothing is known, as for most of the game's own surfaces. With View > Game textures, game surfaces' looks
// read from the game's own packages (gameLooks, filled by main.js).
const colors = new Map();
function colorFor(key) {
  if (!colors.has(key)) {
    let h = 0;
    for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    colors.set(key, new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55));
  }
  return colors.get(key);
}
const boxCache = new Map(), matCache = new Map();
const markerGeo = new THREE.OctahedronGeometry(60);
function geometryFor(b) {
  if (!b) return markerGeo;
  const key = b.map(v => v.toFixed(1)).join(',');
  if (!boxCache.has(key)) {
    const g = new THREE.BoxGeometry(Math.max(2 * b[3], 1), Math.max(2 * b[5], 1), Math.max(2 * b[4], 1));
    g.translate(b[0], b[2], b[1]);
    boxCache.set(key, g);
  }
  return boxCache.get(key);
}
function materialFor(e) {
  const key = isVolume(e) ? 'vol:' + e.cls : e.bounds ? 'mesh:' + (e.mesh || e.cls) : 'marker:' + e.cls;
  if (!matCache.has(key)) {
    matCache.set(key, isVolume(e)
      ? new THREE.MeshBasicMaterial({ color: colorFor(e.cls), transparent: true, opacity: 0.12, depthWrite: false })
      : meshNamed(e.mesh || e.cls));
  }
  return matCache.get(key);
}
function meshNamed(name) {                        // what a mesh with no readable surface looks like: what its name hints, else a colour of its own
  const hint = nameLook(name);
  return new THREE.MeshStandardMaterial({ color: hint.color ?? colorFor(name), roughness: 0.7, metalness: 0.05, flatShading: true,
                                          ...(hint.opacity < 1 ? { transparent: true, opacity: hint.opacity, depthWrite: false } : {}) });
}
export const ZONE_COLORS = { car: 0x3ddc84, ball: 0xff9f43, lava: 0xff3b1f, zone: 0xb47cff, gravity: 0x38c6d9 };
const zoneMats = Object.fromEntries(Object.entries(ZONE_COLORS).map(([k, color]) =>
  [k, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false })]));
const shownZoneMats = Object.fromEntries(Object.entries(ZONE_COLORS).map(([k, color]) =>
  [k, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.8, roughness: 0.6 })]));
const zoneColor = e => e.kind === 'lava' || e.kind === 'zone' || e.kind === 'gravity' ? e.kind : e.ball ? 'ball' : 'car';
const zoneLook = e => (e.panel ? shownZoneMats : zoneMats)[zoneColor(e)];
const terrainMat = new THREE.MeshStandardMaterial({ color: 0xa08a64, roughness: 0.9, flatShading: true });
const shapeMat = new THREE.MeshStandardMaterial({ color: 0x9fb1c9, roughness: 0.6, flatShading: true });
const surfaceCache = new Map(), textureCache = new Map();
export const gameLooks = new Map(), gameWanted = new Set();
export const donorRef = value => ed.donor?.materials().find(m => m.name.replace(/(_\d+)+$/, '') === value.slice(6))?.ref;
function surfaceMaterial(ref, fallback) {
  if (!ref) return fallback;
  if (ref === 'lava' && !surfaceCache.has(ref)) surfaceCache.set(ref, new THREE.MeshStandardMaterial({ color: '#ff4a1c', roughness: 0.8, flatShading: true }));
  if (String(ref).startsWith('image:')) {
    const img = docSig.value?.images[ref];
    if (img && !surfaceCache.has(ref)) surfaceCache.set(ref, new THREE.MeshStandardMaterial({ map: imageTexture(img), roughness: 0.8, metalness: 0.05, flatShading: true }));
    return surfaceCache.get(ref) ?? fallback;
  }
  const borrowed = String(ref).startsWith('extra:');
  if (borrowed && !donorRef(ref)) return fallback;   // surfaces.upk still loading
  if (ref < 0 || (borrowed && donorRef(ref) < 0)) gameWanted.add(ref);
  const game = gameLooks.get(ref);
  if (game && !surfaceCache.has(ref)) {
    surfaceCache.set(ref, new THREE.MeshStandardMaterial({ map: game.texture && imageTexture(game.texture), roughness: 0.8, metalness: 0.05, flatShading: true,
      color: game.color ? new THREE.Color(...game.color.map(c => Math.min(1, Math.max(0, c)))) : 0xffffff }));
  }
  if (!surfaceCache.has(ref)) {
    const [from, at] = borrowed ? [ed.donor, donorRef(ref)] : [ed.pkg, ref];
    const look = surfaceLook(from, at), map = look.texture === null ? null : texture(look.texture, from);
    surfaceCache.set(ref, !map && !look.color ? null : new THREE.MeshStandardMaterial({
      map, color: map ? 0xffffff : look.color, roughness: 0.8, metalness: 0.05, flatShading: true,
      ...(look.emissive && map ? { emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.5 } : {}),
      ...(look.opacity < 1 ? { transparent: true, opacity: look.opacity, depthWrite: false } : {}) }));
  }
  return surfaceCache.get(ref) ?? fallback;
}
function texture(i, from) {                       // texture i of the map, or of surfaces.upk
  const key = from === ed.donor ? `extra:${i}` : i;
  if (!textureCache.has(key)) {
    const img = textureImage(from, i);
    textureCache.set(key, img && imageTexture(img));
  }
  return textureCache.get(key);
}
function imageTexture(img) {
  return Object.assign(new THREE.DataTexture(img.rgba, img.width, img.height), { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, anisotropy: 4, needsUpdate: true });
}
export function forgetSurfaces(keys = null) {     // these looks (all with none) are read again when next drawn
  for (const [k, m] of surfaceCache) if (!keys || keys.includes(k)) { m?.map?.dispose(); m?.dispose(); surfaceCache.delete(k); }
  if (keys) return;
  for (const t of textureCache.values()) t?.dispose();
  textureCache.clear();
  gameLooks.clear();                              // its references are the map's
  gameWanted.clear();
}
// what the map's meshes are made of: per mesh export, three geometry and its parts (shapes.meshGeometry groups)
const meshGeos = new Map();
export const partsOf = e => e.meshIndex === null ? null : meshGeos.get(e.meshIndex)?.groups ?? null;
function meshLook(e, materials = e.materials) {   // per part, the component's surface or the mesh's own
  const groups = partsOf(e) ?? [], own = materialFor(e), mats = (groups.length ? groups : [{ material: 0 }]).map((g, k) => surfaceMaterial(materials?.[k] || g.material, own));
  return mats.length === 1 ? mats[0] : mats;
}
export const terrainLook = surface => surfaceMaterial(surface ?? 0, terrainMat);
function lookOf(e) {
  if (e.kind === 'checkpoint' || e.kind === 'lava' || isZone(e)) return zoneLook(e);
  if (e.kind === 'shape' && e.i === null) return surfaceMaterial(e.surface === undefined ? ed.lastSurface : e.surface, shapeMat);
  if (!partsOf(e)) return materialFor(e);
  const s = e.surface;
  return Array.isArray(s) ? meshLook(e, s) : s !== undefined && s !== (e.materials[0] || null) ? surfaceMaterial(s, materialFor(e)) : meshLook(e);
}
function cornerGeometry(src, uvs = null, groups = []) {   // triangle corners in Unreal axes, their UVs, and parts
  const pos = new Float32Array(src.length);
  for (let v = 0; v < src.length; v += 3) {      // the Y/Z mirror also turns Unreal's clockwise fronts counter-clockwise
    pos[v] = src[v]; pos[v + 1] = src[v + 2]; pos[v + 2] = src[v + 1];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uvs) g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  groups.forEach((part, k) => g.addGroup(part.start, part.count, k));
  g.computeVertexNormals();
  return g;
}
const shapeGeos = new Map();
export const forgetShape = key => shapeGeos.delete(key);
export function shapeGeometry(key) {              // a built-in or library shape's geometry, its box computed
  if (!shapeGeos.has(key)) {
    const g = shapeData(key);
    if (!g) return null;
    const geo = cornerGeometry(corners(g), g.uvs ? corners(g, 'uvs', 2) : null);
    geo.computeBoundingBox();
    shapeGeos.set(key, geo);
  }
  return shapeGeos.get(key);
}

// The spawn is drawn as the car you start in: our own Octane-like model built around the Octane's hitbox
// (118 x 84.2 x 36.2, wheels where the game puts them, origin 17 units above the floor at rest).
function carModel() {
  const mat = (color, more = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, ...more });
  const paint = mat(0x2f6fdb, { metalness: 0.15 }), trim = mat(0x173a78), glass = mat(0x111823, { roughness: 0.15, metalness: 0.4 });
  const tire = mat(0x1c1c1c, { roughness: 0.85 }), rim = mat(0xb9c0cb, { roughness: 0.3, metalness: 0.7 });
  const lamp = mat(0xfff1c2, { emissive: 0x6b5a28 }), exhaust = mat(0x3a3f47, { metalness: 0.6 });
  const side = (points, width, bevel) => {        // a side profile (x forward, y up) pushed out across the car
    const depth = width - 2 * bevel;
    return new THREE.ExtrudeGeometry(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))),
      { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 1 }).translate(0, 0, -depth / 2);
  };
  /** @type {any[][]} [geometry, material] */
  const parts = [
    [side([[-45, -4], [67, -4], [72, 4], [68, 12], [27, 22], [-35, 27], [-45, 25]], 74, 4), paint],    // body: low nose, long hood
    [side([[26, 23], [6, 39], [-23, 39], [-35, 27]], 60, 3), glass],                                      // cabin and windows
    [side([[18, 39], [8, 42], [-21, 42], [-25, 39]], 50, 2), paint],                                      // roof
    [new THREE.BoxGeometry(11, 2.5, 70).translate(-47, 37, 0), trim],                                     // spoiler
    ...[-24, 24].map(z => [new THREE.BoxGeometry(4, 9, 4).translate(-43, 31, z), trim]),
    ...[-23, 23].map(z => [new THREE.BoxGeometry(2, 4, 13).translate(72.5, 7, z), lamp]),
    [new THREE.CylinderGeometry(4.5, 5.5, 6, 14).rotateZ(Math.PI / 2).translate(-49, 9, 0), exhaust],     // boost
  ];
  for (const [x, r] of [[51, 12.5], [-34, 15]]) {
    for (const z of [-35, 35]) {
      parts.push([new THREE.CylinderGeometry(r, r, 12, 28).rotateX(Math.PI / 2).translate(x, r - 17, z), tire],
                 [new THREE.CylinderGeometry(r * 0.58, r * 0.58, 12.8, 16).rotateX(Math.PI / 2).translate(x, r - 17, z), rim]);
    }
  }
  return new THREE.Mesh(mergeGeometries(parts.map(([g]) => g.index ? g.toNonIndexed() : g), true), parts.map(([, m]) => m));
}
const car = carModel();
const ballGeometry = new THREE.SphereGeometry(91.25, 32, 16), ballMat = new THREE.MeshStandardMaterial({ color: 0xe6e6e6, roughness: 0.45 });
const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false });
const lightGeo = new THREE.SphereGeometry(45, 16, 8);
const SUN_GOLD = 0xffc83d;
const sunGeo = mergeGeometries([new THREE.SphereGeometry(110, 24, 12),   // a ball with rays all round: a sun from any side
  ...[[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], ...[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x, y, z])))].map(d => {
    const ray = new THREE.ConeGeometry(26, 120, 8).translate(0, 210, 0);
    return ray.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...d).normalize()));
  })]);

// Drawing the document: a mesh per entity, made when it appears and dressed again whenever its entity changes
function makeMesh(e) {
  if (e.kind === 'spawn') return new THREE.Mesh(car.geometry, car.material);
  if (e.kind === 'ball') return new THREE.Mesh(ballGeometry, ballMat);
  if (e.kind === 'light') return new THREE.Mesh(e.light.kind === 'sun' ? sunGeo : lightGeo, new THREE.MeshBasicMaterial({ transparent: true }));
  if (e.kind === 'shape' && e.i === null) return new THREE.Mesh(shapeGeometry(e.shape) ?? geometryFor(e.bounds));
  return new THREE.Mesh(meshGeos.get(e.meshIndex)?.geo ?? geometryFor(e.bounds));
}
function applyActor(o, e) {
  o.position.copy(toThree(e.loc));
  o.quaternion.copy(ueToQuat(e.rot));
  if (e.kind === 'ball') return;                  // real size, whatever the marker zone's scale
  const s = e.scale, c = e.inner ?? [1, 1, 1];    // inner: the mesh component's own scale, kept apart from the actor's
  o.scale.set(e.scale3d[0] * s * c[0], e.scale3d[2] * s * c[2], e.scale3d[1] * s * c[1]);
}
function dress(o, e, was) {
  applyActor(o, e);
  if (e.kind === 'light') {
    if (e.light.kind === 'sun') o.material.color.set(SUN_GOLD);
    else o.material.color.setRGB(...e.light.color.map(v => v / 255), THREE.SRGBColorSpace);
    o.material.opacity = e.light.on ? 1 : 0.35;
  } else if (e.kind !== 'spawn' && e.kind !== 'ball') o.material = lookOf(e);
  if (e.kind === 'checkpoint' && (!o.userData.ghosts || was?.ball !== e.ball)) decorate(o, e);
}
// A checkpoint shows where a reset puts you: the car at its respawn spot facing the arrow (its local +X), and for
// ball checkpoints the new ball ahead of the car or above it. The ghosts keep their real size however the zone is scaled.
function decorate(o, e) {
  if (o.userData.ghosts) o.remove(...Object.values(o.userData.ghosts).filter(Boolean));
  const b = e.bounds;
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(b[0], b[2], b[1]), 700, ZONE_COLORS[e.ball ? 'ball' : 'car'], 200, 125);
  const carGhost = new THREE.Mesh(car.geometry, ghostMat), ball = e.ball ? new THREE.Mesh(ballGeometry, ghostMat) : null;
  o.add(arrow, carGhost, ...(ball ? [ball] : []));
  o.userData.ghosts = { arrow, car: carGhost, ball };
}
function fitGhosts(o, e) {
  const g = o.userData.ghosts;
  if (!g) return;
  const inverse = new THREE.Vector3(1 / o.scale.x, 1 / o.scale.y, 1 / o.scale.z);
  g.arrow.scale.set(inverse.y, inverse.x, inverse.z);   // the arrow's own Y points along the zone's X
  const past = isGate(e) ? GATE_PAST : 0, spot = respawnValues(e), dz = spot ? spot.loc[2] - e.loc[2] : 0;
  g.car.scale.copy(inverse);
  g.car.position.set(past, dz, 0).multiply(inverse);
  if (!g.ball) return;
  g.ball.scale.copy(inverse);
  g.ball.position.set(past + (e.ballOnTop ? BALL_TOP_AHEAD : BALL_AHEAD), dz + (e.ballOnTop ? BALL_LIFT : BALL_FRONT_LIFT), 0).multiply(inverse);
}
// The ball where it starts. Until you place it, where the game puts it: dropped at the spawn in maps that hand you
// one there (ball lava), else at the field centre, Free Play's kick-off spot. That spot is a resting ball's height
// over z = 0, whatever is built above it: a platform over the field centre covers the ball (seen in game).
export function ballStart(doc) {
  const ball = doc.objects.find(e => e.kind === 'ball'), start = doc.objects.find(e => e.kind === 'spawn');
  if (ball.placed) return ball.loc;
  if (start && (ed.map.spawnBall || doc.objects.some(e => e.kind === 'lava' && e.lava.ball))) {
    const onTop = !!ed.map.spawnBall?.onTop, forward = ueAxes(start.rot)[0], ahead = onTop ? BALL_TOP_AHEAD : BALL_AHEAD;
    return [start.loc[0] + forward[0] * ahead, start.loc[1] + forward[1] * ahead, start.loc[2] + (onTop ? BALL_LIFT : BALL_FRONT_LIFT)];
  }
  return [0, 0, (groundUnder([0, 0, BALL_REST], 50000) ?? 0) + BALL_REST];
}
// the document drawn; `live`: mid-drag, when only what changed is fitted again
export function sync(doc, live = false) {
  const seen = new Set();
  let changed = false;
  for (const e of doc.objects) {
    seen.add(e.uid);
    let o = meshes.get(e.uid);
    if (!o) {
      o = makeMesh(e);
      o.userData.uid = e.uid;
      meshes.set(e.uid, o);
      group.add(o);
    }
    if (o.userData.e !== e) {
      if (!(live && gizmo.dragging && selected.includes(o))) dress(o, e, o.userData.e);
      o.userData.e = e;
      changed = true;
    }
  }
  for (const [uid, o] of meshes) if (!seen.has(uid)) { group.remove(o); meshes.delete(uid); changed = true; }
  syncTiles(doc.terrain);
  const ball = doc.objects.find(e => e.kind === 'ball');
  if (ball && !(gizmo.dragging && selected.includes(meshOf(ball.uid)))) meshOf(ball.uid).position.copy(toThree(ballStart(doc)));
  if (!live) for (const e of doc.objects) if (e.kind === 'checkpoint') fitGhosts(meshOf(e.uid), e);
  if (changed || !live) { labelTargets = null; filter(); }
  if (!gizmo.dragging) { selected = selected.filter(o => meshes.get(o.userData.uid) === o); showSelection(); }
}
export function restyle() {                       // surfaces read again, or newly known
  if (!docSig.value) return;
  for (const [, o] of meshes) if (o.userData.e) dress(o, o.userData.e, o.userData.e);
  for (const t of tiles.values()) t.mesh.material = terrainLook(docSig.value.terrain.surface);
}
// What the view shows, and how many: deleted-from-view (eye), huge objects, the find box, zones and markers
export function filter() {
  const q = ui.filter.value.trim().toLowerCase(), view = ui.view.value, off = eyeOff.value;
  let shown = 0;
  for (const o of meshes.values()) {
    const e = o.userData.e;
    if (o.userData.huge === undefined) {
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
      const ground = size.y < Math.max(1000, 0.12 * Math.max(size.x, size.z));   // floors and rolling hills stay in view; domes, walls, mountains go
      o.userData.huge = e.kind !== 'lava' && !ground && o.geometry.boundingSphere.radius * Math.max(o.scale.x, o.scale.y, o.scale.z) > 15000;
    }
    o.visible = !off.has(e.uid) && (view.huge || !o.userData.huge)
      && (!q || `${e.name} ${e.cls} ${e.mesh || ''} ${e.id}`.toLowerCase().includes(q))
      && (e.kind === 'ball' || !isVolume(e) || (e.kind === 'checkpoint' || e.kind === 'lava' || isZone(e) ? view.checkpoints : view.volumes))
      && (view.markers || !!e.bounds || e.kind === 'spawn' || e.kind === 'ball');
    shown += o.visible;
  }
  ui.count.value = meshes.size ? `${shown} of ${meshes.size} objects shown` : '';
}
export const isHuge = uid => !!meshOf(uid)?.userData.huge;
// a newly opened map: its meshes' geometry read (map.js shapes), everything else drawn afresh
export function openMap(doc) {
  for (const o of meshes.values()) group.remove(o);
  meshes.clear();
  for (const t of tiles.values()) { group.remove(t.mesh); t.mesh.geometry.dispose(); }
  tiles.clear();
  meshGeos.clear();
  forgetSurfaces();
  selected = [];
  gizmo.detach();
  sync(doc);
}
export function loadMeshes(doc) {                 // after the map shows: the real shapes of its meshes
  const ids = [...new Set(doc.objects.map(e => e.meshIndex).filter(i => i !== null && i !== undefined))];
  for (const [i, s] of shapes(ed.pkg, ids)) meshGeos.set(i, { geo: cornerGeometry(s.corners, s.uvs, s.groups), groups: s.groups });
  for (const o of meshes.values()) {
    const e = o.userData.e, m = e.meshIndex !== null && !(e.kind === 'shape' && e.i === null) && meshGeos.get(e.meshIndex);
    if (!m) continue;
    o.geometry = m.geo;
    o.userData.huge = undefined;
    dress(o, e, e);
  }
  attach();
  sync(doc);
  fitGrid(Math.max(50000, ...[...meshes.values()].filter(o => o.visible && o.userData.e.bounds)
    .flatMap(o => { const b = boxOf(o); return [b.min.x, b.max.x, b.min.z, b.max.z].map(Math.abs); })));
}

// Terrain tiles: drawn from the document's heights, refreshed when a tile's heights are another array, or mid-stroke
const tiles = new Map();                          // "tx,ty" -> {heights, mesh}
function syncTiles(terrain) {
  const { tile: n, cell } = ed.map;
  for (const [key, heights] of terrain.tiles) {
    let t = tiles.get(key);
    if (!t) {
      const [tx, ty] = key.split(',').map(Number), pos = new Float32Array(3 * (n + 1) ** 2), index = [];
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const v = j * (n + 1) + i;
        pos[3 * v] = (tx * n + i) * cell;
        pos[3 * v + 2] = (ty * n + j) * cell;
      }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        index.push(a, d, b, a, c, d);             // Unreal's winding, which the Y/Z swap turns into Three's front faces
      }
      const g = new THREE.BufferGeometry();
      g.setIndex(index);
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(pos.filter((_, k) => k % 3 !== 1).map(v => v / 500), 2));   // as saved: a repeat every 500 units
      t = { heights: null, base: null, mesh: new THREE.Mesh(g, terrainLook(terrain.surface)) };
      tiles.set(key, t);
      group.add(t.mesh);
    }
    if (t.heights !== heights || t.base !== terrain.base) { t.heights = heights; t.base = terrain.base; refreshTile(t); }
    t.mesh.material = terrainLook(terrain.surface);
  }
  for (const [key, t] of tiles) if (!terrain.tiles.has(key)) { group.remove(t.mesh); t.mesh.geometry.dispose(); tiles.delete(key); }
}
function refreshTile(t) {
  const pos = t.mesh.geometry.attributes.position;
  t.heights.forEach((h, v) => pos.setY(v, (t.base ?? 0) + h));
  pos.needsUpdate = true;
  t.mesh.geometry.computeBoundingSphere();
  t.mesh.geometry.computeBoundingBox();
}
export function strokeTiles(terrain, keys) {      // tiles a stroke changed in place
  syncTiles(terrain);
  for (const key of keys) refreshTile(tiles.get(key));
}

// What is under a point
const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
const solids = () => [...meshes.values()].filter(o => isSolid(o.userData.e));
export function groundHit(at, depth) {            // the first solid surface within `depth` below `at`, as a raycast hit
  scene.updateMatrixWorld();
  return new THREE.Raycaster(toThree(at), new THREE.Vector3(0, -1, 0), 0, depth)
    .intersectObjects([...solids(), ...[...tiles.values()].map(t => t.mesh)], false)[0];
}
export const groundUnder = (at, depth) => groundHit(at, depth)?.point.y ?? null;   // its height, or null
export const hitUid = hit => hit?.object.userData.uid ?? null;   // null: terrain
export function floorHit(at) {                    // what stands under `at` (the spawn), as a raycast hit (or undefined)
  scene.updateMatrixWorld();
  ray.set(toThree(at), new THREE.Vector3(0, -1, 0));
  return ray.intersectObjects(solids(), false)[0];
}
// Where a reset at checkpoint `e` puts the car: past a gate, and down on the ground when the zone reaches some.
// The marker transform for that spot, or null when it is the zone's own pivot (a box in the air).
export function respawnValues(e) {
  const forward = ueAxes(e.rot)[0], past = isGate(e) ? GATE_PAST : 0;
  const at = e.loc.map((v, k) => v + forward[k] * past);
  const ground = groundUnder(at, e.bounds[5] * Math.abs(e.scale3d[2] * e.scale) + 100);
  if (ground === null && !past) return null;
  if (ground !== null) at[2] = ground + RESPAWN_CLEARANCE;
  return { loc: at, rot: [...e.rot], scale3d: [0.1, 0.1, 0.1] };
}
export const meshBox = uid => { const b = boxOf(meshOf(uid)); return { min: fromThree(b.min), max: fromThree(b.max) }; };   // in map axes
function setPointer(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
}
let downAt = null, stroking = false, brushPoint = null, brushOn = false;
renderer.domElement.addEventListener('pointerdown', ev => {
  downAt = [ev.clientX, ev.clientY];
  if (!brushOn || ev.button !== 0 || ev.altKey) return;
  setPointer(ev);
  brushPoint = brushHit();
  if (!brushPoint) return;
  orbit.enabled = false;                          // capture phase: OrbitControls sees the press disabled
  stroking = true;
  hooks.strokeStart(brushPoint.clone(), ev.shiftKey);
}, true);
renderer.domElement.addEventListener('pointermove', ev => {
  if (!brushOn) return;
  setPointer(ev);
  brushPoint = brushHit();
  showBrush();
});
renderer.domElement.addEventListener('pointerleave', () => { if (!stroking) brushRing.visible = false; });
window.addEventListener('pointerup', () => {
  if (!stroking) return;
  stroking = false;
  orbit.enabled = true;
  roadLine.visible = false;
  hooks.strokeEnd(brushPoint?.clone() ?? null);
});
renderer.domElement.addEventListener('pointerup', ev => {
  if (brushOn || !downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4 || gizmo.dragging) return;
  setPointer(ev);
  ray.setFromCamera(pointer, camera);
  const hits = ray.intersectObjects([...meshes.values()].filter(o => o.visible), false);
  // the nearest shape or checkpoint; other zones (lava over the whole floor, huge volumes) only when nothing else is there
  const clickable = o => { const e = o.userData.e; return !isVolume(e) || e.kind === 'checkpoint' || isZone(e); };
  const hit = hits.find(h => clickable(h.object)) || hits[0];
  hooks.pick(hit ? hit.object.userData.uid : null, ev.shiftKey || ev.metaKey || ev.ctrlKey);
});

// The terrain brush: a ring where it paints, a line where a road goes
const brushRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffd24a, side: THREE.DoubleSide, depthTest: false, transparent: true }));
brushRing.renderOrder = 10;
brushRing.visible = false;
scene.add(brushRing);
const roadLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd24a, depthTest: false, transparent: true }));
roadLine.renderOrder = 10;
roadLine.frustumCulled = false;
roadLine.visible = false;
scene.add(roadLine);
export function setBrush(on) { brushOn = on; brushRing.visible = false; }
function brushHit() {
  const terrain = docSig.value.terrain;
  ray.setFromCamera(pointer, camera);
  const hit = ray.intersectObjects([...tiles.values()].map(t => t.mesh), false)[0];
  return hit ? hit.point : ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -((terrain.base ?? 0) + ed.map.sink)), new THREE.Vector3());
}
export function showBrush() {
  brushRing.visible = brushOn && !!brushPoint;
  if (!brushPoint) return;
  brushRing.position.copy(brushPoint).setY(brushPoint.y + 5);
  brushRing.scale.setScalar(ui.brushSize.value);
}
export function showRoad(path) {
  roadLine.geometry.setFromPoints(path.map(q => q.clone().setY(q.y + 10)));
  roadLine.visible = true;
}
export function brushAgain() {                    // the ground moved under the brush: it rides on it
  brushPoint = brushHit() || brushPoint;
  showBrush();
}

// Selected lights show their reach, their cone, or the way a sun shines; moving shapes the spots they visit
const guideMat = new THREE.MeshBasicMaterial({ color: 0xffd24a, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false });
const lightGuide = /** @type {any} */ (new THREE.Group()), motionGuide = /** @type {any} */ (new THREE.Group());
scene.add(lightGuide, motionGuide);
function showLightGuide(o) {
  for (const c of lightGuide.children) c.dispose ? c.dispose() : c.geometry.dispose();
  lightGuide.clear();
  const l = o?.userData.e.light;
  if (!l) return;
  lightGuide.position.copy(o.position);
  lightGuide.quaternion.copy(o.quaternion);
  if (l.kind === 'point') lightGuide.add(new THREE.Mesh(new THREE.SphereGeometry(l.radius, 24, 12), guideMat));
  if (l.kind === 'spot') {                        // apex at the light, opening along its local +X (Unreal's forward)
    const h = l.radius, cone = new THREE.ConeGeometry(h * Math.tan(l.outer * Math.PI / 180), h, 24, 1, true).translate(0, -h / 2, 0).rotateZ(Math.PI / 2);
    lightGuide.add(new THREE.Mesh(cone, guideMat));
  }
  if (l.kind === 'sun') lightGuide.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1500, 0xffd24a, 300, 150));
}
function showMotionGuide(o) {                     // the spots a slide or path visits, as ghosts joined by a line
  for (const c of motionGuide.children) if (c.isLine) c.geometry.dispose();
  motionGuide.clear();
  const m = o?.userData.e.motion;
  if (!m || !['slide', 'path'].includes(m.kind)) return;
  const spots = [[0, 0, 0], ...(m.kind === 'slide' ? [m.to] : m.points)].map(v => o.position.clone().add(toThree(v)));
  for (const p of spots.slice(1)) {
    const ghost = new THREE.Mesh(o.geometry, ghostMat);
    ghost.position.copy(p); ghost.quaternion.copy(o.quaternion); ghost.scale.copy(o.scale);
    motionGuide.add(ghost);
  }
  const route = m.back === 'start' ? [...spots, spots[0]] : spots;
  motionGuide.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(route), new THREE.LineBasicMaterial({ color: 0xffd24a })));
}

// Moving shapes play in the view from the start, as if every trigger fired at once, with the script preview's clips
let motionStart = performance.now(), lastPose = performance.now();
export const restartMotion = () => { motionStart = performance.now(); };
export const moverBox = e => scaledBox(e.bounds, [e.scale3d[0] * e.scale, e.scale3d[1] * e.scale, e.scale3d[2] * e.scale]);
function poseMovers() {                           // moves them for one frame; returns how to put them back
  const now = performance.now(), dt = Math.min((now - lastPose) / 1000, 0.1), time = (now - motionStart) / 1000, posed = [], p = ed.preview;
  lastPose = now;
  p?.advance(dt);
  for (const o of meshes.values()) {
    const e = o.userData.e, m = e.motion, clips = p?.clips.filter(c => c.target === e.id && c.started) ?? [], hide = p?.hidden.has(e.id);
    if ((!m && !clips.length && !hide) || !o.visible) continue;
    posed.push([o, o.position.clone(), o.quaternion.clone()]);
    const poses = clips.map(c => keysAt(c.keys, c.t));
    if (m) {
      const { keys, length } = motionKeys(m, e.rot, moverBox(e));
      poses.unshift(keysAt(keys, Math.max(0, time - m.delay) % (m.once ? length + 1.5 : length)));   // one that runs once replays after a breather
    }
    for (const { pos, rot } of poses) {
      o.position.add(toThree(pos).applyQuaternion(o.quaternion));
      o.quaternion.multiply(ueToQuat(eulerRotator(rot)));
    }
    if (hide) o.visible = false;
  }
  return posed;
}
// Point and spot lights also light the view: the ones nearest to where you look, as many as the view has lights for
const previewPoints = Array.from({ length: 12 }, () => { const p = new THREE.PointLight(0xffffff, 0, 1, 0); scene.add(p); return p; });
const previewSpots = Array.from({ length: 4 }, () => { const s = new THREE.SpotLight(0xffffff, 0, 1, 0.5, 0, 0); scene.add(s, s.target); return s; });
function syncLightPreview() {                     // a fixed set of view lights, so materials never recompile
  const t = orbit.target, p = ed.preview, list = [...meshes.values()].filter(o => o.userData.e.light);
  const near = kind => list.filter(o => o.userData.e.light.kind === kind && (p?.lights.get(o.userData.e.id) ?? o.userData.e.light.on))
    .sort((x, y) => x.position.distanceToSquared(t) - y.position.distanceToSquared(t));
  const fill = (pool, found, aim) => pool.forEach((pl, k) => {
    const o = found[k], l = o?.userData.e.light;
    pl.intensity = l ? l.brightness : 0;
    if (!l) return;
    pl.position.copy(o.position);
    pl.color.setRGB(...l.color.map(v => v / 255), THREE.SRGBColorSpace);
    pl.distance = l.radius;
    aim?.(pl, o, l);
  });
  fill(previewPoints, near('point'));
  fill(previewSpots, near('spot'), (pl, o, l) => {
    pl.angle = Math.min(l.outer, 89) * Math.PI / 180;
    pl.penumbra = l.outer > 0 ? Math.min(1, Math.max(0, 1 - l.inner / l.outer)) : 0;
    pl.target.position.copy(o.position).add(new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion));
    pl.target.updateMatrixWorld();
  });
}

// Object ids over the view (View > Object ids), as AI agents refer to them, and a scale bar
let labelTargets = null;                          // [mesh, id] to label; recounted when the map changes
const labelEls = new Map(), labels = document.getElementById('labels');
export const listedForAI = (e, floor) => e !== floor && !single(e) && (e.kind === 'checkpoint' || e.kind === 'lava' || e.kind === 'light' || isZone(e) || (isSolid(e) && !isHuge(e.uid)));
function drawLabels() {
  labels.hidden = !ui.view.value.ids;
  if (labels.hidden) return;
  const { clientWidth: w, clientHeight: h } = el, seen = new Set(), doc = docSig.value, floor = floorOf(doc);
  labelTargets ??= doc.objects.filter(e => e.kind !== 'lava' && (listedForAI(e, floor) || single(e)))
    .map(e => [meshOf(e.uid), e.kind === 'spawn' ? 'spawn' : e.kind === 'ball' ? 'ball' : e.id]);
  for (const [o, id] of labelTargets) {
    if (!o) continue;
    const b = boxOf(o), p = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2).project(camera);
    if (!labelEls.has(o)) labelEls.set(o, labels.appendChild(Object.assign(document.createElement('span'), {
      className: 'absolute left-0 top-0 whitespace-nowrap rounded bg-base-300/80 px-1.5 font-mono text-[11px] leading-snug' })));
    const tag = labelEls.get(o);
    if (tag.textContent !== id) tag.textContent = id;
    tag.hidden = !o.visible || p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1;
    tag.style.transform = `translate(${(p.x + 1) / 2 * w}px, ${(1 - p.y) / 2 * h}px) translate(-50%, -100%)`;
    seen.add(o);
  }
  for (const [o, tag] of labelEls) if (!seen.has(o)) { tag.remove(); labelEls.delete(o); }
  const across = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const px = (orbit.target.clone().addScaledVector(across, 1000).project(camera).x - orbit.target.clone().project(camera).x) / 2 * w;
  const len = [100, 200, 500, 1000, 2000, 5000, 10000, 20000].find(l => l * px / 1000 >= 60) ?? 50000;
  document.getElementById('scaleBar').style.width = `${len * px / 1000}px`;
  document.getElementById('scaleText').textContent = `${len} units`;
}
export const relabel = () => { labelTargets = null; };
