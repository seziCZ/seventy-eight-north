import * as THREE from 'three';
import { waveAt } from './waves.js';

/**
 * Light snow: dots in a 70 m box that wraps around the camera, carried by the wind.
 * All motion happens in the vertex shader; the CPU only advances the accumulated wind offset.
 * pxUniform holds the screen's projection scale (pixels per metre at 1 m), shared with other effects.
 */
export function createSnow(shared, pxUniform, count = 2600) {
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), rnd = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = Math.random(); pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = Math.random();
    rnd[i] = Math.random();
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1));

  const uniforms = {
    uTime: shared.uTime, uSun: shared.uSun, uPx: pxUniform,
    uWindOff: { value: new THREE.Vector3() },   // integrated wind drift (m)
    uFar: { value: 34 }                          // flakes fade out before this distance (kept in front of the yacht)
  };
  const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun; uniform vec3 uWindOff; uniform float uPx; uniform float uFar;
      attribute float rnd;
      varying float vAlpha; varying float vBright;
      void main(){
        vec3 box = vec3(70.0, 36.0, 70.0);
        vec3 p = position * box + uWindOff * (0.8 + rnd * 0.4)
               + vec3(sin(uTime * 0.7 + rnd * 40.0), 0.0, cos(uTime * 0.9 + rnd * 31.0)) * 0.6;
        p.y -= uTime * (0.6 + rnd * 0.5);
        vec3 lo = cameraPosition - box * 0.5;
        p = mod(p - lo, box) + lo;                                // wrap around the camera
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float d = max(-mv.z, 0.1);
        float px = uPx * (0.012 + rnd * 0.01) / d;
        gl_PointSize = clamp(px, 1.6, 3.5);
        vAlpha = smoothstep(0.8, 3.0, d) * (1.0 - smoothstep(uFar - 8.0, uFar, d)) * (0.6 + 0.4 * rnd);
        vBright = 0.9 + 1.5 * pow(max(dot(normalize(p - cameraPosition), uSun), 0.0), 6.0);   // backlit glow
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha; varying float vBright;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.55, 1.0, dot(c, c) * 4.0)) * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.85, 0.88, 0.92) * vBright, a);
      }`
  }));
  points.frustumCulled = false;
  points.renderOrder = 3;

  return {
    points,
    update(dt, windX, windZ, farDistance) {
      uniforms.uWindOff.value.x += windX * dt;
      uniforms.uWindOff.value.z += windZ * dt;
      uniforms.uFar.value = farDistance;
    }
  };
}

/**
 * Bow spray: a small pool of droplets thrown off the bow when the yacht is fast,
 * with bursts when a swell rises into the bow. Simulated on the CPU, drawn as points.
 */
export function createSpray(shared, pxUniform, count = 260) {
  const pos = new Float32Array(count * 3), vel = new Float32Array(count * 3);
  const life = new Float32Array(count).fill(2);                // normalised age; > 1 means dead
  const age = new Float32Array(count).fill(99), maxAge = new Float32Array(count).fill(1);
  let next = 0, toEmit = 0, lastBowY = 0;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('life', new THREE.BufferAttribute(life, 1));
  const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
    uniforms: { uPx: pxUniform, uSun: shared.uSun }, transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      uniform float uPx; uniform vec3 uSun;
      attribute float life;
      varying float vA; varying float vB;
      void main(){
        vec4 mv = viewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(uPx * 0.05 / max(-mv.z, 0.1), 1.5, 6.0);
        vA = life < 1.0 ? (1.0 - life) * (1.0 - life) * smoothstep(0.0, 0.08, life) : 0.0;
        vB = 0.55 + 1.6 * pow(max(dot(normalize(position - cameraPosition), uSun), 0.0), 6.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying float vB;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.2, 1.0, dot(c, c) * 4.0)) * vA * 0.75;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.82, 0.85, 0.88) * vB, a);
      }`
  }));
  points.frustumCulled = false;

  function update(dt, t, boat) {
    const fx = Math.cos(boat.psi), fz = -Math.sin(boat.psi);    // bow direction
    const sx = Math.sin(boat.psi), sz = Math.cos(boat.psi);     // starboard direction
    const bowX = boat.x + fx * 6.0, bowZ = boat.z + fz * 6.0, bowY = waveAt(bowX, bowZ, t);
    const rise = dt > 0 ? (bowY - lastBowY) / dt : 0;
    lastBowY = bowY;

    toEmit += (Math.max(0, boat.u - 3.2) * 10 + Math.max(0, rise) * Math.max(0, boat.u - 1) * 40) * dt;
    while (toEmit >= 1) {
      toEmit -= 1;
      const i = next; next = (next + 1) % count;
      const sd = Math.random() < 0.5 ? -1 : 1, back = Math.random() * 1.8, off = sd * (0.25 + 0.35 * back / 1.8);
      pos[i * 3] = bowX - fx * back + sx * off; pos[i * 3 + 1] = bowY + 0.15; pos[i * 3 + 2] = bowZ - fz * back + sz * off;
      const out = (1.2 + Math.random() * 2.2) * (0.5 + boat.u / 8), upv = (1.2 + Math.random() * 2.4) * (0.4 + boat.u / 9);
      vel[i * 3] = fx * boat.u * 0.7 + sx * sd * out; vel[i * 3 + 1] = upv; vel[i * 3 + 2] = fz * boat.u * 0.7 + sz * sd * out;
      age[i] = 0; maxAge[i] = 0.7 + Math.random() * 0.6;
    }

    const drag = Math.exp(-dt * 1.5);
    for (let i = 0; i < count; i++) {
      if (age[i] > maxAge[i]) { life[i] = 2; continue; }
      age[i] += dt;
      vel[i * 3 + 1] -= 9.8 * dt; vel[i * 3] *= drag; vel[i * 3 + 2] *= drag;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      life[i] = age[i] / maxAge[i];
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.life.needsUpdate = true;
  }

  return { points, update };
}
