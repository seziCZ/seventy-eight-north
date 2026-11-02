import * as THREE from 'three';

/** Direction toward the sun. It matches the bright cloud gap in the sky photo, about 12.6° above the horizon. */
export const SUN = new THREE.Vector3(0.97587, 0.21835, 0.00225).normalize();

const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;

/**
 * Sky model, shared by the sky dome, the environment map and the water reflections.
 *
 * skyBase()       the photographed sky (an equirectangular upper hemisphere). The JPEG stores
 *                 enc = (x / (1 + x))^(1/2.2), which this decodes back to HDR brightness, then grades
 *                 (more contrast, less colour, a gentle horizon gradient, faint stratus streaks).
 * horizonDetail() distant coastal ranges and a thin luminous horizon line.
 * skyColor()      both of the above.
 * skyHorizon()    the sky just above the horizon, without detail (for fading the far sea).
 * sunDisk()       the crisp sun and its tight halo.
 *
 * The expensive procedural parts never change, so they are baked once into two small textures
 * (see createSkyBaker): tStreaks (stratus streaks by azimuth and elevation) and tHorizon
 * (per azimuth: coastline heights, slope lighting, and the sky colour at the horizon).
 *
 * Expects uniforms: uSun, uTime, tSky, tStreaks, tHorizon.
 */
export const SKY_GLSL = NOISE_GLSL + /* glsl */ `
  uniform vec3 uSun; uniform float uTime; uniform sampler2D tSky; uniform sampler2D tStreaks; uniform sampler2D tHorizon;

  vec3 skyBase(vec3 d){
    float th = atan(d.z, d.x);
    float u = th * 0.15915494 + 0.5;
    float v = asin(clamp(d.y, 0.0, 1.0)) * 0.63661977;
    vec3 c = pow(texture2D(tSky, vec2(u, v)).rgb, vec3(2.2));
    vec3 x = c / max(1.0 - c, 0.004);
    // Mood grade: steeper contrast around the median, then drain some colour
    float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
    x *= min(pow(l / 0.45, 1.7) * 0.45, 80.0) / max(l, 1e-4);
    x = mix(vec3(dot(x, vec3(0.2126, 0.7152, 0.0722))), x, 0.65);
    // Low haze band: a little brighter toward the sun, a little deeper away from it
    float hb = 1.0 - smoothstep(0.0, 0.12, d.y);
    float sAz = pow(max(dot(normalize(d.xz + vec2(1e-4, 0.0)), normalize(uSun.xz)), 0.0), 4.0);
    x *= 1.0 + hb * hb * (0.22 * sAz - 0.12);
    // Faint horizontal stratus streaks (baked), so the low band reads as distant layered cloud
    float st = texture2D(tStreaks, vec2(u, clamp(d.y / 0.1, 0.0, 1.0))).r;
    x *= 1.0 + (1.0 - smoothstep(0.0, 0.1, d.y)) * (st - 0.5) * 0.35;
    return x * 0.24;
  }

  // One coastline layer: rock and snow mixed into the haze, anti-aliased against the sky above
  vec3 coastLayer(vec3 col, vec3 hz, float h, float lit, float haze, float th, float y){
    if (h <= 0.0005 || y >= h) return col;
    float snow = smoothstep(0.45, 0.75, y / h + (noise(vec2(th * 300.0, y * 900.0)) - 0.5) * 0.25);
    vec3 m = mix(mix(hz * (0.3 + 0.15 * lit), hz * (0.7 + 0.8 * lit), snow), hz, haze);
    return mix(m, col, smoothstep(h - 0.0007, h, y));
  }

  // Svalbard-like coast in three hazy layers (far to near), plus a thin luminous line at the horizon
  vec3 horizonDetail(vec3 d, vec3 col){
    if (d.y > 0.06) return col;
    float th = atan(d.z, d.x);
    float u = th * 0.15915494 + 0.5;
    vec4 heights = texture2D(tHorizon, vec2(u, 0.5 / 3.0));
    vec4 lit = texture2D(tHorizon, vec2(u, 1.5 / 3.0));
    vec3 hz = texture2D(tHorizon, vec2(u, 2.5 / 3.0)).rgb;
    float sDot = dot(normalize(d.xz + vec2(1e-4, 0.0)), normalize(uSun.xz));
    col += hz * exp(-max(d.y, 0.0) / 0.0025) * (0.15 + 1.2 * pow(max(sDot, 0.0), 3.0)) * 0.8;
    col = coastLayer(col, hz, heights.x, lit.x, 0.72, th, d.y);
    col = coastLayer(col, hz, heights.y, lit.y, 0.51, th, d.y);
    col = coastLayer(col, hz, heights.z, lit.z, 0.30, th, d.y);
    return col;
  }

  vec3 skyColor(vec3 d){ return horizonDetail(d, skyBase(d)); }
  vec3 skyHorizon(vec3 d){ return skyBase(normalize(vec3(d.x, 0.004, d.z))); }

  vec3 sunDisk(vec3 d){
    float c = dot(d, uSun);
    float disk = smoothstep(0.99982, 0.99988, c);
    float halo = pow(max(c, 0.0), 2000.0) * 0.6 + pow(max(c, 0.0), 300.0) * 0.15;
    return vec3(1.0, 0.98, 0.95) * (disk * 40.0 + halo * 4.0);
  }
`;

/**
 * Haze, shared by the sea shader and the built-in materials (ice, island, yacht). Its colour is the sky
 * at the horizon in the view direction (the baked row of tHorizon), lifted a little so the horizon reads
 * as a pale line. It thins with height, so berg tops stay a little clearer than their waterlines.
 */
export const HAZE_DENSITY = 0.0024;   // per metre at sea level
export const HAZE_GLSL = /* glsl */ `
  vec3 hazeColor(sampler2D horizon, vec3 dir){
    return texture2D(horizon, vec2(atan(dir.z, dir.x) * 0.15915494 + 0.5, 2.5 / 3.0)).rgb * 1.3 + vec3(0.003, 0.004, 0.005);
  }
  float hazeAmount(float dist, float height){
    return 1.0 - exp(-dist * ${HAZE_DENSITY.toFixed(5)} * mix(0.45, 1.0, exp(-max(height, 0.0) / 30.0)));
  }
`;

/**
 * Replaces the standard fog with the haze on every built-in material under `root`. Call before the first
 * render. scene.fog must still be set: it switches the fog shader chunks on, but its colour and range are unused.
 */
export function addHaze(root, tHorizon) {
  const patch = shader => {
    shader.uniforms.tHazeHorizon = tHorizon;
    shader.vertexShader = shader.vertexShader
      .replace('#include <fog_pars_vertex>', `#include <fog_pars_vertex>
        varying vec3 vHazeDir;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        vHazeDir = mvPosition.xyz * mat3(viewMatrix);   // camera-to-vertex offset in world space`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>
        uniform sampler2D tHazeHorizon; varying vec3 vHazeDir;
        ${HAZE_GLSL}`)
      .replace('#include <fog_fragment>', `
        float hDist = length(vHazeDir);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor(tHazeHorizon, vHazeDir / max(hDist, 1e-3)),
                               hazeAmount(hDist, cameraPosition.y + vHazeDir.y));`);
  };
  root.traverse(o => {
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
      if (!m || m.isShaderMaterial || !m.fog || m.userData.hazed) return;
      m.userData.hazed = true;   // materials are shared between meshes: patch each one once
      const own = m.onBeforeCompile;   // keep a material's own patch (the ice has one)
      m.onBeforeCompile = (shader, renderer) => { own.call(m, shader, renderer); patch(shader); };
    });
  });
}

/**
 * Sky dome material. `below` = 1 fades the lower hemisphere to dark water, which is what the
 * environment map needs; the visible dome uses 0 (the sea covers it anyway).
 */
function createSkyMaterial(shared, below) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uBelow: { value: below } },
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: SKY_GLSL + /* glsl */ `
      uniform float uBelow; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        vec3 col;
        if (d.y < 0.0) {
          vec3 hz = skyHorizon(d);
          col = mix(hz, hz * 0.22 + vec3(0.003, 0.007, 0.011), uBelow * smoothstep(0.0, 0.12, -d.y));
        } else {
          col = skyColor(d) + sunDisk(d);
        }
        gl_FragColor = vec4(col, 1.0);
      }`
  });
}

/** The visible sky dome (follows the camera) and a separate scene used to bake the environment map. */
export function createSky(shared) {
  const geometry = new THREE.SphereGeometry(5000, 48, 24);
  const dome = new THREE.Mesh(geometry, createSkyMaterial(shared, 0));
  dome.renderOrder = -1;
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(geometry, createSkyMaterial(shared, 1)));
  return { dome, envScene };
}

/**
 * Bakes the static procedural parts of the sky into textures, so the sky and sea shaders only
 * sample them instead of evaluating ~50 noise functions per pixel.
 *   bakeStreaks()  once at startup
 *   bakeHorizon()  after the sky photo has loaded (it samples the photo for the horizon colour)
 */
export function createSkyBaker(renderer, shared, type) {
  const target = (w, h) => new THREE.WebGLRenderTarget(w, h, {
    type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false
  });
  const streaks = target(4096, 256);   // u: azimuth, v: elevation 0..0.1 rad
  const horizon = target(4096, 3);     // rows: coastline heights, slope lighting, horizon sky colour
  shared.tStreaks.value = streaks.texture;
  shared.tHorizon.value = horizon.texture;

  const VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bake = (material, rt) => {
    quad.material = material;
    renderer.setRenderTarget(rt);
    renderer.render(bakeScene, bakeCam);
    renderer.setRenderTarget(null);
  };

  const streakMat = new THREE.ShaderMaterial({
    vertexShader: VS, depthTest: false, depthWrite: false,
    fragmentShader: NOISE_GLSL + /* glsl */ `
      varying vec2 vUv;
      void main(){
        float th = (vUv.x - 0.5) * 6.2831853, y = vUv.y * 0.1;
        vec2 cc = vec2(cos(th), sin(th)) * 40.0;
        float st = noise(cc + vec2(y * 700.0, 0.0)) * 0.65 + noise(cc * 2.3 + vec2(0.0, y * 1500.0)) * 0.35;
        gl_FragColor = vec4(st, 0.0, 0.0, 1.0);
      }`
  });

  const horizonMat = new THREE.ShaderMaterial({
    uniforms: { uSun: shared.uSun, uTime: shared.uTime, tSky: shared.tSky, tStreaks: shared.tStreaks },
    vertexShader: VS, depthTest: false, depthWrite: false,
    fragmentShader: SKY_GLSL + /* glsl */ `
      varying vec2 vUv;
      float ridged(vec2 p){
        float v = 0.0, a = 0.55;
        for (int i = 0; i < 4; i++) { float n = 1.0 - abs(noise(p) * 2.0 - 1.0); v += a * n * n; p = p * 2.1 + vec2(1.7, 9.2); a *= 0.45; }
        return v;
      }
      // Height (radians above the horizon) of one coastal range at azimuth th; ranges appear in segments
      float rangeH(float th, float R, float seed, float base, float amp){
        vec2 c = vec2(cos(th), sin(th));
        return smoothstep(0.42, 0.62, noise(c * 1.6 + seed)) * (base + amp * ridged(c * R + seed * 3.1));
      }
      void main(){
        float th = (vUv.x - 0.5) * 6.2831853;
        float row = floor(vUv.y * 3.0);
        float sDot = dot(vec2(cos(th), sin(th)), normalize(uSun.xz));
        float clearSun = 1.0 - smoothstep(0.88, 0.97, sDot);            // keep the sky around the sun open
        float sunSide = sign(atan(uSun.z, uSun.x) - th + 1e-5);
        vec4 heights = vec4(0.0), lit = vec4(0.0);
        for (int k = 0; k < 3; k++) {
          float fk = float(k);
          float R = 5.0 + fk * 2.0, seed = 1.3 + fk * 3.4, base = 0.004 - fk * 0.002, amp = 0.03 - fk * 0.008;
          float h = rangeH(th, R, seed, base, amp) * clearSun;
          float dh = rangeH(th + 0.002, R, seed, base, amp) - rangeH(th - 0.002, R, seed, base, amp);
          float l = clamp(0.5 - dh * sunSide * 120.0, 0.0, 1.0);     // brighter on slopes facing the sun
          if (k == 0) { heights.x = h; lit.x = l; } else if (k == 1) { heights.y = h; lit.y = l; } else { heights.z = h; lit.z = l; }
        }
        vec3 hz = skyBase(normalize(vec3(cos(th), 0.002, sin(th))));
        gl_FragColor = row < 0.5 ? heights : row < 1.5 ? lit : vec4(hz, 1.0);
      }`
  });

  return {
    bakeStreaks() { bake(streakMat, streaks); },
    bakeHorizon() { bake(horizonMat, horizon); }
  };
}
