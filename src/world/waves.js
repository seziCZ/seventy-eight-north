import * as THREE from 'three';

/**
 * The swell: four Gerstner waves [dirX, dirZ, steepness, wavelength in m].
 * They are evaluated identically on the GPU (to displace the sea mesh) and on the CPU
 * (so the yacht, ice and camera ride the same surface).
 */
const WAVES = [[1.0, 0.3, 0.034, 62], [0.55, 1.0, 0.027, 33], [-0.45, 0.9, 0.0225, 19], [0.95, -0.45, 0.018, 11.5]]
  .map(([x, z, s, l]) => {
    const m = Math.hypot(x, z), k = 2 * Math.PI / l;
    return { dx: x / m, dz: z / m, s, k, c: Math.sqrt(9.8 / k) };   // c: deep-water phase speed
  });

const f5 = (n) => n.toFixed(5);

/**
 * GLSL snippet that accumulates the swell. The caller declares, in scope:
 *   vec2 xz (world position), float att (amplitude factor), uniform float uTime,
 *   vec3 disp, t, b (displacement, tangent, binormal accumulators).
 */
export const WAVES_GLSL = WAVES.map(w => `
  { vec2 d = vec2(${f5(w.dx)}, ${f5(w.dz)}); float k = ${f5(w.k)}; float c = ${f5(w.c)};
    float s = ${f5(w.s)} * att; float a = s / k; float f = k * (dot(d, xz) - c * uTime);
    disp += vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
    t += vec3(-d.x * d.x * s * sin(f), d.x * s * cos(f), -d.x * d.y * s * sin(f));
    b += vec3(-d.x * d.y * s * sin(f), d.y * s * cos(f), -d.y * d.y * s * sin(f)); }`).join('');

/** Surface normal from the last waveAt() call (reused to avoid allocations). */
export const waveNormal = new THREE.Vector3();

/** Sea surface height at world (x, z) and time t; also leaves the surface normal in waveNormal. */
export function waveAt(x, z, time) {
  // Gerstner waves also move the surface sideways, so first find the undisplaced point that lands at (x, z)
  let px = x, pz = z;
  for (let it = 0; it < 3; it++) {
    let ox = 0, oz = 0;
    for (const w of WAVES) {
      const a = w.s / w.k, cf = Math.cos(w.k * (w.dx * px + w.dz * pz - w.c * time));
      ox += w.dx * a * cf; oz += w.dz * a * cf;
    }
    px = x - ox; pz = z - oz;
  }
  let y = 0, tx = 1, ty = 0, tz = 0, bx = 0, by = 0, bz = 1;
  for (const w of WAVES) {
    const s = w.s, a = s / w.k, f = w.k * (w.dx * px + w.dz * pz - w.c * time), sf = Math.sin(f), cf = Math.cos(f);
    y += a * sf;
    tx += -w.dx * w.dx * s * sf; ty += w.dx * s * cf; tz += -w.dx * w.dz * s * sf;
    bx += -w.dx * w.dz * s * sf; by += w.dz * s * cf; bz += -w.dz * w.dz * s * sf;
  }
  waveNormal.set(by * tz - bz * ty, bz * tx - bx * tz, bx * ty - by * tx).normalize();
  return y;
}
