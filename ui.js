// The editor's panels: Preact components (htm, no build step) over `ui`, a store of signals. What they show is
// computed from the document (panels.js, main.js); mountUI(act) hands the components the actions their clicks call.
import { h, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';

export const SNAP_STEPS = [10, 25, 50, 100, 250, 500];
const MAC = /Mac|iPhone|iPad/.test(navigator.platform), MOD = MAC ? '⌘' : 'Ctrl+', SHIFT_MOD = MAC ? '⇧⌘' : 'Ctrl+Shift+';
export const ui = {
  mode: signal('translate'),                     // the gizmo's tool
  sculpting: signal(false), canSculpt: signal(true),
  snap: signal(false), snapStep: signal(50),
  view: signal({ checkpoints: true, volumes: false, markers: true, huge: false, ids: false, playMotion: true, gameTextures: false }),
  helpOpen: signal(false),
  status: signal({ text: '', kind: '' }),
  slot: signal(null),                            // what Load into game last put in the game, as a line
  ask: signal(null),                             // {text, ok, answer(yes or the text typed), input?: its first text} while the dialog is up
  tab: signal('map'),                            // the left panel: 'map' or 'add'
  filter: signal(''), reveal: signal(null), count: signal(''),
  paletteFilter: signal(''), picked: signal(null),
  brushTool: signal('raise'), brushSize: signal(1200), brushStrength: signal(30),
  scriptOpen: signal(false),
  loading: signal(null),                         // the message over the view while a map opens; null: none
  // Computed elsewhere: modes (the tools the selection allows; null: all), mapName, mapTitle, dirty; the Map list
  // and the Add palette as trees of folds {key, text, open, children (only when open)} and rows (outline rows {uid,
  // text, title, sel, top, eye: {some, every} hidden in the view}, palette rows {value, text, title, top}); surfaces
  // [{value, text, group?}] and terrain {options, value, locked}; inspect (null with nothing selected, {many, kinds}
  // for several, else panels.js inspect()) and mapProps; scriptSource, scriptStatus {text, error}, scriptEvents [{label, event}].
};

// The Lucide icons the panels use (lucide.dev, ISC licence): a path's data, or [element, attributes]
const ICONS = {"BookOpen":["M12 5v16","M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"],"ChevronDown":["m6 9 6 6 6-6"],"CircleHelp":[["circle",{"cx":"12","cy":"12","r":"10"}],"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3","M12 17h.01"],"CodeXml":["m18 16 4-4-4-4","m6 8-4 4 4 4","m14.5 4-5 16"],"EllipsisVertical":[["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"12","cy":"5","r":"1"}],["circle",{"cx":"12","cy":"19","r":"1"}]],"Eye":["M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",["circle",{"cx":"12","cy":"12","r":"3"}]],"EyeOff":["M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49","M14.084 14.158a3 3 0 0 1-4.242-4.242","M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143","m2 2 20 20"],"FilePlus":["M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z","M14 2v5a1 1 0 0 0 1 1h5","M9 15h6","M12 18v-6"],"FolderOpen":["m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"],"Gamepad2":[["line",{"x1":"6","x2":"10","y1":"11","y2":"11"}],["line",{"x1":"8","x2":"8","y1":"9","y2":"13"}],["line",{"x1":"15","x2":"15.01","y1":"12","y2":"12"}],["line",{"x1":"18","x2":"18.01","y1":"10","y2":"10"}],"M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"],"Mountain":["m8 3 4 8 5-5 5 15H2L8 3z"],"Redo2":["m15 14 5-5-5-5","M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"],"Save":["M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z","M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7","M7 3v4a1 1 0 0 0 1 1h7"],"Search":["m21 21-4.34-4.34",["circle",{"cx":"11","cy":"11","r":"8"}]],"Undo2":["M9 14 4 9l5-5","M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"],"Move":["M12 2v20","m15 19-3 3-3-3","m19 9 3 3-3 3","M2 12h20","m5 9-3 3 3 3","m9 5 3-3 3 3"],"Rotate3d":["m15.194 13.707 3.814 1.86-1.86 3.814","M16.47214 7.52786 A 5 10 0 1 0 13 21.79796","M21.79796 11 A 10 5 0 1 0 19 15.57071"],"Scaling":["M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7","M14 15H9v-5","M16 3h5v5","M21 3 9 15"]};
export const Icon = ({ name, class: c = 'size-4' }) => h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: c }, ICONS[name].map(p => typeof p === 'string' ? h('path', { d: p }) : h(p[0], p[1])));

const face = text => html`<button><span>${text}</span></button>`;   // a <select>'s closed face; unlike Chrome's own, it can end a long value in …
const menu = 'dropdown-content z-30 mt-1 p-1.5 flex flex-col gap-0.5 bg-base-200 border border-white/10 rounded-box shadow-xl';
const VIEW = [
  ['checkpoints', 'Checkpoints, lava and trigger zones'], ['volumes', 'Other trigger zones'], ['markers', 'Objects without a shape'],
  ['huge', 'Huge objects (sky, barriers)'], ['ids', 'Object ids', 'Labels that AI agents building the map refer to'],
  ['playMotion', 'Play moving shapes', 'Moving shapes move in the view as they will in the game'],
  ['gameTextures', 'Game textures', "Textures and colours of the game's own surfaces, read from the game folder (TAGame/CookedPCConsole)"],
];
const SNAP_TITLE = `Dragging lines edges up with the grid and with shapes nearby, sizes in grid steps, turns 15° at a time; hold ${MAC ? '⌘' : 'Ctrl'} while dragging to snap the other way (G)`;

function Toolbar({ act }) {
  const modes = ui.modes.value, view = ui.view.value;
  const tool = (mode, icon, title) => html`<button class="btn btn-sm btn-square join-item ${!ui.sculpting.value && ui.mode.value === mode ? 'active' : ''}"
    disabled=${modes !== null && !modes.includes(mode)} title=${title} onClick=${() => act.setMode(mode)}><${Icon} name=${icon}/></button>`;
  return html`
    <div class="flex items-center gap-1 min-w-0">
      <div class="flex items-center gap-2 pl-1 pr-2"><img src="icon.svg" alt="" class="size-7 shrink-0"/><span class="text-sm font-semibold tracking-tight whitespace-nowrap max-[1360px]:hidden">RL Map Editor</span></div>
      <button class="btn btn-sm btn-ghost btn-square" title="New map: flat grass, the car and the ball" onClick=${act.newMap}><${Icon} name="FilePlus"/></button>
      <button class="btn btn-sm btn-ghost btn-square" title=${`Open a Rocket League workshop map (.udk), a map piece (.json), a 3D model (.glb, .gltf, .obj, .stl) or a picture, or drop one on the view. Nothing leaves this computer. (${MOD}O)`} onClick=${act.open}><${Icon} name="FolderOpen"/></button>
      <button class="btn btn-sm btn-ghost btn-square" title=${`Undo (${MOD}Z)`} onClick=${act.undo}><${Icon} name="Undo2"/></button>
      <button class="btn btn-sm btn-ghost btn-square" title=${`Redo (${SHIFT_MOD}Z)`} onClick=${act.redo}><${Icon} name="Redo2"/></button>
      <span class="mx-1.5 h-5 w-px shrink-0 bg-base-300"></span>
      <div class="join shrink-0" role="toolbar" aria-label="Tools">
        ${tool('translate', 'Move', 'Move (1)')}${tool('rotate', 'Rotate3d', 'Rotate (2)')}${tool('scale', 'Scaling', 'Scale (3)')}
        <button class="btn btn-sm btn-square join-item ${ui.sculpting.value ? 'active' : ''}" disabled=${!ui.canSculpt.value} title="Sculpt the ground: hills, mountains and roads (T)" onClick=${act.toggleSculpt}><${Icon} name="Mountain"/></button>
      </div>
      <label class="ml-2 flex shrink-0 cursor-pointer items-center gap-1.5 text-base-content/70" title=${SNAP_TITLE}>
        <input type="checkbox" class="toggle toggle-xs toggle-primary" checked=${ui.snap.value} onChange=${e => act.setSnap(e.currentTarget.checked)}/> Snap</label>
      <select class="select select-xs ml-1 w-24 shrink-0" title="Grid step ([ and ])" value=${ui.snapStep.value} onChange=${e => act.setSnapStep(+e.currentTarget.value)}>${face(`${ui.snapStep.value} units`)}
        ${SNAP_STEPS.map(s => html`<option value=${s}>${s} units</option>`)}
      </select>
    </div>
    <div class="flex items-center justify-end gap-1 min-w-0">
      <details class="dropdown dropdown-end">
        <summary class="btn btn-sm btn-ghost" title="What the view shows"><${Icon} name="Eye"/><span class="max-[1200px]:hidden">View</span><${Icon} name="ChevronDown" class="size-3 opacity-60"/></summary>
        <div class="${menu} w-72">
          ${VIEW.map(([key, label, title]) => html`<label title=${title}><input type="checkbox" class="checkbox checkbox-xs" checked=${view[key]} onChange=${e => act.setView(key, e.currentTarget.checked)}/> ${label}</label>`)}
        </div>
      </details>
      <button id="scriptButton" class="btn btn-sm btn-ghost" title="Events and what they set off, in JavaScript" onClick=${act.toggleScript}><${Icon} name="CodeXml"/><span class="max-[1200px]:hidden">Script</span></button>
      <button class="btn btn-sm btn-ghost btn-square" title="Keyboard and mouse controls (?)" onClick=${() => { ui.helpOpen.value = !ui.helpOpen.value; }}><${Icon} name="CircleHelp"/></button>
      <span class="mx-1.5 h-5 w-px shrink-0 bg-base-300"></span>
      <button class="btn btn-sm" title=${`Save the map as a .udk file (${MOD}S)`} onClick=${act.save}><${Icon} name="Save"/>Save as…</button>
      <button class="btn btn-sm btn-primary" title=${`Writes the map over Free Play's Underpass (Chrome or Edge). Be on the main menu, not in Underpass. (${MOD}↵)${ui.slot.value ? `\n${ui.slot.value}` : ''}`} onClick=${act.play}><${Icon} name="Gamepad2"/>Load into game</button>
      <details class="dropdown dropdown-end">
        <summary class="btn btn-sm btn-ghost btn-square" title="More game actions"><${Icon} name="EllipsisVertical"/></summary>
        <div class="${menu} w-64">${ui.slot.value && html`<div class="px-2 py-1 text-xs text-base-content/60">${ui.slot.value}</div>`}
          <button class="btn btn-sm btn-ghost justify-start font-normal" title="Put the game's own Underpass back" onClick=${act.restore}>Restore the original Underpass</button></div>
      </details>
    </div>`;
}

const Footer = () => html`
  <div class="flex min-w-0 items-center gap-2.5">
    <div class="boot-only skeleton h-3 w-48"></div>
    <div class="boot-hide flex min-w-0 max-w-80 shrink-0 items-center gap-1.5 whitespace-nowrap">
      <span class="truncate font-medium" title=${ui.mapTitle.value}>${ui.mapName.value}</span>
      <span class="tabular-nums text-base-content/50" title="Changes since the map was opened">· ${ui.dirty.value ? `${ui.dirty.value} ${ui.dirty.value === 1 ? 'change' : 'changes'}` : 'no changes'}</span>
    </div>
    <span class="h-3.5 w-px shrink-0 bg-base-300"></span>
    <div id="status" class=${ui.status.value.kind}>${ui.status.value.text}</div>
  </div>
  <div class="flex items-center gap-1 whitespace-nowrap text-base-content/60">
    <kbd class="kbd kbd-xs">WASD</kbd> move · <kbd class="kbd kbd-xs">Q</kbd><kbd class="kbd kbd-xs">E</kbd> turn · drag to orbit · <kbd class="kbd kbd-xs">?</kbd> all controls
  </div>`;

const KEYS = [
  ['W A S D', 'Move the camera (Shift: faster)'], ['Q / E', 'Turn the camera'], ['Left-drag · Right-drag · Wheel', 'Orbit · pan · zoom'],
  ['Click', `Select · Shift-click adds or takes away · ${MOD}A all shown · F focuses · Esc deselects`], ['1 / 2 / 3', 'Move / rotate / scale the selection'],
  ['G · [ ]', `Snap on or off · grid step: edges to the grid and to shapes nearby, sizes in steps, 15° turns (${MAC ? '⌘' : 'Ctrl'} while dragging: the other way)`],
  ['T', `Sculpt the ground (Shift lowers, ${MAC ? '⌥' : 'Alt'}-drag orbits)`], [`${MOD}D · ${MAC ? '⌫' : 'Delete'}`, 'Duplicate · delete'],
  [`${MOD}C · ${MOD}V`, 'Copy · paste where you look, in this map or another'], [`${MOD}Z · ${SHIFT_MOD}Z`, 'Undo · redo'],
  [`${MOD}S · ${MOD}O`, 'Save as · open a map, piece, model or picture'], [`${MOD}↵`, 'Load into game'], ['?', 'Show or hide this'],
];
const Help = () => !ui.helpOpen.value ? null : html`
  <div class="fixed inset-0 z-30 grid place-items-center bg-black/50" onClick=${() => { ui.helpOpen.value = false; }}>
    <div class="w-[min(560px,calc(100vw-32px))] p-5 bg-base-200 border border-white/10 rounded-box shadow-2xl">
      <h2 class="text-xs uppercase tracking-wider text-base-content/60 mb-3">Controls</h2>
      <dl class="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 [&_dt]:text-primary [&_dt]:whitespace-nowrap">${KEYS.map(([k, d]) => html`<dt>${k}</dt><dd>${d}</dd>`)}</dl>
      <p class="mt-4 text-base-content/60">AI agents that can run JavaScript in this page can build maps here on their own: <code class="px-1 rounded bg-base-300 text-base-content">await mapAI.help()</code> (or <a class="link link-primary" href="ai-guide.md" target="_blank">ai-guide.md</a>) explains how.</p>
    </div>
  </div>`;

const Search = ({ value, placeholder, onInput }) => html`
  <label class="input input-sm w-full"><${Icon} name="Search" class="size-3.5 opacity-50"/>
    <input type="search" placeholder=${placeholder} value=${value} onInput=${e => onInput(e.currentTarget.value)}/></label>`;
// a fold of the tree; its toggles (the user's, or a render opening it) go to onFold
const Fold = ({ n, onFold, extra, children }) => html`
  <details open=${n.open} onToggle=${e => onFold(n.key, e.currentTarget.open)}><summary>${n.text}${extra}</summary>${children}</details>`;
const nodeKey = n => n.key !== undefined ? `k:${n.key}` : n.uid !== undefined ? `u:${n.uid}` : `v:${n.value}`;

const Eye = ({ eye, onClick }) => html`
  <button class=${eye.some ? 'eye shown' : 'eye'} title=${eye.every ? 'Show in the view' : 'Hide in the view'}
    onClick=${e => { e.preventDefault(); e.stopPropagation(); onClick(); }}><${Icon} name=${eye.every ? 'EyeOff' : 'Eye'} class="size-3.5"/></button>`;
function OutlineNode({ n, act }) {
  if (n.key === undefined) return html`<div class="item${n.top ? ' top' : ''}${n.sel ? ' sel' : ''}" data-uid=${n.uid} title=${n.title}
    onClick=${e => act.outlineRow(n.uid, e.shiftKey || e.metaKey || e.ctrlKey)}>${n.text}<${Eye} eye=${n.eye} onClick=${() => act.outlineEye({ uid: n.uid })}/></div>`;
  return html`<${Fold} n=${n} onFold=${act.foldOutline} extra=${html`<${Eye} eye=${n.eye} onClick=${() => act.outlineEye({ key: n.key })}/>`}>
    ${n.children.map(c => html`<${OutlineNode} key=${nodeKey(c)} n=${c} act=${act}/>`)}<//>`;
}
function Outline({ act }) {                      // the Map list; a revealed row scrolls into view
  const ref = useRef(null), { nodes, empty } = ui.outline.value, reveal = ui.reveal.value;
  useEffect(() => { if (reveal) ref.current.querySelector(`.item[data-uid="${reveal.uid}"]`)?.scrollIntoView({ block: 'nearest' }); }, [reveal]);
  return html`<div id="outline" ref=${ref} class="tree" role="tree" aria-label="Objects in the map">
    ${nodes.length ? nodes.map(n => html`<${OutlineNode} key=${nodeKey(n)} n=${n} act=${act}/>`) : html`<div class="empty">${empty}</div>`}</div>`;
}
function PaletteNode({ n, act }) {
  if (n.key === undefined) return html`<div class="item${n.top ? ' top' : ''}${ui.picked.value === n.value ? ' sel' : ''}" title=${n.title}
    onClick=${() => { ui.picked.value = n.value; }} onDblClick=${act.place}>${n.text}</div>`;
  return html`<${Fold} n=${n} onFold=${act.foldPalette}>${n.children.map(c => html`<${PaletteNode} key=${nodeKey(c)} n=${c} act=${act}/>`)}<//>`;
}
function LeftPanel({ act }) {                    // the Map list and the Add palette; the hidden tab stays mounted, scrolled where it was
  const tab = ui.tab.value, { nodes, empty } = ui.palette.value;
  const tabButton = (t, label, title) => html`<button role="tab" class="tab ${tab === t ? 'tab-active' : ''}" aria-selected=${tab === t} title=${title}
    onClick=${() => { ui.tab.value = t; }}>${label}</button>`;
  return html`
    <div class="tabs tabs-box tabs-sm grid grid-cols-2" role="tablist">
      ${tabButton('map', 'Map', "What's in the map")}${tabButton('add', 'Add', 'Shapes, checkpoints, lava and lights to place')}</div>
    <section class="boot-hide flex flex-col flex-1 gap-1.5 min-h-0" hidden=${tab !== 'map'}>
      <${Search} value=${ui.filter.value} placeholder="Find objects: name, kind or shape" onInput=${act.setFilter}/>
      <${Outline} act=${act}/>
      <div class="text-xs text-base-content/60">${ui.count.value}</div>
    </section>
    <section class="flex flex-col flex-1 gap-1.5 min-h-0" hidden=${tab !== 'add'}>
      <${Search} value=${ui.paletteFilter.value} placeholder="Search shapes, checkpoints and lights" onInput=${act.setPaletteFilter}/>
      <div id="palette" class="tree" role="tree" aria-label="Things to place">
        ${nodes.length ? nodes.map(n => html`<${PaletteNode} key=${nodeKey(n)} n=${n} act=${act}/>`) : html`<div class="empty">${empty}</div>`}</div>
      <div class="flex gap-1.5">
        <button class="btn btn-sm btn-primary flex-1" title="Place the picked shape or checkpoint where you're looking (or double-click it in the list)" onClick=${act.place}>Place</button>
        ${ui.picked.value?.startsWith('piece:') && html`<button class="btn btn-sm btn-ghost text-error" title="Delete this saved piece" onClick=${() => act.deletePiece(ui.picked.value)}>Delete</button>`}
      </div>
      <button class="btn btn-sm w-full" title="A 3D model (.glb or .gltf with its files, .obj with a texture picture, .stl) as a shape: it joins Your models, the car collides with its shape" onClick=${act.pickModel}>Import model…</button>
    </section>`;
}

// The Inspector: the selected object's settings, or the map's own with nothing selected. Inputs show what
// ui.inspect says and report edits through act; index.html checks and clamps what they report.
const Section = ({ title, children }) => html`<div class="section"><h3>${title}</h3>${children}</div>`;
const Check = ({ label, title, checked, disabled, onChange }) => html`
  <label class="check" title=${title}><input type="checkbox" class="checkbox checkbox-sm" checked=${checked} disabled=${disabled} onChange=${e => onChange(e.currentTarget.checked)}/> ${label}</label>`;
const NumberField = ({ label, title, value, min, max, step, placeholder, onChange }) => html`
  <label class="field" title=${title}>${label} <input type="number" class="input input-sm w-full" value=${value} min=${min} max=${max} step=${step} placeholder=${placeholder} onChange=${e => onChange(e.currentTarget.value)}/></label>`;
const SelectField = ({ label, title, value, options, onChange }) => html`
  <label class="field" title=${title}>${label} <select class="select select-sm w-full" value=${value} onChange=${e => onChange(e.currentTarget.value)}>${face(options.find(([v]) => String(v) === String(value))?.[1])}
    ${options.map(([v, text]) => html`<option value=${v}>${text}</option>`)}</select></label>`;
const Vec = ({ label, title, values, step, titles = 'XYZ', unused = [], onChange }) => html`
  <div class="vec" title=${title}><span>${label}</span>${values.map((v, k) => html`<input type="number" class="input input-sm w-full px-1.5 ${unused.includes(k) ? 'invisible' : ''}"
    step=${step} title=${titles[k]} value=${v} onChange=${e => onChange(k, e.currentTarget.value)}/>`)}</div>`;
const Join = ({ buttons }) => html`<div class="join w-full">${buttons.map(([label, title, active, onClick, disabled]) => html`
  <button class="btn btn-sm join-item flex-1 ${active ? 'active' : ''}" title=${title} disabled=${disabled} onClick=${onClick}>${label}</button>`)}</div>`;
const PICTURE = 'picture';                       // the Surface option that asks for a picture
let pickPicture = null;                           // act.pickPicture: a picture from this computer as a surface value, or null
function SurfaceSelect({ s, title = 'What it looks like in game', disabled = false, onChange }) {   // s: {value, missing}: a label for a value the list lacks
  const list = ui.surfaces.value, plain = list.filter(o => !o.group), groups = [...new Set(list.filter(o => o.group).map(o => o.group))];
  const change = e => {
    const v = e.currentTarget.value;
    if (v !== PICTURE) return onChange(v);
    e.currentTarget.value = String(s.value ?? '');   // until a picture is picked
    pickPicture().then(p => p && onChange(p));
  };
  return html`<select class="select select-sm w-full" title=${title} disabled=${disabled} value=${String(s.value ?? '')} onChange=${change}>${face(list.find(o => String(o.value) === String(s.value ?? ''))?.text ?? s.missing)}
    ${plain.map(o => html`<option value=${o.value}>${o.text}</option>`)}
    ${s.missing && html`<option value=${s.value}>${s.missing}</option>`}
    ${groups.map(g => html`<optgroup label=${g}>${list.filter(o => o.group === g).map(o => html`<option value=${o.value}>${o.text}</option>`)}</optgroup>`)}
    <option value=${PICTURE}>Your picture…</option>
  </select>`;
}

function MapProps({ act }) {
  const { lighting, hud, ground } = ui.mapProps.value;
  return html`
    <div><h2 class="m-0 text-sm font-semibold">Map</h2>
      <p class="mt-0.5 text-base-content/60">Select an object in the view or in the Map list to edit it, or place a new one from the Add tab.</p></div>
    ${ground && html`<${Section} title="Ground"><label class="field">Surface <${SurfaceSelect} s=${ground} title="What the ground looks like in game: one of the map's surfaces, or a picture of yours" onChange=${act.setGround}/></label><//>`}
    ${lighting && html`<${Section} title="Lighting"><${SelectField} label="Mood" title="The mood of the map's sun and sky lights" value=${lighting.value} options=${lighting.options} onChange=${act.setLighting}/><//>`}
    <${Section} title="On screen">
      <${Check} label="Timer" title="Counts up from the start and stops for good when the last checkpoint becomes the respawn point" checked=${hud.timer} onChange=${v => act.setHud('timer', v)}/>
      <${Check} label="Death counter" title="Counts lava touches and resets" checked=${hud.deaths} onChange=${v => act.setHud('deaths', v)}/>
    <//>`;
}

const SECONDS = { slide: ['Move time', 'Seconds from one end to the other'], path: ['Move time', 'Seconds from one spot to the next'],
  spin: ['Step time', 'Seconds a step takes (with one step, a whole turn)'], swing: ['Swing time', 'Seconds a whole swing takes, there and back'] };
function Motion({ m, act }) {
  const set = (field, v) => act.setMotion(field, v), k = m.kind;
  return html`<${Section} title="Motion">
    <${SelectField} label="Moves" title="How it moves in the game" value=${k} options=${[['', 'No'], ...Object.entries(m.kinds)]} onChange=${v => set('kind', v)}/>
    ${k === 'slide' && html`<${Vec} label="Goes by" title="Where it goes, from where it stands (units)" step="50" values=${m.to} onChange=${(i, v) => set(`to.${i}`, v)}/>`}
    ${k === 'path' && html`
      ${m.points.map((p, n) => html`<${Vec} label=${`Spot ${n + 1}`} title="A spot it visits, from where it stands (units)" step="50" values=${p} onChange=${(i, v) => set(`spot.${n}.${i}`, v)}/>`)}
      <div class="flex gap-2"><button class="btn btn-sm flex-1" title="Another spot after the last one" onClick=${act.addSpot}>Add spot</button><button class="btn btn-sm flex-1" onClick=${act.dropSpot}>Remove last</button></div>`}
    ${(k === 'slide' || k === 'path') && html`<${SelectField} label="Back" title="How it gets back to where it started" value=${m.back}
      options=${[['same', 'The same way'], ...(k === 'path' ? [['start', 'Straight to the start']] : []), ['jump', 'Jumps to the start']]} onChange=${v => set('back', v)}/>`}
    ${(k === 'spin' || k === 'swing') && html`<${SelectField} label="Axis" title="The shape's own axis it turns about" value=${m.axis}
      options=${[['yaw', 'Up (like a turntable)'], ['roll', 'Forward (like a windmill)'], ['pitch', 'Sideways (tumbling)']]} onChange=${v => set('axis', v)}/>`}
    ${k === 'spin' && html`
      <${NumberField} label="Steps" title="Turns this many times per round, waiting the pause after each" value=${m.steps} min="1" max="36" step="1" onChange=${v => set('steps', v)}/>
      <${Check} label="The other way round" checked=${m.reverse} onChange=${v => set('reverse', v)}/>`}
    ${k === 'swing' && html`
      <${NumberField} label="Angle°" title="How far it swings each way from where it hangs" value=${m.angle} min="1" max="180" step="5" onChange=${v => set('angle', v)}/>
      <${SelectField} label="Hinge" title="The point it swings about" value=${m.hinge} options=${[['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]} onChange=${v => set('hinge', v)}/>`}
    ${k && html`
      <${NumberField} label=${SECONDS[k][0]} title=${SECONDS[k][1]} value=${m.seconds} min="0.1" max="600" step="0.1" onChange=${v => set('seconds', v)}/>
      <${NumberField} label="Pause" title="Seconds it waits at each stop" value=${m.pause} min="0" max="600" step="0.1" onChange=${v => set('pause', v)}/>
      <${Check} label="Smooth starts and stops" title="Eases into and out of every stop; a swing moves like a pendulum" checked=${m.smooth} onChange=${v => set('smooth', v)}/>
      <${SelectField} label="Starts" title="What sets it going; the view plays every moving shape from the start" value=${m.trigger} options=${m.triggers} onChange=${v => set('trigger', v)}/>
      <${NumberField} label="Delay" title="Seconds after it starts before it moves" value=${m.delay} min="0" max="600" step="0.1" onChange=${v => set('delay', v)}/>
      <${Check} label="Runs once" title="Moves through its round once, instead of over and over" checked=${m.once} onChange=${v => set('once', v)}/>`}
  <//>`;
}

function Light({ l, act }) {
  const set = (field, v) => act.setLight(field, v);
  return html`<${Section} title="Light">
    <label class="field">Colour <input type="color" class="input input-sm w-full cursor-pointer px-1" value=${l.color} onInput=${e => set('color', e.currentTarget.value)}/></label>
    <${NumberField} label="Brightness" title="1 is a plain light; most maps' suns are 0.3 to 1.3" value=${l.brightness} min="0" max="100" step="0.1" onChange=${v => set('brightness', v)}/>
    ${l.radius !== null && html`<${NumberField} label="Radius" title="How far it reaches" value=${l.radius} min="10" max="100000" step="50" onChange=${v => set('radius', v)}/>`}
    ${l.outer !== null && html`
      <${NumberField} label="Cone°" title="From the middle of the cone to its edge" value=${l.outer} min="1" max="89" step="1" onChange=${v => set('outer', v)}/>
      <${NumberField} label="Core°" title="Full brightness inside this angle, fading out to the cone's edge" value=${l.inner} min="0" max="89" step="1" onChange=${v => set('inner', v)}/>`}
    <${Check} label="Casts shadows" title="Shadows from many lights can cost frame rate" checked=${l.shadows} onChange=${v => set('shadows', v)}/>
    <${Check} label="On" checked=${l.on} onChange=${v => set('on', v)}/>
  <//>`;
}

function Zone({ z, act }) {
  const lava = z.lava, ball = z.ball;
  return html`<${Section} title="Zone">
    ${z.gate !== null && html`<div class="field"><span class="text-base-content/60">Shape</span><${Join} buttons=${[
      ['Box', 'A box you drive or dribble into', !z.gate, () => act.setGate(false)], ['Gate', 'A flat gate you pass through, 20 units thick', z.gate, () => act.setGate(true)]]}/></div>`}
    ${z.panel !== null && html`<${Check} label="Visible in game" title="Adds an opaque panel the size of the checkpoint, so players see it; nothing collides with it" checked=${z.panel} onChange=${act.setPanel}/>`}
    ${z.title && html`<label class="field" title="Shown on screen for 2 seconds when this checkpoint becomes the respawn point">Title
      <input class="input input-sm w-full" maxlength="60" value=${z.title.value} disabled=${z.title.disabled} placeholder=${z.title.placeholder} onInput=${e => act.setTitle(e.currentTarget.value)}/></label>`}
    ${lava && html`
      <${Check} label="Resets on car touch" title="The car goes back to the last checkpoint when it touches the lava" checked=${lava.car} disabled=${lava.car && !lava.ball} onChange=${v => act.setLava('car', v)}/>
      <${Check} label="Resets on ball touch" title="The car goes back to the last checkpoint, with a fresh ball, when the ball touches the lava" checked=${lava.ball} disabled=${lava.ball && !lava.car} onChange=${v => act.setLava('ball', v)}/>`}
    ${z.gravity !== null && html`<${NumberField} label="Gravity" title="Units per second²: Rocket League's own is −650; less floats, more is heavy, above 0 pulls up" value=${z.gravity}
      min="-20000" max="20000" step="50" placeholder="map default" onChange=${act.setGravity}/>`}
    ${ball && html`<div class="field"><span class="leading-tight text-base-content/60">Ball after reset</span><${Join} buttons=${[
      ['In front', ball.old ?? 'The new ball appears ahead of the car, the way the checkpoint faces', !ball.onTop, () => act.setBallOnTop(false), !!ball.old],
      ['On the car', ball.old ?? "The new ball drops onto the car's roof", ball.onTop, () => act.setBallOnTop(true), !!ball.old]]}/></div>`}
  <//>`;
}

function Arrange({ act }) {                      // copies in a row, and the selection kept as a piece or a file
  const [count, setCount] = useState(5), [by, setBy] = useState([600, 0, 0]);
  return html`<${Section} title="Arrange">
    <label class="field" title="How many copies of the selection">Copies <input type="number" class="input input-sm w-full" min="1" max="200" step="1" value=${count} onChange=${e => setCount(e.currentTarget.value)}/></label>
    <${Vec} label="Apart" title="Each copy this far from the one before (units)" step="50" values=${by} onChange=${(k, v) => setBy(by.map((x, j) => j === k ? +v : x))}/>
    <div class="flex gap-2"><button class="btn btn-sm flex-1" title="Copies in a row, each the distance above from the one before" onClick=${() => act.makeArray(count, by)}>Make copies</button></div>
  <//>`;
}
const Actions = ({ act }) => html`
  <div class="actions">
    <button class="btn btn-sm flex-1" title=${`Duplicate (${MOD}D)`} onClick=${act.duplicate}>Duplicate</button>
    <button class="btn btn-sm btn-ghost flex-1 text-error" title=${`Delete (${MAC ? '⌫' : 'Delete'})`} onClick=${act.delete}>Delete</button></div>
  <div class="flex gap-1.5">
    <button class="btn btn-xs btn-ghost flex-1" title=${`Copy, to paste where you look in this map or another (${MOD}C, ${MOD}V)`} onClick=${act.copy}>Copy</button>
    <button class="btn btn-xs btn-ghost flex-1" title="Keep it under Add > Your pieces, for any map" onClick=${act.savePiece}>Save as piece</button>
    <button class="btn btn-xs btn-ghost flex-1" title="Save it as a file to share: opening or dropping it places it" onClick=${act.exportPiece}>Export…</button></div>`;
function Inspector({ act }) {
  if (ui.sculpting.value) return null;
  const s = ui.inspect.value;
  if (!s) return html`<div class="flex flex-col gap-3"><${MapProps} act=${act}/></div>`;
  if (s.many) return html`
    <div class="break-words text-base-content/60">
      <div><b class="text-sm font-semibold text-base-content">${s.many} objects</b></div>
      <div class="mt-0.5">${s.kinds}. The gizmo moves, turns and scales them together; Shift-click adds or takes one away.</div>
    </div>
    <div class="flex flex-col gap-3">${s.actions && html`<${Arrange} act=${act}/><${Actions} act=${act}/>`}</div>`;
  const { info, transform: t, zone: z } = s;
  return html`
    <div class="break-words text-base-content/60">
      <div><b class="text-sm font-semibold text-base-content">${info.title}</b>${info.note && html` <span>${info.note}</span>`}</div>
      <div class="mt-0.5">${info.text}</div>
    </div>
    <div class="flex flex-col gap-3">
      ${s.name !== null && html`<label class="field" title="What the Script and AI agents call it: letters, digits, - and _">Name
        <input class="input input-sm w-full" maxlength="40" spellcheck="false" value=${s.name} onChange=${e => act.rename(e.currentTarget.value)}/></label>`}
      ${t.loc && html`<${Section} title="Transform">
        <${Vec} label="Location" values=${t.loc} onChange=${(k, v) => act.setTransform('loc', k, v)}/>
        ${t.rot && html`<${Vec} label="Rotation°" values=${t.rot} titles=${['Pitch', 'Yaw', 'Roll']} unused=${t.yawOnly ? [0, 2] : []} onChange=${(k, v) => act.setTransform('rot', k, v)}/>`}
        ${t.scale && html`<${Vec} label="Scale" step="0.05" values=${t.scale} onChange=${(k, v) => act.setTransform('scale', k, v)}/>`}
      <//>`}
      ${(s.surface || s.parts) && html`<${Section} title="Appearance">
        ${s.surface && html`<label class="field">Surface <${SurfaceSelect} s=${s.surface} onChange=${act.setSurface}/></label>`}
        ${s.parts?.map((p, k) => html`<label class="field">Part ${k + 1} <${SurfaceSelect} s=${p} title="What this part looks like in game" onChange=${v => act.setPartSurface(k, v)}/></label>`)}
      <//>`}
      ${z && html`<${Zone} z=${z} act=${act}/>`}
      ${s.light && html`<${Light} l=${s.light} act=${act}/>`}
      ${s.motion && html`<${Motion} m=${s.motion} act=${act}/>`}
      ${s.actions && html`<${Arrange} act=${act}/><${Actions} act=${act}/>`}
    </div>`;
}

const TOOLS = [['raise', 'Raise'], ['lower', 'Lower'], ['smooth', 'Smooth'], ['flatten', 'Flatten', 'Level the ground to the height where the stroke started'],
               ['road', 'Road', 'A drivable road along your drag, flat across its width']];
function Brush({ act }) {                        // the terrain brush, while sculpting
  if (!ui.sculpting.value) return null;
  const tool = ui.brushTool.value, terrain = ui.terrain.value;
  return html`
    <h2 class="m-0 text-[11px] font-semibold uppercase tracking-wider text-base-content/60">Terrain brush</h2>
    <div class="grid grid-cols-3 gap-1">${TOOLS.map(([t, label, title]) => html`
      <button class="btn btn-sm ${tool === t ? 'active' : ''}" title=${title} onClick=${() => act.setTool(t)}>${label}</button>`)}</div>
    <label class="field">Size <input type="range" class="range range-xs range-primary w-full" min="200" max="4000" step="50" value=${ui.brushSize.value}
      onInput=${e => act.setBrushSize(+e.currentTarget.value)}/></label>
    <label class="field">Strength <input type="range" class="range range-xs range-primary w-full" min="1" max="100" value=${ui.brushStrength.value}
      onInput=${e => { ui.brushStrength.value = +e.currentTarget.value; }}/></label>
    <div class="text-base-content/60">${tool === 'road' ? 'Drag along the road. The circle is its width; it climbs evenly from where you press to where you let go'
      : 'Drag on the ground to paint · Shift: lower'} · ⌥-drag: orbit</div>
    ${terrain.options.length ? html`<label class="field">Surface <${SurfaceSelect} s=${{ value: terrain.value, missing: null }} disabled=${terrain.locked}
      title="Surface of the hills, as the Ground's until you pick one; set for good when the first hill is saved" onChange=${act.setTerrainSurface}/></label>` : null}`;
}

const SCRIPT_EXAMPLE = "const pad = zone('pad');\non(pad.enter('car'), text('Hello!', 2));";
async function scriptGuide() {                   // ai-guide.md's Scripts section, as HTML
  const [{ marked }, md] = await Promise.all([import('marked'), fetch('ai-guide.md', { cache: 'no-store' }).then(r => r.text())]);
  const from = md.indexOf('## Scripts');
  return marked.parse(md.slice(from, md.indexOf('\n## ', from)));
}
function ScriptPanel({ act }) {                  // stays mounted while closed: hidden, so #app:has(#scriptPanel:not([hidden])) lights the toolbar button
  const ref = useRef(null), open = ui.scriptOpen.value, status = ui.scriptStatus.value, [guide, setGuide] = useState(null);
  const toggleGuide = async () => setGuide(guide ? null : await scriptGuide());
  useEffect(() => { if (open) ref.current.focus(); }, [open]);
  const keys = e => {
    e.stopPropagation();                         // typing isn't a shortcut
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); act.runScript(); }
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  };
  return html`<section id="scriptPanel" class="absolute inset-x-0 bottom-0 z-[5] flex h-[45%] flex-col border-t border-base-300 bg-base-100" hidden=${!open}>
    <div class="flex items-center gap-2 px-3 py-1.5"><b>Script</b> <span class="min-w-0 ${status.error ? 'text-error' : 'text-base-content/60'}">${status.text}</span><span class="grow"></span>
      <button class="btn btn-sm btn-ghost ${guide ? 'active' : ''}" title="What a script can do" onClick=${toggleGuide}><${Icon} name="BookOpen"/>Reference</button>
      <button class="btn btn-sm btn-primary" title=${`Run the script: check it and use it from now on (${MOD}↵)`} onClick=${act.runScript}>Apply</button>
      <button class="btn btn-sm btn-square btn-ghost" title="Close" onClick=${() => { ui.scriptOpen.value = false; }}>✕</button></div>
    <div class="flex min-h-0 flex-1 gap-2 px-3 pb-3">
      <textarea ref=${ref} class="textarea h-auto flex-1 resize-none bg-base-300 font-mono text-xs leading-normal [tab-size:2]" spellcheck="false"
        placeholder=${SCRIPT_EXAMPLE} value=${ui.scriptSource.value} onInput=${e => act.setScriptSource(e.currentTarget.value)} onKeyDown=${keys}></textarea>
      <div class="flex w-56 flex-col gap-1 overflow-auto"><span class="text-xs text-base-content/60">Preview: set off an event</span>
        <button class="btn btn-sm justify-start" title="Back to the start, then the map-start events" onClick=${act.startPreview}>▶ Start over</button>
        ${ui.scriptEvents.value.map(({ label, event }) => html`
          <button class="btn btn-sm h-auto min-h-8 justify-start whitespace-normal py-1 text-left font-mono text-xs font-normal" onClick=${() => act.fireEvent(event)}>${label}</button>`)}</div>
      ${guide && html`<div class="doc w-[min(30rem,45%)]" dangerouslySetInnerHTML=${{ __html: guide }}></div>`}
    </div>
  </section>`;
}
const Loading = () => html`
  <div id="loading" class="pointer-events-none absolute inset-0 grid place-items-center text-base-content/60" hidden=${ui.loading.value === null}>${ui.loading.value}</div>`;

// confirm() as a page dialog: the desktop app's browser pane answers native dialogs with "no" without showing them
function Ask() {
  const ref = useRef(null), field = useRef(null), q = ui.ask.value;
  useEffect(() => {
    if (q && !ref.current.open) { ref.current.showModal(); field.current?.select(); }
    if (!q && ref.current.open) ref.current.close();
  }, [q]);
  const answer = yes => { q?.answer(yes && q.input !== undefined ? field.current.value : yes); ui.ask.value = null; };   // not on 'close', which the pane delivers seconds late
  return html`<dialog ref=${ref} class="modal" onCancel=${e => { e.preventDefault(); answer(false); }}>
    <div class="modal-box max-w-md p-5 bg-base-200 border border-white/10">
      <p class="mb-4">${q?.text}</p>
      ${q?.input !== undefined && html`<input ref=${field} class="input input-sm mb-4 w-full" maxlength="60" value=${q.input} onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); answer(true); } }}/>`}
      <div class="flex justify-end gap-2"><button class="btn btn-sm btn-primary" onClick=${() => answer(true)}>${q?.ok}</button><button class="btn btn-sm" onClick=${() => answer(false)}>Cancel</button></div>
    </div>
  </dialog>`;
}

// Every `title` shows as our own tooltip: sooner than the browser's, styled, its shortcut "(⌘S)" as keys. While the
// pointer is on an element its title moves to data-tip, so the browser's own doesn't show too; it comes back after.
const KEY = /^(?:[⌘⇧⌥⌃]*.|Ctrl\+.+|Delete)$/u;
function tooltips() {
  const tip = Object.assign(document.createElement('div'), { id: 'tip', popover: 'manual', role: 'tooltip' });
  document.body.append(tip);
  let current = null, timer, warmUntil = 0;
  const hide = () => {
    clearTimeout(timer);
    if (tip.matches(':popover-open')) { tip.hidePopover(); warmUntil = performance.now() + 300; }
  };
  const leave = () => {
    hide();
    if (current && !current.hasAttribute('title')) current.title = current.dataset.tip;
    delete current?.dataset.tip;
    current = null;
  };
  const show = () => {
    const [first, ...more] = current.dataset.tip.split('\n');
    const m = first.match(/^(.*?)\s*\(([^()]+)\)$/), keys = m?.[2].split(/, | and /);
    const shortcut = keys?.every(k => KEY.test(k));
    render(html`<span>${shortcut ? m[1] : first}</span>${shortcut && html`<span class="keys">${keys.map(k => html`<kbd class="kbd kbd-xs">${k}</kbd>`)}</span>`}
      ${more.map(line => html`<p>${line}</p>`)}`, tip);
    tip.showPopover();
    const r = current.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const below = r.bottom + 6 + t.height < innerHeight - 8;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2))}px`;
    tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - t.height}px`;
  };
  addEventListener('pointerover', e => {
    const el = /** @type {HTMLElement} */ (/** @type {Element} */ (e.target).closest?.('[title], [data-tip]'));
    if (el === current) return;
    leave();
    if (!el?.title) return;
    current = el;
    el.dataset.tip = el.title;
    el.removeAttribute('title');
    timer = setTimeout(show, performance.now() < warmUntil ? 0 : 450);
  });
  addEventListener('pointerout', e => { if (current && !current.contains(e.relatedTarget)) leave(); });
  for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, hide, true);
}

export function mountUI(act) {
  const at = id => document.getElementById(id);
  tooltips();
  pickPicture = act.pickPicture;
  render(html`<${Toolbar} act=${act}/>`, at('toolbar'));
  render(html`<${LeftPanel} act=${act}/>`, at('leftPanel'));
  render(html`<${Inspector} act=${act}/>`, at('selection'));
  render(html`<${Brush} act=${act}/>`, at('brush'));
  render(html`<${Loading}/>`, at('loadingMount'));
  render(html`<${ScriptPanel} act=${act}/>`, at('scriptMount'));
  render(html`<${Footer}/>`, at('footer'));
  render(html`<${Help}/><${Ask}/>`, at('overlays'));
}
