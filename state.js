// What the editor's modules share. `ed`: the open map (the file, its parsed package, the saved document and the
// facts about it) and the editor's surfaces.upk; the signals: the document as edited, the selection (uids, the last
// one in front) and the script's run.
import { signal } from '@preact/signals';
import { BUILT_IN } from './shapes.js';

export const ed = {
  file: null,                                     // the opened file's name; null for a new map
  source: null, pkg: null, base: null, map: null, // its bytes, Package, document as saved and describe() facts
  donor: null,                                    // surfaces.upk
  library: new Map(),                             // the shape library: id -> {id, name, source, geometry}
  lastSurface: null,                              // what new shapes get: the surface last picked for one
  preview: null,                                  // the script preview (script.js previewOf) while one runs
};
export const docSig = signal(null);               // the document as edited
export const settledSig = signal(null);           // the same, but only once a drag has ended: for lists
export const selSig = signal([]);
export const runSig = signal({ source: null, plan: null, error: null });   // the script last run, and what came of it
export const eyeOff = signal(new Set());          // uids hidden in the view (the saved map keeps them)
export const shapeData = key => key.startsWith('std:') ? BUILT_IN[key.slice(4)]?.() : ed.library.get(key.slice(4))?.geometry;
