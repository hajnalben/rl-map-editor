// Light sources: what kind a map's light is and how it is set, and writing new lights or new settings. New point and
// spot lights are the switchable kind The Path uses (PointLightToggleable, SpotLightToggleable): the game draws them
// live, so they work in maps without baked lighting, and they are set to light the car and the ball too.
import { concat, pack } from './bytes.js';

export const LIGHT_KINDS = {
  point: { name: 'Point light', actor: 'PointLightToggleable', component: 'PointLightComponent' },
  spot: { name: 'Spot light', actor: 'SpotLightToggleable', component: 'SpotLightComponent' },
  sun: { name: 'Sun', actor: 'DirectionalLight', component: 'DirectionalLightComponent' },
  sky: { name: 'Sky light', actor: 'SkyLight', component: 'SkyLightComponent' },
};
export const LIGHT_FIELDS = ['color', 'brightness', 'on', 'shadows', 'radius', 'inner', 'outer'];
const KIND_OF = { PointLightComponent: 'point', SpotLightComponent: 'spot', DirectionalLightComponent: 'sun', DominantDirectionalLightComponent: 'sun',
                  SkyLightComponent: 'sky' };

// {kind, component, color: [r, g, b], brightness, on, shadows, radius (point, spot), inner, outer (spot, degrees)}
// of the light actor `i`, with the engine's defaults for what it leaves out; null when it is no light we can read.
export function lightOf(pkg, i) {
  const ref = pkg.get(pkg.exports[i], 'LightComponent', '<i');
  if (!ref || ref[0] <= 0) return null;
  const component = ref[0] - 1, e = pkg.exports[component], kind = KIND_OF[pkg.classOf(e)];
  if (!kind) return null;
  try {
    const get = (name, fmt, missing) => pkg.get(e, name, fmt)?.[0] ?? missing;
    const bgra = pkg.get(e, 'LightColor', '<4B') ?? [255, 255, 255, 0];
    const light = { kind, component, color: [bgra[2], bgra[1], bgra[0]], alpha: bgra[3], brightness: get('Brightness', '<f', 1),
                    on: get('bEnabled', '<B', 1) !== 0, shadows: get('CastShadows', '<B', kind === 'sky' ? 0 : 1) !== 0 };
    if (kind === 'point' || kind === 'spot') light.radius = get('Radius', '<f', 1024);
    if (kind === 'spot') Object.assign(light, { inner: get('InnerConeAngle', '<f', 0), outer: get('OuterConeAngle', '<f', 44) });
    return Number.isFinite(light.brightness) && Number.isFinite(light.radius ?? 0) ? light : null;
  } catch {
    return null;                                  // a component whose properties we can't follow
  }
}

// {property: tag} for the settings in `s` (any of LIGHT_FIELDS) that a light of `kind` has
function lightTags(add, kind, s, alpha = 0) {
  const tags = {}, local = kind === 'point' || kind === 'spot';
  const float = (name, v) => { tags[name] = add.tag(name, 'FloatProperty', pack('<f', v)); };
  const bool = (name, v) => { tags[name] = add.tag(name, 'BoolProperty', Uint8Array.of(v ? 1 : 0)); };
  if ('brightness' in s) float('Brightness', s.brightness);
  if ('color' in s) tags.LightColor = add.tag('LightColor', 'StructProperty', Uint8Array.of(s.color[2], s.color[1], s.color[0], alpha), 'Color');
  if ('on' in s) bool('bEnabled', s.on);
  if ('shadows' in s) for (const name of ['CastShadows', 'CastStaticShadows', 'CastDynamicShadows']) bool(name, s.shadows);
  if (local && 'radius' in s) float('Radius', s.radius);
  if (kind === 'spot' && 'inner' in s) float('InnerConeAngle', s.inner);
  if (kind === 'spot' && 'outer' in s) float('OuterConeAngle', s.outer);
  return tags;
}

export function setLight(add, i, settings) {     // new settings for the saved light actor `i`
  const l = lightOf(add.pkg, i);
  if (!l) throw new Error(`${add.pkg.exports[i].name} is no light this editor can change`);
  add.setProps(l.component, lightTags(add, l.kind, settings, l.alpha));
}

// A new light actor of `kind` at `loc` facing `rot` (rotator units), set as `settings`; returns its export index.
export function addLight(add, kind, loc, rot, settings) {
  const K = LIGHT_KINDS[kind], props = list => concat(...list, add.fname('None'));
  const guid = name => add.tag(name, 'StructProperty', crypto.getRandomValues(new Uint8Array(16)), 'Guid');
  const lit = add.tag('LightingChannels', 'StructProperty', props(['bInitialized', 'BSP', 'Static', 'Dynamic'].map(n => add.tag(n, 'BoolProperty', Uint8Array.of(1)))),
                      'LightingChannelContainer');
  return add.addActor(K.actor, K.component, `${K.component}0`, component => [add.tag('LightComponent', 'ObjectProperty', pack('<i', component)),
    add.tag('Location', 'StructProperty', pack('<3f', ...loc), 'Vector'), add.tag('Rotation', 'StructProperty', pack('<3i', ...rot), 'Rotator'),
    add.tag('Tag', 'NameProperty', add.fname(K.actor))],
    [guid('LightGuid'), guid('LightmapGuid'), ...Object.values(lightTags(add, kind, settings)), ...(kind === 'point' || kind === 'spot' ? [lit] : [])]);
}
