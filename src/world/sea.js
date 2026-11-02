import * as THREE from 'three';
import { SKY_GLSL } from '../render/sky.js';
import { WAVES_GLSL } from './waves.js';
import { clamp } from '../core/util.js';

/** The sea mesh moves with the camera in steps of one grid cell, so its vertices never swim. */
export const SEA_CELL = 12.5;

const TRAIL_POINTS = 32;   // wake history length (one point every 0.5 s)
const MAX_BERGS = 9;       // icebergs that tint the water around them

/**
 * The sea: a 4 km grid displaced by the swell, shaded with wind chop from the ocean slope map,
 * sky and mirror reflections, cloud shadows, sun glitter, the yacht's foam and wake, and a teal glow
 * around submerged ice.
 */
export function createSea(shared) {
  const uniforms = {
    ...shared,
    tReflect: { value: null },                       // mirror pass (yacht and ice), set by the post pipeline
    uTexMat: { value: new THREE.Matrix4() },         // world -> mirror texture coordinates
    uBoatPos: { value: new THREE.Vector2() },
    uBoatDir: { value: new THREE.Vector2(1, 0) },
    uBoatSpeed: { value: 0 },                        // 0..1
    uTrail: { value: Array.from({ length: TRAIL_POINTS }, () => new THREE.Vector4(1e5, 1e5, -1e3, 0)) },   // x, z, time, speed
    uBergs: { value: Array.from({ length: MAX_BERGS }, () => new THREE.Vector4(1e5, 1e5, 1, 1)) }          // x, z, radius x, radius z
  };

  const geometry = new THREE.PlaneGeometry(4000, 4000, 320, 320);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.ShaderMaterial({
    uniforms, fog: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorld; varying vec3 vNormal;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 xz = wp.xz;
        float att = 1.0 - smoothstep(150.0, 600.0, length(xz - cameraPosition.xz));   // swell fades out far away
        vec3 t = vec3(1.0, 0.0, 0.0); vec3 b = vec3(0.0, 0.0, 1.0); vec3 disp = vec3(0.0);
        ${WAVES_GLSL}
        wp.xyz += disp;
        vNormal = normalize(cross(b, t));
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: SKY_GLSL + /* glsl */ `
      uniform sampler2D tReflect; uniform mat4 uTexMat; uniform sampler2D tNoise;
      uniform vec2 uBoatPos; uniform vec2 uBoatDir; uniform vec4 uBergs[${MAX_BERGS}];
      uniform float uBoatSpeed; uniform vec4 uTrail[${TRAIL_POINTS}];
      varying vec3 vWorld; varying vec3 vNormal;

      vec2 slopeAt(vec2 uv){ return (texture2D(tNoise, uv).rg - 0.5) * 2.0; }

      void main(){
        vec3 n = normalize(vNormal);
        vec2 q = vWorld.xz;
        float dist = length(q - cameraPosition.xz);
        float near = 1.0 - smoothstep(25.0, 220.0, dist);
        float mid = 1.0 - smoothstep(80.0, 700.0, dist);

        // --- Wind chop: three drifting layers of the slope map. Tiling is broken up by a gentle large-scale
        //     warp, non-repeating scale ratios, and roughness patches (cat's paws) moving with the wind
        vec2 warp = (vec2(texture2D(tNoise, q * 0.0021 + vec2(0.13, 0.71)).b, texture2D(tNoise, q * 0.0021 + vec2(0.57, 0.29)).b) - 0.5) * 6.0;
        vec2 qw = q + warp;
        float gust = smoothstep(0.25, 0.75, texture2D(tNoise, q * 0.0045 - uTime * vec2(0.0018, 0.012)).b);
        vec2 s1 = slopeAt(mat2(0.96, 0.28, -0.28, 0.96) * qw / 23.7 + uTime * vec2(0.010, 0.007));
        vec2 s2 = slopeAt(mat2(0.8, -0.6, 0.6, 0.8) * (q - warp * 0.61) / 8.9 - uTime * vec2(0.018, -0.010));
        vec2 s3 = slopeAt(mat2(0.28, 0.96, -0.96, 0.28) * (q + warp * 0.37) / 3.3 + uTime * vec2(-0.03, 0.022));

        // --- Wake: distance to the stern's recent path; fresh foam fades fast, a smoother slick lingers
        float wake = 0.0, slick = 0.0;
        if (length(q - uBoatPos) < 200.0) {
          for (int i = 0; i < ${TRAIL_POINTS - 1}; i++) {
            vec4 p0 = uTrail[i], p1 = uTrail[i + 1];
            vec2 ab = p1.xy - p0.xy;
            float L2 = dot(ab, ab);
            float h = L2 > 1e-4 ? clamp(dot(q - p0.xy, ab) / L2, 0.0, 1.0) : 0.0;
            float age = max(uTime - mix(p0.z, p1.z, h), 0.0);
            float dw = length(q - (p0.xy + ab * h)) / (0.9 + age * 0.3);
            float k = exp(-dw * dw) * mix(p0.w, p1.w, h) * (1.0 - smoothstep(11.0, 15.0, age));
            wake = max(wake, k * exp(-age * 0.45));
            slick = max(slick, k * exp(-age * 0.12));
          }
        }

        vec2 sl = (s1 * 0.6 + s2 * 0.4 * mid + s3 * 0.3 * near) * 0.14 * (0.35 + 0.65 * mid) * mix(0.75, 1.15, gust);
        sl *= 1.0 - 0.55 * slick;
        n = normalize(n + vec3(-sl.x, 0.0, -sl.y));

        // --- Reflection: Fresnel blend of the dark water body with the sky (slightly blurred so the chop
        //     reads as wavelets, brightness soft-limited) and the mirror image of the yacht and ice
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 r = reflect(-v, n); r.y = abs(r.y);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        vec3 ta = normalize(cross(r, vec3(0.0, 1.0, 0.0)) + 1e-4);
        vec3 tb = cross(r, ta);
        vec3 rs = (skyBase(r) * 2.0 + skyBase(normalize(r + ta * 0.035)) + skyBase(normalize(r - ta * 0.035))
                 + skyBase(normalize(r + tb * 0.035)) + skyBase(normalize(r - tb * 0.035))) / 6.0;
        rs = horizonDetail(r, rs);
        rs *= 1.0 / (1.0 + 0.45 * max(dot(rs, vec3(0.2126, 0.7152, 0.0722)) - 0.5, 0.0));
        rs += sunDisk(r);
        vec4 rp = uTexMat * vec4(vWorld.x, 0.0, vWorld.z, 1.0);
        vec4 obj = texture2D(tReflect, rp.xy / rp.w + n.xz * 0.035);
        vec3 refl = mix(rs, obj.rgb, obj.a);
        // --- Drifting cloud shadows (also dim the light scattered inside the water)
        float cs = texture2D(tNoise, q * 0.0011 + uTime * vec2(0.0016, 0.0009)).b * 0.6 + texture2D(tNoise, q * 0.0027 - uTime * vec2(0.001, 0.0021)).b * 0.4;
        float lit = smoothstep(0.35, 0.65, cs);

        // --- Water body: a faint dark teal, a little brighter on wave faces tilted toward the light,
        //     so the near sea shows its wave structure even where it reflects little. Teal glow near ice.
        vec3 toLight = normalize(vec3(uSun.x, 1.0, uSun.z));
        float facing = clamp((dot(n, toLight) - toLight.y) * 6.0 + 0.5, 0.0, 1.0);
        float ice = 0.0;
        for (int i = 0; i < ${MAX_BERGS}; i++) { ice += 1.0 - smoothstep(0.7, 1.6, length((q - uBergs[i].xy) / uBergs[i].zw)); }
        vec3 deep = vec3(0.005, 0.012, 0.015) + vec3(0.004, 0.014, 0.016) * facing * mix(0.6, 1.0, lit)
                  + vec3(0.004, 0.03, 0.034) * min(ice, 1.0);
        vec3 col = mix(deep, refl, fres);

        // --- Cloud shadows on the surface; the sun glitters only where light breaks through
        col *= mix(1.0, mix(0.72, 1.06, lit), 1.0 - smoothstep(600.0, 1800.0, dist));
        float glitter = mix(1.0, smoothstep(0.45, 0.8, texture2D(tNoise, q * 0.9 + uTime * vec2(0.21, -0.17)).b), near * 0.5);
        col += vec3(1.0, 0.97, 0.92) * pow(max(dot(r, uSun), 0.0), 1500.0) * glitter * 5.0 * mix(0.15, 1.0, lit);

        // --- Foam in the yacht's frame: hull line, wake, stern wave arms, bow cushion and bow wave
        vec2 lp = q - uBoatPos;
        float along = dot(lp, uBoatDir), side = dot(lp, vec2(-uBoatDir.y, uBoatDir.x));
        float hullD = length(vec2((along - 0.5) / 6.2, side / 2.05)) - 1.0;
        float foam = (1.0 - smoothstep(0.0, 0.3, hullD)) * step(-0.05, hullD) + wake * 0.5;
        float behind = -(along + 5.5);
        if (behind > 0.0) {
          float ar = (abs(side) - behind * 0.354) / (0.4 + behind * 0.03);
          foam += exp(-ar * ar) * (1.0 - smoothstep(5.0, 35.0, behind)) * 0.3 * uBoatSpeed;
        }
        float aftOfStem = 6.3 - along;
        if (aftOfStem > -0.5) {
          float ab = max(aftOfStem, 0.0);
          float cushion = (1.0 - smoothstep(0.0, 0.45 + 0.35 * uBoatSpeed, hullD)) * step(-0.05, hullD) * smoothstep(-2.0, 3.5, along);
          float bc = (abs(side) - ab * 0.42 - 0.35) / (0.3 + ab * 0.05);
          foam += (cushion * 0.9 + exp(-bc * bc) * (1.0 - smoothstep(2.0, 18.0, ab)) * 0.55) * uBoatSpeed;
        }
        foam *= smoothstep(0.35, 0.75, texture2D(tNoise, q * 0.22 + uTime * vec2(0.01, 0.015)).b + texture2D(tNoise, q * 0.9 - uTime * 0.03).b * 0.5 - 0.25);
        col = mix(col, vec3(0.34, 0.35, 0.36), clamp(foam, 0.0, 1.0) * 0.85);

        // --- Fade into the horizon haze
        vec3 hd = normalize(vec3(vWorld.x - cameraPosition.x + 0.0001, 0.0, vWorld.z - cameraPosition.z));
        col = mix(col, skyHorizon(hd), smoothstep(700.0, 2000.0, dist));
        gl_FragColor = vec4(col, 1.0);
      }`
  });

  return { mesh: new THREE.Mesh(geometry, material), uniforms };
}

/** Low sea mist: five translucent drifting slices that follow the camera and glow toward the sun. */
export function createMist(shared) {
  return [0.8, 2.2, 4.2, 7.0, 11.0].map((height, i) => {
    const geometry = new THREE.PlaneGeometry(5000, 5000);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uSun: shared.uSun, tNoise: shared.tNoise, uLayer: { value: i } },
      transparent: true, depthWrite: false, fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uSun; uniform sampler2D tNoise; uniform float uLayer;
        varying vec3 vWorld;
        void main(){
          vec3 toP = vWorld - cameraPosition;
          float dist = length(toP.xz);
          vec2 uv = vWorld.xz * 0.0032 + vec2(uTime * 0.0035, uTime * 0.0012) + uLayer * 0.37;
          float n = texture2D(tNoise, uv).b * 0.65 + texture2D(tNoise, uv * 2.9 - vec2(uTime * 0.005, 0.0)).b * 0.35;
          float graz = 1.0 - abs(normalize(toP).y);       // only visible at grazing angles, like real haze
          float a = smoothstep(0.3, 0.75, n) * 0.25 * graz * graz * smoothstep(20.0, 140.0, dist)
                  * (1.0 - smoothstep(1800.0, 2400.0, dist)) * (1.0 - uLayer * 0.14);
          float sa = pow(max(dot(normalize(toP.xz + vec2(1e-4, 0.0)), normalize(uSun.xz)), 0.0), 6.0);
          gl_FragColor = vec4(vec3(0.12, 0.13, 0.15) * (1.0 + sa * 2.2), a * 0.28);
        }`
    }));
    mesh.position.y = height;
    mesh.renderOrder = 2;
    return mesh;
  });
}

/**
 * Feeds the yacht's position, heading, speed and recent stern path to the sea shader
 * (foam and wake). Call once per frame.
 */
export function createWakeTracker(seaUniforms) {
  const trail = [];       // [x, z, time, speed], newest first
  let timer = 0;
  return function updateWake(boat, dt, t) {
    seaUniforms.uBoatPos.value.set(boat.x, boat.z);
    seaUniforms.uBoatDir.value.set(Math.cos(boat.psi), -Math.sin(boat.psi));
    const sternX = boat.x - Math.cos(boat.psi) * 5.0, sternZ = boat.z + Math.sin(boat.psi) * 5.0;
    const speed = clamp(boat.u / 7, 0, 1);
    timer -= dt;
    if (timer <= 0) {
      trail.unshift([sternX, sternZ, t, speed]);
      if (trail.length > TRAIL_POINTS - 1) trail.pop();
      timer = 0.5;
    }
    const points = seaUniforms.uTrail.value;
    points[0].set(sternX, sternZ, t, speed);
    trail.forEach((p, i) => points[i + 1].set(p[0], p[1], p[2], p[3]));
    seaUniforms.uBoatSpeed.value = speed;
  };
}
