import * as THREE from 'three';
import { SUN } from '../render/sky.js';
import { WAVES_GLSL, waveAt, waveNormal } from './waves.js';
import { smooth, seededRandom, fbm3 } from '../core/util.js';

// [azimuth offset from the sun, distance, scale x, scale y, scale z]
const BERGS = [
  [-0.95, 420, 70, 34, 50], [-0.55, 620, 95, 46, 70], [0.4, 520, 60, 28, 44],
  [1.6, 700, 110, 40, 80], [2.6, 460, 55, 30, 40], [3.7, 640, 85, 38, 60],
  [-2.4, 120, 9, 6, 7], [0.9, 95, 7, 5, 8], [2.1, 150, 12, 7, 9]
];
const FLOE_COUNT = 90;

/**
 * Ice and land: sculpted icebergs, bobbing floes, foam where they meet the sea, and a distant island.
 * Adds everything to the scene, writes berg positions into seaUniforms.uBergs (for the water's teal glow)
 * and returns the collision circles plus a per-frame update for the floes.
 */
export function createIce(scene, shared, seaUniforms) {
  const sunAz = Math.atan2(SUN.z, SUN.x);
  const obstacles = [];   // collision circles { x, z, r }
  const bergRingMat = createFoamRingMaterial(shared, true);
  const floeRingMat = createFoamRingMaterial(shared, false);

  // Icebergs
  BERGS.forEach(([ang, dist, sx, sy, sz], i) => {
    const seed = i * 3.7 + 1, a = sunAz + ang;
    const berg = createBerg(sx, sy, sz, seed, sx < 20 ? 40 : 48);
    berg.position.set(Math.cos(a) * dist, -0.05 * sy, Math.sin(a) * dist);   // local y = 0.05 sits at sea level
    berg.rotation.y = i * 1.3;
    scene.add(berg);
    scene.add(createFoamRing(traceWaterline(berg, seed, sx, sz), 1.2 + (sx + sz) * 0.01, bergRingMat));
    const r = (sx + sz) * 0.5;
    seaUniforms.uBergs.value[i].set(berg.position.x, berg.position.z, r * 1.1, r * 1.1);
    obstacles.push({ x: berg.position.x, z: berg.position.z, r: r * 0.9 });
  });

  // Floes, scattered beyond the starting area
  const rand = seededRandom(7);
  const floeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true });
  const floes = [];
  for (let i = 0; i < FLOE_COUNT; i++) {
    const r = 140 + Math.sqrt(rand()) * 180, ang = rand() * Math.PI * 2;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r, size = 1.5 + rand() * 2.4 + r / 90;
    const phase = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const floe = createFloe(size, phase, floeMat, floeRingMat);
    floe.userData = { x, z, yaw: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2) };
    floe.position.set(x, 0, z);
    scene.add(floe);
    floes.push(floe);
    obstacles.push({ x, z, r: size * 0.9 });
  }

  // Distant snow-capped island
  const island = createIsland();
  island.position.set(Math.cos(sunAz - 0.25) * 1500, -2, Math.sin(sunAz - 0.25) * 1500);
  scene.add(island);
  obstacles.push({ x: island.position.x, z: island.position.z, r: 280 });

  const up = new THREE.Vector3(0, 1, 0), tilt = new THREE.Quaternion();
  return {
    obstacles,
    /** Floes ride and tilt with the swell. */
    update(t) {
      for (const f of floes) {
        f.position.y = waveAt(f.userData.x, f.userData.z, t) - 0.12;
        tilt.setFromUnitVectors(up, waveNormal);
        f.quaternion.copy(tilt).multiply(f.userData.yaw);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Icebergs
// ---------------------------------------------------------------------------

/** Berg surface point for unit direction (dx, dy, dz): noise-displaced, flat-topped, clipped underwater. */
function bergPoint(dx, dy, dz, seed, out) {
  const n = fbm3(dx * 1.4 + seed, dy * 1.4 + seed * 0.7, dz * 1.4 - seed, 4);
  const n2 = fbm3(dx * 4.5 + seed, dy * 4.5, dz * 4.5 - seed, 3);
  const r = 0.62 + 0.55 * n + 0.1 * n2;
  let x = dx * r, y = dy * r, z = dz * r;
  const top = 0.4 + 0.1 * n2;
  if (y > top) y = top + (y - top) * 0.15;     // tabular top
  y += 0.01 * Math.sin(y * 60 + n * 8);         // erosion bands
  return out.set(x, Math.max(y, -0.35), z);
}

const bergMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 });

/**
 * A sphere displaced by bergPoint(). Normals are computed by finite differences of the shape function,
 * so they stay smooth across the sphere's UV seam. Vertex colours: dark wet waterline, blue ice, snow on top.
 */
function createBerg(sx, sy, sz, seed, segments) {
  const geometry = new THREE.SphereGeometry(1, segments * 2, segments);
  const pos = geometry.attributes.position, nrm = geometry.attributes.normal, col = new Float32Array(pos.count * 3);
  const d = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  const p0 = new THREE.Vector3(), n = new THREE.Vector3(), helper = new THREE.Vector3();
  const deep = new THREE.Color(0x1f5f70), wet = new THREE.Color(0x4f7d8c), ice = new THREE.Color(0x9cc6d6), snow = new THREE.Color(0xe9f1f5), c = new THREE.Color();
  for (let j = 0; j < pos.count; j++) {
    d.set(pos.getX(j), pos.getY(j), pos.getZ(j)).normalize();
    bergPoint(d.x, d.y, d.z, seed, p0);
    if (Math.abs(d.y) > 0.9) helper.set(1, 0, 0); else helper.set(0, 1, 0);
    t1.crossVectors(d, helper).normalize(); t2.crossVectors(d, t1);
    a.copy(d).addScaledVector(t1, 0.012).normalize(); bergPoint(a.x, a.y, a.z, seed, a);
    b.copy(d).addScaledVector(t2, 0.012).normalize(); bergPoint(b.x, b.y, b.z, seed, b);
    n.crossVectors(a.sub(p0), b.sub(p0)).normalize();
    if (n.dot(p0) < 0) n.negate();
    pos.setXYZ(j, p0.x, p0.y, p0.z);
    nrm.setXYZ(j, n.x, n.y, n.z);

    const y = p0.y;
    if (y < 0.02) c.copy(deep);
    else if (y < 0.1) c.copy(wet).lerp(ice, smooth(0.02, 0.1, y));
    else c.copy(ice).lerp(snow, Math.max(smooth(0.1, 0.38, y), smooth(0.55, 0.9, n.y)));
    const crevice = 0.82 + 0.18 * fbm3(d.x * 9 + seed, d.y * 9, d.z * 9, 2);
    col[j * 3] = c.r * crevice; col[j * 3 + 1] = c.g * crevice; col[j * 3 + 2] = c.b * crevice;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geometry, bergMaterial);
  mesh.scale.set(sx, sy, sz);
  if (sx < 20) { mesh.castShadow = true; mesh.receiveShadow = true; }
  return mesh;
}

/** World-space waterline of a berg (local y = 0.05), found by bisecting the elevation at each azimuth. */
function traceWaterline(berg, seed, sx, sz) {
  const points = [], p = new THREE.Vector3(), ry = berg.rotation.y;
  for (let k = 0; k < 96; k++) {
    const th = k / 96 * Math.PI * 2;
    let lo = -0.7, hi = 0.9;
    for (let it = 0; it < 18; it++) {
      const ph = (lo + hi) / 2;
      bergPoint(Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th), seed, p);
      if (p.y < 0.05) lo = ph; else hi = ph;
    }
    const lx = p.x * sx, lz = p.z * sz;   // scale, then rotate about y, then translate
    points.push([berg.position.x + lx * Math.cos(ry) + lz * Math.sin(ry), berg.position.z - lx * Math.sin(ry) + lz * Math.cos(ry)]);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Floes and island
// ---------------------------------------------------------------------------

/** A flat, irregular slab of ice with its own foam ring (as a child, so it bobs along). */
function createFloe(size, phase, material, ringMaterial) {
  const radius = (a) => 1 + 0.22 * Math.sin(a * 2 + phase[0]) + 0.14 * Math.sin(a * 3 + phase[1]) + 0.08 * Math.sin(a * 5 + phase[2]);
  const squash = 0.7 + 0.3 * Math.cos(phase[0]);
  const geometry = new THREE.CylinderGeometry(size, size * 1.06, 0.5, 9, 1);
  const pos = geometry.attributes.position, col = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0xf2f8fb), low = new THREE.Color(0x5fb4d0), c = new THREE.Color();
  for (let j = 0; j < pos.count; j++) {
    const px = pos.getX(j), pz = pos.getZ(j), k = radius(Math.atan2(pz, px));
    pos.setX(j, px * k); pos.setZ(j, pz * k * squash);
    c.copy(low).lerp(top, smooth(-0.25, 0.22, pos.getY(j)));
    col[j * 3] = c.r; col[j * 3 + 1] = c.g; col[j * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geometry.computeVertexNormals();
  const floe = new THREE.Mesh(geometry, material);

  const outline = [];
  for (let k = 0; k < 48; k++) {
    const a = k / 48 * Math.PI * 2, kk = radius(a);
    outline.push([Math.cos(a) * size * 1.016 * kk, Math.sin(a) * size * 1.016 * kk * squash]);
  }
  const ring = createFoamRing(outline, 0.45, ringMaterial);
  ring.position.y = 0.13;   // the floe's local waterline
  floe.add(ring);
  return floe;
}

/** A rocky, snow-capped island built from a displaced plane. */
function createIsland() {
  const geometry = new THREE.PlaneGeometry(2, 2, 110, 110);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position, col = new Float32Array(pos.count * 3);
  const rock = new THREE.Color(0x1c2024), snow = new THREE.Color(0xc9d2da), c = new THREE.Color();
  for (let j = 0; j < pos.count; j++) {
    const x = pos.getX(j), z = pos.getZ(j), r = Math.hypot(x, z * 1.6), a = Math.atan2(z, x);
    const ridge = 0.75 + 0.25 * Math.abs(Math.sin(a * 3.0 + x * 4.0)) + 0.1 * Math.sin(x * 23.0 + z * 17.0);
    let h = Math.pow(Math.max(0, 1 - r), 1.8) * ridge;
    if (h > 0) h += 0.04 * Math.sin(x * 37) * Math.cos(z * 29);
    pos.setY(j, Math.max(h, -0.05));
    c.copy(rock).lerp(snow, smooth(0.35, 0.55, h));
    col[j * 3] = c.r; col[j * 3 + 1] = c.g; col[j * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
  mesh.scale.set(320, 90, 320);
  return mesh;
}

// ---------------------------------------------------------------------------
// Foam rings where ice meets the sea
// ---------------------------------------------------------------------------

/** Foam strip material. withSwell = true rides the waves in world space (bergs); floe rings bob with their floe. */
function createFoamRingMaterial(shared, withSwell) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, tNoise: shared.tNoise },
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute float across;
      varying float vAcross; varying vec3 vWorld;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        ${withSwell ? `{ vec2 xz = wp.xz; float att = 1.0 - smoothstep(150.0, 600.0, length(xz - cameraPosition.xz));
          vec3 t = vec3(1.0, 0.0, 0.0); vec3 b = vec3(0.0, 0.0, 1.0); vec3 disp = vec3(0.0);
          ${WAVES_GLSL}
          wp.y += disp.y + 0.04; }` : ''}
        vAcross = across; vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform sampler2D tNoise;
      varying float vAcross; varying vec3 vWorld;
      void main(){
        float n = texture2D(tNoise, vWorld.xz * 0.35 + uTime * vec2(0.02, 0.015)).b * 0.6 + texture2D(tNoise, vWorld.xz * 1.1 - uTime * 0.03).b * 0.4;
        float edge = pow(1.0 - clamp(vAcross, 0.0, 1.0), 1.6);
        float a = smoothstep(0.35, 0.7, n * 0.7 + edge * 0.6) * edge;
        a *= 1.0 - smoothstep(300.0, 900.0, length(vWorld.xz - cameraPosition.xz));
        gl_FragColor = vec4(vec3(0.34, 0.35, 0.36), a * 0.85);
      }`
  });
}

/** A flat strip around a closed outline [[x, z], ...]: 0.25 m inside the edge to `width` outside. */
function createFoamRing(outline, width, material) {
  const n = outline.length, pos = [], across = [], index = [];
  let cx = 0, cz = 0;
  outline.forEach(p => { cx += p[0]; cz += p[1]; });
  cx /= n; cz /= n;
  for (let i = 0; i < n; i++) {
    const [x, z] = outline[i];
    let nx = x - cx, nz = z - cz;
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    pos.push(x - nx * 0.25, 0, z - nz * 0.25, x + nx * width, 0, z + nz * width);
    across.push(0, 1);
    const a = i * 2, b = ((i + 1) % n) * 2;
    index.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('across', new THREE.Float32BufferAttribute(across, 1));
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  return mesh;
}
