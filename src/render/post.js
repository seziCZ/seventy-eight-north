import * as THREE from 'three';
import { SUN } from './sky.js';
import { smooth } from '../core/util.js';

/** Half-float render targets when the GPU can render to them, 8-bit otherwise. */
export function hdrTargetType(renderer) {
  const gl = renderer.getContext();
  const canHalf = renderer.capabilities.isWebGL2 && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  return canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;
}

/**
 * Frame rendering, in order:
 *   1. Mirror pass: the scene from a camera mirrored below the sea, clipped at the waterline (half resolution)
 *   2. Main pass into an HDR target, with a sub-pixel camera jitter (no MSAA: TAA covers anti-aliasing)
 *   3. Temporal anti-aliasing: blend with the reprojected previous frame
 *   4. Snow on its own layer (not jittered, so moving dots aren't smeared)
 *   5. Bloom: bright pass, then a 5-level down/up blur chain
 *   6. Light shafts: bright sky above the horizon, radially blurred toward the sun
 *   7. Composite: bloom, shafts and snow, ACES tone mapping, grade, vignette, sRGB and dither
 *
 * Note: in three.js r147 these offscreen targets get a 16-bit depth buffer; the camera's 1.5 m near plane
 * keeps enough depth precision at chase distance.
 */
export function createRenderPipeline({ renderer, scene, camera, particleScene, envScene, mirrorHidden, seaUniforms, lookPt, sunView, pxUniform }) {
  // ---------------------------------------------------------------------------
  // Render targets
  // ---------------------------------------------------------------------------
  const type = hdrTargetType(renderer);
  const makeTarget = (depth) => new THREE.WebGLRenderTarget(1, 1, {
    type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: depth
  });
  const BLOOM_LEVELS = 5;
  const sceneRT = makeTarget(true), reflectRT = makeTarget(true), particlesRT = makeTarget(false);
  const bloomDown = Array.from({ length: BLOOM_LEVELS }, () => makeTarget(false));
  const bloomUp = Array.from({ length: BLOOM_LEVELS - 1 }, () => makeTarget(false));
  const raysA = makeTarget(false), raysB = makeTarget(false);
  let historyA = makeTarget(false), historyB = makeTarget(false), historyValid = false;
  seaUniforms.tReflect.value = reflectRT.texture;

  // ---------------------------------------------------------------------------
  // Mirror pass
  // ---------------------------------------------------------------------------
  const mirrorCam = new THREE.PerspectiveCamera();
  const clipBelowSea = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)];
  const toTexture = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  function renderReflection() {
    mirrorCam.copy(camera);
    mirrorCam.position.set(camera.position.x, -camera.position.y, camera.position.z);
    mirrorCam.up.set(0, 1, 0);
    mirrorCam.lookAt(lookPt.x, -lookPt.y, lookPt.z);
    mirrorCam.updateMatrixWorld();
    seaUniforms.uTexMat.value.copy(toTexture).multiply(mirrorCam.projectionMatrix).multiply(mirrorCam.matrixWorldInverse);
    mirrorHidden.forEach(o => { o.visible = false; });
    renderer.clippingPlanes = clipBelowSea;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(reflectRT);
    renderer.clear();
    renderer.render(scene, mirrorCam);
    renderer.setClearColor(0x000000, 1);
    renderer.clippingPlanes = [];
    mirrorHidden.forEach(o => { o.visible = true; });
  }

  // ---------------------------------------------------------------------------
  // Full-screen passes
  // ---------------------------------------------------------------------------
  const triangle = new THREE.BufferGeometry();
  triangle.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  triangle.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new THREE.Mesh(triangle);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene();
  postScene.add(quad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const fullscreen = (fragmentShader, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader, depthTest: false, depthWrite: false, toneMapped: false });
  const vec2 = () => ({ value: new THREE.Vector2() });
  const pass = (material, target) => { quad.material = material; renderer.setRenderTarget(target); renderer.render(postScene, postCam); };
  const texel = (rt) => new THREE.Vector2(1 / rt.width, 1 / rt.height);

  // Bloom: soft-knee bright pass (threshold 1.2) at half resolution, then dual-filter blur
  const brightMat = fullscreen(/* glsl */ `
    uniform sampler2D tInput; uniform vec2 uTexel; varying vec2 vUv;
    vec3 tap(vec2 o){ return min(texture2D(tInput, vUv + o * uTexel).rgb, vec3(48.0)); }
    void main(){
      vec3 c = (tap(vec2(-0.5, -0.5)) + tap(vec2(0.5, -0.5)) + tap(vec2(-0.5, 0.5)) + tap(vec2(0.5, 0.5))) * 0.25;
      float br = max(c.r, max(c.g, c.b));
      float soft = clamp(br - 1.2 + 0.8, 0.0, 1.6); soft = soft * soft / 3.2;
      gl_FragColor = vec4(c * max(soft, br - 1.2) / max(br, 1e-4), 1.0);
    }`, { tInput: { value: null }, uTexel: vec2() });
  const downMat = fullscreen(/* glsl */ `
    uniform sampler2D tInput; uniform vec2 uTexel; varying vec2 vUv;
    void main(){
      vec3 s = texture2D(tInput, vUv).rgb * 4.0 + texture2D(tInput, vUv - uTexel).rgb + texture2D(tInput, vUv + uTexel).rgb
             + texture2D(tInput, vUv + vec2(uTexel.x, -uTexel.y)).rgb + texture2D(tInput, vUv - vec2(uTexel.x, -uTexel.y)).rgb;
      gl_FragColor = vec4(s / 8.0, 1.0);
    }`, { tInput: { value: null }, uTexel: vec2() });
  const upMat = fullscreen(/* glsl */ `
    uniform sampler2D tInput; uniform sampler2D tBase; uniform vec2 uTexel; varying vec2 vUv;
    void main(){
      vec2 h = uTexel * 0.75;
      vec3 s = texture2D(tInput, vUv + vec2(-h.x * 2.0, 0.0)).rgb + texture2D(tInput, vUv + vec2(h.x * 2.0, 0.0)).rgb
             + texture2D(tInput, vUv + vec2(0.0, h.y * 2.0)).rgb + texture2D(tInput, vUv + vec2(0.0, -h.y * 2.0)).rgb
             + (texture2D(tInput, vUv + vec2(-h.x, h.y)).rgb + texture2D(tInput, vUv + vec2(h.x, h.y)).rgb
             + texture2D(tInput, vUv + vec2(h.x, -h.y)).rgb + texture2D(tInput, vUv + vec2(-h.x, -h.y)).rgb) * 2.0;
      gl_FragColor = vec4(s / 12.0 + texture2D(tBase, vUv).rgb, 1.0);
    }`, { tInput: { value: null }, tBase: { value: null }, uTexel: vec2() });

  // Light shafts: bright sky above the horizon, then a 40-tap radial blur toward the sun
  const raysMaskMat = fullscreen(/* glsl */ `
    uniform sampler2D tInput; uniform vec2 uTexel; uniform float uHorizon; varying vec2 vUv;
    void main(){
      vec3 c = (texture2D(tInput, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tInput, vUv + uTexel * vec2(1.0, -1.0)).rgb
              + texture2D(tInput, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tInput, vUv + uTexel * vec2(1.0, 1.0)).rgb) * 0.25;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float m = max(l - 0.9, 0.0) * 3.0 * smoothstep(uHorizon, uHorizon + 0.03, vUv.y);   // matched to the sky roll-off
      gl_FragColor = vec4(c / max(l, 1e-4) * min(m, 8.0), 1.0);
    }`, { tInput: { value: null }, uTexel: vec2(), uHorizon: { value: 0.5 } });
  const raysBlurMat = fullscreen(/* glsl */ `
    uniform sampler2D tInput; uniform vec2 uSunUV; uniform float uAspect; varying vec2 vUv;
    void main(){
      vec2 toSun = uSunUV - vUv;
      vec2 delta = -toSun * 0.7 / 40.0;
      vec2 uv = vUv - delta * 0.5;
      vec3 acc = vec3(0.0); float w = 1.0;
      for (int i = 0; i < 40; i++) { acc += texture2D(tInput, uv).rgb * w; w *= 0.962; uv -= delta; }
      float d = length(toSun * vec2(uAspect, 1.0));
      gl_FragColor = vec4(acc / 40.0 * exp(-1.3 * d), 1.0);   // fade with distance from the sun
    }`, { tInput: { value: null }, uSunUV: vec2(), uAspect: { value: 1 } });

  // Temporal anti-aliasing. History is reprojected assuming each pixel shows either the sea plane or the
  // far sky (no motion vectors), then clamped to the current 3x3 neighbourhood (in YCoCg, on tone-compressed
  // values) so moving objects don't ghost. Blending is kept gentle and a mild sharpen offsets the softening.
  const taaMat = fullscreen(/* glsl */ `
    uniform sampler2D tCur; uniform sampler2D tHist; uniform vec2 uTexel; uniform float uBlend;
    uniform mat4 uInvVP; uniform mat4 uPrevVP; uniform vec3 uCamPos;
    varying vec2 vUv;
    float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    vec3 enc(vec3 c){ return c / (1.0 + lum(c)); }
    vec3 dec(vec3 c){ return c / max(1.0 - lum(c), 1e-3); }
    vec3 toYC(vec3 c){ return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
    vec3 toRGB(vec3 y){ return vec3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z); }
    void main(){
      vec3 m1 = vec3(0.0), m2 = vec3(0.0), cur = vec3(0.0);
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec3 s = toYC(enc(texture2D(tCur, vUv + vec2(float(i), float(j)) * uTexel).rgb));
        if (i == 0 && j == 0) cur = s;
        m1 += s; m2 += s * s;
      }
      m1 /= 9.0;
      vec3 sig = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
      vec4 fp = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 dir = normalize(fp.xyz / fp.w - uCamPos);
      vec3 world = uCamPos + dir * (dir.y < -0.0005 ? min(-uCamPos.y / dir.y, 4000.0) : 4000.0);
      vec4 pc = uPrevVP * vec4(world, 1.0);
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      float valid = (pc.w > 0.0 && puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0) ? 1.0 : 0.0;
      vec3 h = clamp(toYC(enc(texture2D(tHist, puv).rgb)), m1 - sig, m1 + sig);
      cur += (cur - m1) * 0.35;
      vec3 o = max(toRGB(mix(cur, h, uBlend * valid)), vec3(0.0));
      o *= min(1.0, 0.99 / max(lum(o), 1e-4));   // the sharpen can push bright pixels past the encoding's limit
      gl_FragColor = vec4(dec(o), 1.0);
    }`, { tCur: { value: null }, tHist: { value: null }, uTexel: vec2(), uBlend: { value: 0 },
          uInvVP: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() } });

  // Composite and grade: nearly colourless, steel-blue shadows, neutral highlights, firm S-curve, soft vignette
  const compositeMat = fullscreen(/* glsl */ `
    uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tRays; uniform sampler2D tParticles;
    uniform float uRays; uniform float uAspect; uniform float uTime;
    varying vec2 vUv;
    vec3 aces(vec3 color){
      const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      vec3 v = inM * (color * 0.5 / 0.6);   // exposure 0.5
      v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
      return clamp(outM * v, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
    void main(){
      vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * 0.08 + texture2D(tRays, vUv).rgb * uRays;
      vec4 pt = texture2D(tParticles, vUv);
      c = c * (1.0 - pt.a) + pt.rgb;
      c = aces(c);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 0.22);
      c *= mix(vec3(0.88, 0.96, 1.10), vec3(0.99, 1.0, 1.01), smoothstep(0.0, 0.55, l));
      c = clamp((c - 0.002) / 0.998, 0.0, 1.0);
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.2);
      vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
      c *= mix(0.72, 1.0, 1.0 - smoothstep(0.35, 1.15, length(q)));
      c = toSRGB(clamp(c, 0.0, 1.0));
      c += (fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 61.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
      gl_FragColor = vec4(c, 1.0);
    }`, { tScene: { value: null }, tBloom: { value: null }, tRays: { value: null }, tParticles: { value: null },
          uRays: { value: 0 }, uAspect: { value: 1 }, uTime: { value: 0 } });

  // ---------------------------------------------------------------------------
  // Sizes
  // ---------------------------------------------------------------------------
  const bufSize = new THREE.Vector2();
  function resize() {
    renderer.getDrawingBufferSize(bufSize);
    const w = Math.max(1, Math.floor(bufSize.x)), h = Math.max(1, Math.floor(bufSize.y));
    const scaled = (shift) => [Math.max(1, w >> shift), Math.max(1, h >> shift)];
    sceneRT.setSize(w, h);
    reflectRT.setSize(...scaled(1));
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bloomDown[i].setSize(...scaled(i + 1));
      if (i < BLOOM_LEVELS - 1) bloomUp[i].setSize(...scaled(i + 1));
    }
    raysA.setSize(...scaled(2));
    raysB.setSize(...scaled(2));
    historyA.setSize(w, h); historyB.setSize(w, h); particlesRT.setSize(w, h);
    historyValid = false;
    compositeMat.uniforms.uAspect.value = w / h;
    raysBlurMat.uniforms.uAspect.value = w / h;
  }
  resize();

  // ---------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envDirty = false;
  const sunNdc = new THREE.Vector3(), camFwd = new THREE.Vector3(), horizonNdc = new THREE.Vector3();
  const viewProj = new THREE.Matrix4(), prevViewProj = new THREE.Matrix4();
  const HALTON = [[0.5, 0.333], [0.25, 0.667], [0.75, 0.111], [0.125, 0.444], [0.625, 0.778], [0.375, 0.222], [0.875, 0.556], [0.0625, 0.889]]
    .map(([x, y]) => [x - 0.5, y - 0.5]);
  let jitter = 0;

  /** Per-frame camera-dependent inputs: environment map, sun direction, light-shaft aim, TAA matrices and jitter. */
  function prepare(t) {
    compositeMat.uniforms.uTime.value = t;
    pxUniform.value = bufSize.y * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    if (envDirty) { scene.environment = pmrem.fromScene(envScene, 0.02, 0.1, 10000).texture; envDirty = false; }

    camera.updateMatrixWorld();
    sunView.value.copy(SUN).transformDirection(camera.matrixWorldInverse);

    // Light shafts: sun position on screen, horizon height, fade as the sun leaves the frame
    camera.getWorldDirection(camFwd);
    sunNdc.copy(SUN).multiplyScalar(4000).add(camera.position).project(camera);
    raysBlurMat.uniforms.uSunUV.value.set(sunNdc.x * 0.5 + 0.5, sunNdc.y * 0.5 + 0.5);
    horizonNdc.set(camFwd.x, 0, camFwd.z).normalize().multiplyScalar(4000).add(camera.position);
    horizonNdc.y = 0;
    horizonNdc.project(camera);
    raysMaskMat.uniforms.uHorizon.value = horizonNdc.y * 0.5 + 0.5;
    const edge = Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y));
    compositeMat.uniforms.uRays.value = camFwd.dot(SUN) > 0 ? 0.7 * (1 - smooth(0.9, 1.6, edge)) : 0;

    // TAA: unjittered matrices for reprojection, then this frame's Halton sub-pixel offset
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    taaMat.uniforms.uInvVP.value.copy(viewProj).invert();
    taaMat.uniforms.uPrevVP.value.copy(prevViewProj);
    taaMat.uniforms.uCamPos.value.copy(camera.position);
    prevViewProj.copy(viewProj);
    jitter = (jitter + 1) % HALTON.length;
    camera.setViewOffset(bufSize.x, bufSize.y, HALTON[jitter][0], HALTON[jitter][1], bufSize.x, bufSize.y);
  }

  function render(t) {
    prepare(t);
    renderer.shadowMap.needsUpdate = true;
    renderReflection();
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    // Temporal resolve into the spare history target, then swap so it becomes next frame's history
    taaMat.uniforms.tCur.value = sceneRT.texture;
    taaMat.uniforms.tHist.value = historyA.texture;
    taaMat.uniforms.uTexel.value.copy(texel(sceneRT));
    taaMat.uniforms.uBlend.value = historyValid ? 0.6 : 0;   // gentle: keeps detail crisp, still calms shimmer
    historyValid = true;
    pass(taaMat, historyB);
    const resolved = historyB;
    historyB = historyA;
    historyA = resolved;

    // Snow, unjittered
    camera.clearViewOffset();
    renderer.setRenderTarget(particlesRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(particleScene, camera);
    renderer.setClearColor(0x000000, 1);

    // Bloom
    brightMat.uniforms.tInput.value = resolved.texture;
    brightMat.uniforms.uTexel.value.copy(texel(sceneRT));
    pass(brightMat, bloomDown[0]);
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      downMat.uniforms.tInput.value = bloomDown[i - 1].texture;
      downMat.uniforms.uTexel.value.copy(texel(bloomDown[i - 1]));
      pass(downMat, bloomDown[i]);
    }
    let src = bloomDown[BLOOM_LEVELS - 1];
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      upMat.uniforms.tInput.value = src.texture;
      upMat.uniforms.tBase.value = bloomDown[i].texture;
      upMat.uniforms.uTexel.value.copy(texel(src));
      pass(upMat, bloomUp[i]);
      src = bloomUp[i];
    }

    // Light shafts (skipped when the sun is out of view)
    if (compositeMat.uniforms.uRays.value > 0.001) {
      raysMaskMat.uniforms.tInput.value = resolved.texture;
      raysMaskMat.uniforms.uTexel.value.copy(texel(sceneRT)).multiplyScalar(1.5);
      pass(raysMaskMat, raysA);
      raysBlurMat.uniforms.tInput.value = raysA.texture;
      pass(raysBlurMat, raysB);
    }

    compositeMat.uniforms.tScene.value = resolved.texture;
    compositeMat.uniforms.tBloom.value = bloomUp[0].texture;
    compositeMat.uniforms.tRays.value = raysB.texture;
    compositeMat.uniforms.tParticles.value = particlesRT.texture;
    pass(compositeMat, null);
  }

  return {
    render,
    resize,
    /** Call when the sky texture has loaded, to (re)bake the environment map. */
    invalidateEnvironment() { envDirty = true; }
  };
}
