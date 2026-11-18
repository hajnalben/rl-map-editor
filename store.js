// What this browser keeps for the editor. IndexedDB: the game folder (TAGame/CookedPCConsole), asked for once, the
// game's texture index, saved pieces and the shape library in one database, the map kept for a reload in another.
// Neither is opened at a set version: an upgrade waits for every editor tab still open on the old one, and until then
// nothing can be read or kept. localStorage: small settings (pref). Storage can be blocked (a private window): then
// nothing is kept and everything still works.
const DATABASES = { 'rl-map-editor': ['handles', 'shapes'], 'rl-map-editor-session': ['session'] };
const dbOpens = new Map();
function database(store) {                        // the database that holds `store`
  const name = store === 'session' ? 'rl-map-editor-session' : 'rl-map-editor';
  if (!dbOpens.has(name)) dbOpens.set(name, new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onupgradeneeded = () => {                // only when it is new
      for (const s of DATABASES[name]) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => { dbOpens.delete(name); reject(open.error); };
  }));
  return dbOpens.get(name);
}
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
// a value of `store` (value undefined), or stores one
export async function stored(store, key, value) {
  const s = (await database(store)).transaction(store, 'readwrite').objectStore(store);
  return request(value === undefined ? s.get(key) : s.put(value, key));
}
export const all = async store => request((await database(store)).transaction(store).objectStore(store).getAll());
export async function storeAll(store, entries) {  // [key, value] pairs in one transaction: all of them land, or none
  const t = (await database(store)).transaction(store, 'readwrite');
  for (const [key, value] of entries) t.objectStore(store).put(value, key);
  return new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = t.onabort = () => reject(t.error); });
}
export const remembered = (key, value) => stored('handles', key, value);

export function pref(key, fallback) {             // a setting kept as JSON under rlme.<key>
  try { const v = localStorage.getItem(`rlme.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem(`rlme.${key}`, JSON.stringify(value)); } catch { /* storage blocked */ }
}

// Scripts you ran here are trusted: this browser keeps their hashes and runs them again when a map brings one back
const hashOf = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
export async function trust(text) {
  const h = await hashOf(text);
  setPref('trustedScripts', [...pref('trustedScripts', []).filter(x => x !== h), h].slice(-500));
}
export const trusted = async text => pref('trustedScripts', []).includes(await hashOf(text));
