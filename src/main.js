// Seventy-eight north: sail a yacht through an Arctic sea.
// Entry point: creates the renderer, builds the world, wires the systems and starts the loop.
import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { loadTextures, createCloudSampler } from './render/assets.js';
import { SUN, createSky, createSkyBaker } from './render/sky.js';
import { createRenderPipeline, hdrTargetType } from './render/post.js';
import { createResolutionScaler } from './render/resolution.js';
import { createSea, createMist, createWakeTracker, SEA_CELL } from './world/sea.js';
import { createSnow, createSpray } from './world/particles.js';
import { createIce } from './world/ice.js';
import { createYacht } from './yacht/yacht.js';
import { createInput } from './sim/input.js';
import { createBoat, wind } from './sim/sailing.js';
import { createChaseCamera } from './view/chase-camera.js';
import { createHud } from './ui/hud.js';

function start() {
  // ---------------------------------------------------------------------------
  // Renderer, scene, camera
  // ---------------------------------------------------------------------------
  const canvas = document.getElementById('scene');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    document.getElementById('fallback').style.display = 'grid';
    return;
  }
  let pipeline = null;
  const resolution = createResolutionScaler(renderer, () => pipeline && pipeline.resize());   // sets the pixel ratio
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.LinearEncoding;   // the scene stays linear HDR; tone mapping and sRGB happen in post
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 1.5, 9000);   // near plane 1.5 m: see the depth note in post.js
  const fitCamera = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.fov = camera.aspect < 1 ? 62 : 48;   // wider lens on portrait phones
    camera.updateProjectionMatrix();
  };
  fitCamera();

  // ---------------------------------------------------------------------------
  // Shared uniforms (one object per uniform, so every material sees updates)
  // ---------------------------------------------------------------------------
  let skyLoaded = false;
  const textures = loadTextures(renderer, () => {
    skyLoaded = true;
    skyBaker.bakeHorizon();                    // horizon colour comes from the photo
    if (pipeline) pipeline.invalidateEnvironment();
  });
  const shared = {
    uSun: { value: SUN },
    uTime: { value: 0 },
    tSky: { value: textures.sky },
    tNoise: { value: textures.ocean },
    tStreaks: { value: null },                 // baked sky detail, filled by the sky baker
    tHorizon: { value: null }
  };
  const skyBaker = createSkyBaker(renderer, shared, hdrTargetType(renderer));
  skyBaker.bakeStreaks();
  const pxUniform = { value: 800 };                             // projection scale (px per metre at 1 m), set per frame
  const sunView = { value: new THREE.Vector3(0, 0, -1) };       // sun direction in camera space, for backlit sails

  // ---------------------------------------------------------------------------
  // World
  // ---------------------------------------------------------------------------
  const sky = createSky(shared);
  const sea = createSea(shared);
  const mist = createMist(shared);
  const snow = createSnow(shared, pxUniform);
  const spray = createSpray(shared, pxUniform);
  scene.add(sky.dome, sea.mesh, ...mist, spray.points);
  const particleScene = new THREE.Scene();   // drawn after anti-aliasing
  particleScene.add(snow.points);

  const sunLight = new THREE.DirectionalLight(new THREE.Color().setRGB(0.8, 0.85, 0.9), 0.4);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 10, far: 260 });
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.03;
  scene.add(sunLight, sunLight.target);
  scene.add(new THREE.HemisphereLight(new THREE.Color().setRGB(0.7, 0.75, 0.82), new THREE.Color().setRGB(0.1, 0.12, 0.14), 0.45));
  scene.fog = new THREE.Fog(new THREE.Color().setRGB(0.2, 0.23, 0.27), 300, 3200);

  const ice = createIce(scene, shared, sea.uniforms);
  const yacht = createYacht({ sunView, pxUniform, sunUniform: shared.uSun });
  scene.add(yacht.group);

  const cloudLitAt = createCloudSampler(textures.ocean);
  const updateWake = createWakeTracker(sea.uniforms);

  // ---------------------------------------------------------------------------
  // Systems, in run order
  // ---------------------------------------------------------------------------
  const engine = createEngine();
  const input = engine.add(createInput(canvas));
  const boat = engine.add(createBoat(input, ice.obstacles));

  // World sync: pose the yacht, rig the sails, float the ice, feed the sea shader, spray, sunlight
  engine.add({
    render(dt, t) {
      shared.uTime.value = t;
      yacht.pose(boat, dt, t);
      yacht.rig(boat, t);
      ice.update(t);
      updateWake(boat, dt, t);
      spray.update(dt, t, boat);
      sunLight.position.set(boat.x + SUN.x * 120, SUN.y * 120, boat.z + SUN.z * 120);
      sunLight.target.position.set(boat.x, 0, boat.z);
      sunLight.intensity += (0.4 * (0.35 + 0.9 * cloudLitAt(boat.x, boat.z, t)) - sunLight.intensity) * Math.min(1, dt * 2);   // cloud shadows
    }
  });

  const chase = engine.add(createChaseCamera({
    camera, canvas, boat, yacht, engine,
    onMoved(p) {   // keep the sky, sea grid and mist centred on the camera
      sky.dome.position.copy(p);
      sea.mesh.position.set(Math.round(p.x / SEA_CELL) * SEA_CELL, 0, Math.round(p.z / SEA_CELL) * SEA_CELL);
      mist.forEach(m => { m.position.x = p.x; m.position.z = p.z; });
    }
  }));

  pipeline = createRenderPipeline({
    renderer, scene, camera, particleScene,
    envScene: sky.envScene,
    mirrorHidden: [sky.dome, sea.mesh, ...mist],
    seaUniforms: sea.uniforms,
    lookPt: chase.lookPt,
    sunView, pxUniform
  });
  if (skyLoaded) pipeline.invalidateEnvironment();
  engine.add({
    render(dt, t) {
      const W = wind.speed(t);
      snow.update(dt, wind.dirX * W, wind.dirZ * W, Math.min(34, chase.dist - 4));   // keep flakes in front of the yacht
      pipeline.render(t);
    }
  });

  engine.add(createHud(boat, input));
  engine.add(resolution);

  window.addEventListener('resize', () => {
    fitCamera();
    renderer.setSize(window.innerWidth, window.innerHeight);
    pipeline.resize();
  });

  engine.start();
}

start();
