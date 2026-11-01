// Little-endian binary packing in the style of Python's struct module ("<3f", "<iQiiIi", ...), plus the few
// Python number rules the map format code relies on. Q/q values are BigInts, s values Uint8Arrays.
const SIZES = { b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, q: 8, Q: 8, e: 2, f: 4, d: 8 };
const parsed = new Map();

function fields(fmt) {
  if (!parsed.has(fmt)) {
    const out = [];
    for (const [, n, c] of fmt.replace(/^</, '').matchAll(/(\d*)([a-zA-Z])/g)) {
      const k = n === '' ? 1 : +n;
      if (c === 's') out.push(['s', k]);
      else for (let j = 0; j < k; j++) out.push([c, SIZES[c]]);
    }
    parsed.set(fmt, out);
  }
  return parsed.get(fmt);
}

export const calcsize = fmt => fields(fmt).reduce((n, [, size]) => n + size, 0);
const view = buf => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

export function unpackFrom(fmt, buf, off) {
  const dv = view(buf), out = [];
  for (const [c, size] of fields(fmt)) {
    if (off + size > buf.byteLength) throw new RangeError(`unpack ${fmt} past the end at ${off}`);
    switch (c) {
      case 'b': out.push(dv.getInt8(off)); break;
      case 'B': out.push(dv.getUint8(off)); break;
      case 'h': out.push(dv.getInt16(off, true)); break;
      case 'H': out.push(dv.getUint16(off, true)); break;
      case 'i': out.push(dv.getInt32(off, true)); break;
      case 'I': out.push(dv.getUint32(off, true)); break;
      case 'q': out.push(dv.getBigInt64(off, true)); break;
      case 'Q': out.push(dv.getBigUint64(off, true)); break;
      case 'e': out.push(fromHalf(dv.getUint16(off, true))); break;
      case 'f': out.push(dv.getFloat32(off, true)); break;
      case 'd': out.push(dv.getFloat64(off, true)); break;
      case 's': out.push(buf.slice(off, off + size)); break;
    }
    off += size;
  }
  return out;
}

export function packInto(fmt, buf, off, ...values) {
  const dv = view(buf);
  fields(fmt).forEach(([c, size], k) => {
    const v = values[k];
    switch (c) {
      case 'b': dv.setInt8(off, v); break;
      case 'B': dv.setUint8(off, v); break;
      case 'h': dv.setInt16(off, v, true); break;
      case 'H': dv.setUint16(off, v, true); break;
      case 'i': dv.setInt32(off, v, true); break;
      case 'I': dv.setUint32(off, v, true); break;
      case 'q': dv.setBigInt64(off, BigInt(v), true); break;
      case 'Q': dv.setBigUint64(off, BigInt(v), true); break;
      case 'e': dv.setUint16(off, toHalf(v), true); break;
      case 'f': dv.setFloat32(off, v, true); break;
      case 'd': dv.setFloat64(off, v, true); break;
      case 's': buf.set(v.subarray(0, size), off); break;
    }
    off += size;
  });
}

export function pack(fmt, ...values) {
  const out = new Uint8Array(calcsize(fmt));
  packInto(fmt, out, 0, ...values);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export const latin1 = bytes => String.fromCharCode(...bytes);
export const utf16 = bytes => String.fromCharCode(...new Uint16Array(bytes.slice().buffer));
export const latin1Bytes = text => Uint8Array.from(text, ch => ch.charCodeAt(0));

export function pyRound(x) {                      // Python's round(): halves go to the even neighbour
  const f = Math.floor(x), d = x - f;
  return d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
}

export function pySum(values) {                   // Python's sum() of floats (3.12+): Neumaier-compensated
  let f = 0 + values[0], c = 0;
  for (let k = 1; k < values.length; k++) {
    const x = values[k], t = f + x;
    c += Math.abs(f) >= Math.abs(x) ? (f - t) + x : (x - t) + f;
    f = t;
  }
  return c && Number.isFinite(c) ? f + c : f;
}

function twoProduct(a, b) {                       // [a*b, its exact rounding error], what C's fma(a, b, -a*b) gives
  const p = a * b, split = v => { const c = 134217729 * v; const hi = c - (c - v); return [hi, v - hi]; };
  const [ah, al] = split(a), [bh, bl] = split(b);
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}

export function pyDist(p, q) {                    // Python's math.dist: CPython's vector_norm, rounded the same way
  const vec = p.map((c, k) => Math.abs(c - q[k])), max = Math.max(...vec);
  if (max === 0 || vec.length <= 1) return max;
  const scale = 2 ** -frexp(max)[1];
  let csum = 1, frac1 = 0, frac2 = 0;
  const add = (hi, lo) => {
    const s = csum + hi;
    frac2 += hi - (s - csum);
    frac1 += lo;
    csum = s;
  };
  for (const v of vec) add(...twoProduct(v * scale, v * scale));
  let h = Math.sqrt(csum - 1 + (frac1 + frac2));
  add(...twoProduct(-h, h));
  h += (csum - 1 + (frac1 + frac2)) / (2 * h);
  return h / scale;
}

function frexp(x) {                               // x = m * 2^e with 0.5 <= m < 1, for finite x > 0
  let e = Math.floor(Math.log2(x)) + 1;
  let m = x / 2 ** e;
  if (m >= 1) { m /= 2; e += 1; } else if (m < 0.5) { m *= 2; e -= 1; }
  return [m, e];
}

function toHalf(x) {                              // CPython's PyFloat_Pack2: round half to even
  const sign = x < 0 || Object.is(x, -0) ? 1 : 0;
  x = Math.abs(x);
  if (Number.isNaN(x)) return 0x7e00;
  if (x === Infinity) return sign << 15 | 0x7c00;
  if (x === 0) return sign << 15;
  let [f, e] = frexp(x);
  f *= 2; e -= 1;
  if (e >= 16) throw new RangeError('float too large for a half float');
  if (e < -25) { f = 0; e = 0; }
  else if (e < -14) { f = f * 2 ** (14 + e); e = 0; }
  else { e += 15; f -= 1; }
  f *= 1024;
  let bits = Math.floor(f);
  f -= bits;
  if (f > 0.5 || (f === 0.5 && bits % 2 === 1)) {
    bits += 1;
    if (bits === 1024) { bits = 0; e += 1; if (e === 31) throw new RangeError('float too large for a half float'); }
  }
  return sign << 15 | e << 10 | bits;
}

export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = h >> 10 & 31, f = h & 1023;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}
