// Small math helpers shared across modules.

/** Hermite smoothstep, same as GLSL's smoothstep(a, b, x). */
export const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const deg = (radians) => radians * 180 / Math.PI;

/** Deterministic Park–Miller generator, so the ice field is identical on every load. */
export function seededRandom(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// 3D value noise (used to sculpt the icebergs)
// ---------------------------------------------------------------------------

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function valueNoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    lerp(lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w);
}

/** Fractal sum of value noise: `octaves` layers, each at roughly double frequency and half amplitude. */
export function fbm3(x, y, z, octaves) {
  let sum = 0, amp = 0.5;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(x, y, z);
    x *= 2.03; y *= 2.03; z *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
