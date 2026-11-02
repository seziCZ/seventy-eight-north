import * as THREE from 'three';
import { clamp } from '../core/util.js';
import { waveAt, waveNormal } from '../world/waves.js';

// Hull lines of a ~12 m sloop. u runs 0 (transom) to 1 (stem); x is forward, z is starboard.
const X0 = -5.5, LENGTH = 12;
const beam = (u) => u < 0.45 ? 1.95 - (0.45 - u) / 0.45 * 0.4 : 1.95 * Math.pow(Math.max(0, 1 - Math.pow((u - 0.45) / 0.55, 1.8)), 0.8);
const sheer = (u) => 1.05 + 0.3 * u * u;                                                   // deck-edge height
const draft = (u) => 0.15 + 0.45 * Math.pow(Math.sin(Math.PI * Math.min(u * 1.1, 1)), 0.8);  // canoe-body depth
const uAt = (x) => (x - X0) / LENGTH;
const deckAt = (x) => sheer(uAt(x));

/** Point on the hull cross-section at station u; a runs from -π/2 (port deck edge) through the keel to +π/2. */
function hullSection(u, a, out) {
  const sa = Math.abs(Math.sin(a)), ca = Math.cos(a);
  return out.set(X0 + LENGTH * u, -draft(u) * ca * ca + sheer(u) * Math.pow(sa, 6), Math.sign(a) * beam(u) * Math.pow(sa, 0.5));
}

/** Triangle indices for a (nu x nv) vertex grid. */
function gridIndex(nu, nv) {
  const idx = [];
  for (let i = 0; i < nu - 1; i++) for (let j = 0; j < nv - 1; j++) {
    const a = i * nv + j, c = a + nv;
    idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
  return idx;
}

/**
 * Builds the yacht: lofted hull, deck, coachroof, cockpit, rig, sails and lights.
 *   sunView    uniform holding the sun direction in camera space (backlit sails)
 *   pxUniform  uniform holding the projection scale (rigging line coverage)
 *   sunUniform uniform holding the world-space sun direction (rigging glint)
 * Returns { group, pose(boat, dt, t), rig(boat, t), waterlineY }.
 */
export function createYacht({ sunView, pxUniform, sunUniform }) {
  const group = new THREE.Group();
  const v = new THREE.Vector3();
  const addMesh = (geometry, material, x, y, z) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };
  const addBuffer = (positions, colors, index, material) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    const m = new THREE.Mesh(geometry, material);
    group.add(m);
    return m;
  };

  // ---------------------------------------------------------------------------
  // Hull: navy topsides, white boot stripe, dark antifouling, bright rub rail
  // ---------------------------------------------------------------------------
  const NU = 64, NA = 33;
  const navy = new THREE.Color(0x1c2735), boot = new THREE.Color(0xe6e9ec), anti = new THREE.Color(0x0e1115), rail = new THREE.Color(0xb9c0c6);
  const hullMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.15, side: THREE.DoubleSide });
  const hullPos = [], hullCol = [];
  for (let i = 0; i < NU; i++) for (let j = 0; j < NA; j++) {
    const u = i / (NU - 1);
    hullSection(u, -Math.PI / 2 + Math.PI * j / (NA - 1), v);
    hullPos.push(v.x, v.y, v.z);
    const c = v.y > sheer(u) - 0.05 ? rail : v.y > 0.12 ? navy : v.y > 0.03 ? boot : anti;
    hullCol.push(c.r, c.g, c.b);
  }
  addBuffer(hullPos, hullCol, gridIndex(NU, NA), hullMat);

  // Transom: a fan from its centre to the stern section, closed across the top
  const trPos = [X0, sheer(0) * 0.45, 0], trCol = [navy.r, navy.g, navy.b], trIdx = [];
  for (let j = 0; j < NA; j++) {
    hullSection(0, -Math.PI / 2 + Math.PI * j / (NA - 1), v);
    trPos.push(v.x, v.y, v.z);
    const c = v.y > 0.12 ? navy : anti;
    trCol.push(c.r, c.g, c.b);
    if (j > 0) trIdx.push(0, j, j + 1);
  }
  trIdx.push(0, NA, 1);
  addBuffer(trPos, trCol, trIdx, hullMat);

  // Cambered teak deck
  const deckPos = [];
  for (let i = 0; i < NU; i++) {
    const u = i / (NU - 1), B = beam(u), S = sheer(u);
    for (let j = 0; j < 11; j++) {
      const zz = -1 + j / 5;
      deckPos.push(X0 + LENGTH * u, S + 0.05 * (1 - zz * zz) * Math.min(B, 1), zz * B * 0.995);
    }
  }
  addBuffer(deckPos, null, gridIndex(NU, 11), new THREE.MeshStandardMaterial({ color: 0x7d6a53, roughness: 0.85, side: THREE.DoubleSide }));

  // ---------------------------------------------------------------------------
  // Deck structures
  // ---------------------------------------------------------------------------
  const white = new THREE.MeshPhysicalMaterial({ color: 0xe4e7ea, roughness: 0.35, clearcoat: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d1318, roughness: 0.08, metalness: 0.6, emissive: 0xffc77e, emissiveIntensity: 0.9 });
  const canvasMat = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9, side: THREE.DoubleSide });
  const metal = new THREE.MeshStandardMaterial({ color: 0xb8bec4, metalness: 0.75, roughness: 0.35 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x22272c, roughness: 0.8 });

  // Coachroof with tapered sides and a sloped front, plus a band of cabin windows
  const shapeCabin = (geometry, xOffset) => {
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + xOffset;
      let y = p.getY(i);
      if (y > 0 && x > 1.2) y -= 0.22 * Math.min(1, (x - 1.2) / 0.7);
      p.setXYZ(i, p.getX(i), y, p.getZ(i) * (1 - 0.3 * Math.max(0, x / 1.9)));
    }
    geometry.computeVertexNormals();
    return geometry;
  };
  const cabinY = deckAt(0.6) + 0.25;
  addMesh(shapeCabin(new THREE.BoxGeometry(3.8, 0.5, 2.4, 12, 2, 6), 0), white, 0.6, cabinY, 0);
  addMesh(shapeCabin(new THREE.BoxGeometry(2.2, 0.13, 2.43, 8, 1, 1), -0.1), glass, 0.5, cabinY + 0.07, 0);
  const roofTop = cabinY + 0.25;

  // Cockpit: sole, coamings, sprayhood, wheel on a pedestal
  addMesh(new THREE.BoxGeometry(3.0, 0.04, 1.8), darkMat, -3.0, deckAt(-3) + 0.03, 0);
  [-1, 1].forEach(z => addMesh(new THREE.BoxGeometry(3.2, 0.3, 0.06), white, -3.0, deckAt(-3) + 0.15, z));
  const hood = addMesh(new THREE.CylinderGeometry(0.55, 0.55, 2.0, 18, 1, true, Math.PI / 2, Math.PI), canvasMat, -1.5, deckAt(-1.5) + 0.05, 0);
  hood.rotation.x = Math.PI / 2;
  hood.scale.set(1, 1, 0.85);
  addMesh(new THREE.TorusGeometry(0.45, 0.025, 8, 28), metal, -4.1, deckAt(-4.1) + 0.6, 0).rotation.y = Math.PI / 2;
  addMesh(new THREE.CylinderGeometry(0.05, 0.07, 0.6, 8), metal, -4.0, deckAt(-4) + 0.3, 0);

  // ---------------------------------------------------------------------------
  // Mast, spreaders and a boom that pivots at the mast
  // ---------------------------------------------------------------------------
  const MAST_X = 1.6, MAST_TOP = 17.6, BOOM_Y = 2.6, BOOM_LEN = 5.2;
  addMesh(new THREE.CylinderGeometry(0.055, 0.09, MAST_TOP - roofTop, 12), metal, MAST_X, (MAST_TOP + roofTop) / 2, 0);
  [[6.4, 1.05], [11.2, 0.95]].forEach(([y, w]) => addMesh(new THREE.BoxGeometry(0.06, 0.04, w * 2), metal, MAST_X - 0.05, y, 0));
  const boomPivot = new THREE.Group();
  boomPivot.position.set(MAST_X, BOOM_Y, 0);
  group.add(boomPivot);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, BOOM_LEN, 10), metal);
  boom.rotation.z = Math.PI / 2;
  boom.position.set(-BOOM_LEN / 2, -0.075, 0);
  boomPivot.add(boom);

  // ---------------------------------------------------------------------------
  // Sails: vertex grids reshaped every frame from tack, head, clew and camber
  // ---------------------------------------------------------------------------
  const main = createSail(26, 14, createSailMaterial(sunView, 1), group);
  const jib = createSail(22, 12, createSailMaterial(sunView, 0), group);
  const mainTack = new THREE.Vector3(MAST_X - 0.08, BOOM_Y + 0.05, 0), mainHead = new THREE.Vector3(MAST_X - 0.08, MAST_TOP - 0.4, 0);
  const stemTop = new THREE.Vector3(6.4, sheer(1) + 0.05, 0), stayTop = new THREE.Vector3(MAST_X, MAST_TOP - 0.3, 0);
  const jibTack = stemTop.clone().add(new THREE.Vector3(-0.15, 0.25, 0)), jibHead = stemTop.clone().lerp(stayTop, 0.82);
  const mainClew = new THREE.Vector3(), jibClew = new THREE.Vector3();

  // ---------------------------------------------------------------------------
  // Standing rigging, lifelines, pulpit and pushpit
  // ---------------------------------------------------------------------------
  const seg = [];
  const line = (a, b) => seg.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  [-1, 1].forEach(sd => {
    const chainplate = [MAST_X - 0.1, deckAt(MAST_X - 0.1), sd * 1.75];
    line(chainplate, [MAST_X - 0.05, 11.2, sd * 0.95]); line([MAST_X - 0.05, 11.2, sd * 0.95], [MAST_X, MAST_TOP - 0.3, sd * 0.05]);   // cap shroud
    line(chainplate, [MAST_X - 0.05, 6.4, sd * 1.05]); line([MAST_X - 0.05, 6.4, sd * 1.05], [MAST_X, 11.2, sd * 0.06]);            // intermediate
    line([MAST_X + 0.35, deckAt(MAST_X + 0.35), sd * 1.7], [MAST_X, 6.4, sd * 0.08]);                                                // lowers
    line([MAST_X - 0.6, deckAt(MAST_X - 0.6), sd * 1.75], [MAST_X, 6.4, sd * 0.08]);
    let prev = null;
    for (let x = -5.2; x <= 5.4; x += 1.3) {                                                                                       // stanchions and lifelines
      const z = sd * (beam(uAt(x)) - 0.06), y0 = deckAt(x);
      line([x, y0, z], [x, y0 + 0.62, z]);
      if (prev) { line([prev[0], prev[1] + 0.62, prev[2]], [x, y0 + 0.62, z]); line([prev[0], prev[1] + 0.35, prev[2]], [x, y0 + 0.35, z]); }
      prev = [x, y0, z];
    }
    line([prev[0], prev[1] + 0.62, prev[2]], [6.3, sheer(1) + 0.62, 0]);                                                            // pulpit
    line([-5.2, deckAt(-5.2) + 0.62, sd * (beam(uAt(-5.2)) - 0.06)], [-5.45, sheer(0) + 0.62, sd * 0.4]);                           // pushpit
  });
  line([-5.45, sheer(0) + 0.62, -0.4], [-5.45, sheer(0) + 0.62, 0.4]);
  line([stemTop.x, stemTop.y, 0], [stayTop.x, stayTop.y, 0]);                                                                        // forestay
  line([-5.4, sheer(0), 0], [MAST_X, MAST_TOP - 0.2, 0]);                                                                            // backstay
  const rigging = createRiggingLines(seg, pxUniform, sunUniform);
  rigging.renderOrder = 1;
  group.add(rigging);

  // ---------------------------------------------------------------------------
  // Lights: masthead, bow red/green, stern white, warm cockpit glow
  // ---------------------------------------------------------------------------
  const lamp = (hex, k) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: hex, emissiveIntensity: k });
  const navGeo = new THREE.SphereGeometry(0.06, 10, 8);
  addMesh(new THREE.SphereGeometry(0.09, 12, 8), lamp(0xfff1d6, 4.5), MAST_X, MAST_TOP + 0.08, 0);
  addMesh(navGeo, lamp(0xff2414, 5), 6.1, sheer(1) + 0.3, -0.18);
  addMesh(navGeo, lamp(0x1aff66, 5), 6.1, sheer(1) + 0.3, 0.18);
  addMesh(navGeo, lamp(0xfff4e0, 5), -5.45, sheer(0) + 0.65, 0);
  const cockpitLight = new THREE.PointLight(0xffc98a, 1.2, 18, 2);
  cockpitLight.position.set(-2.6, 2.4, 0);
  group.add(cockpitLight);

  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // ---------------------------------------------------------------------------
  // Per-frame updates
  // ---------------------------------------------------------------------------
  const up = new THREE.Vector3(0, 1, 0), xAxis = new THREE.Vector3(1, 0, 0);
  const qTilt = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), qRoll = new THREE.Quaternion(), qPose = new THREE.Quaternion();
  const tiltN = new THREE.Vector3();

  const yacht = {
    group,
    waterlineY: 0,   // smoothed height of the yacht on the swell (the chase camera follows it)

    /** Ride the swell: heave, pitch and roll from the sea surface, plus heading and heel from the physics. */
    pose(boat, dt, t) {
      const y = waveAt(boat.x, boat.z, t);
      tiltN.copy(waveNormal).lerp(up, 0.45).normalize();   // a 12 m hull averages out the shorter waves
      qTilt.setFromUnitVectors(up, tiltN);
      qYaw.setFromAxisAngle(up, boat.psi);
      qRoll.setFromAxisAngle(xAxis, boat.heel);
      qPose.copy(qTilt).multiply(qYaw).multiply(qRoll);
      group.quaternion.slerp(qPose, Math.min(1, dt * 4));
      yacht.waterlineY += (y + 0.04 - yacht.waterlineY) * Math.min(1, dt * 12);
      group.position.set(boat.x, yacht.waterlineY, boat.z);
    },

    /** Swing the boom and reshape both sails: filling, luffing and flutter come from the boat state. */
    rig(boat, t) {
      const b = boat.boom, side = Math.abs(b) > 0.02 ? Math.sign(b) : boat.side;
      boomPivot.rotation.y = b;
      mainClew.set(MAST_X - BOOM_LEN * Math.cos(b), BOOM_Y + 0.005, BOOM_LEN * Math.sin(b));
      const jb = clamp(Math.abs(b) * 0.8, 0.12, 0.95);
      jibClew.set(-0.3 + 1.6 * (jb - 0.12) / 0.83, 2.0, side * (0.6 + 1.5 * Math.sin(jb)));
      const depth = 0.25 + 0.75 * boat.fill, flutter = 1 - boat.fill;
      shapeSail(main, mainTack, mainHead, mainClew, 0.1 * depth, 0.6, side, t, flutter);
      shapeSail(jib, jibTack, jibHead, jibClew, 0.12 * depth, 0, side, t + 1.7, flutter);
    }
  };
  return yacht;
}

// ---------------------------------------------------------------------------
// Sails
// ---------------------------------------------------------------------------

/**
 * Sailcloth: horizontal panel seams, mainsail battens, and light glowing through the cloth when the sun
 * is behind it. Injected into MeshStandardMaterial so the sails keep normal PBR lighting.
 */
function createSailMaterial(sunView, battens) {
  const material = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.75, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunView = sunView;
    shader.uniforms.uBattens = { value: battens };
    shader.vertexShader = 'attribute vec2 sailUv;\nvarying vec2 vSailUv;\n'
      + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vSailUv = sailUv;');
    shader.fragmentShader = 'varying vec2 vSailUv;\nuniform vec3 uSunView;\nuniform float uBattens;\n'
      + shader.fragmentShader.replace('#include <output_fragment>', /* glsl */ `
        float seam = smoothstep(0.46, 0.5, abs(fract(vSailUv.y * 9.0) - 0.5));
        float bat = 0.0;
        for (int i = 1; i <= 4; i++) bat = max(bat, 1.0 - smoothstep(0.0, 0.007, abs(vSailUv.y - float(i) * 0.2)));
        bat *= uBattens * smoothstep(0.5, 0.7, vSailUv.x);
        vec3 vdir = normalize(vViewPosition);
        float back = max(-dot(normal, uSunView), 0.0);                   // sun on the far side of the cloth
        float toward = pow(max(dot(-vdir, uSunView), 0.0), 3.0);         // looking toward the sun
        outgoingLight = outgoingLight * (1.0 - 0.12 * seam - 0.2 * bat)
          + diffuseColor.rgb * vec3(1.0, 0.97, 0.9) * back * (0.2 + 1.4 * toward) * (1.0 - 0.6 * seam - 0.8 * bat);
        #include <output_fragment>`);
  };
  material.customProgramCacheKey = () => 'sail' + battens;   // one program per variant, so each gets its uniforms
  return material;
}

/** An empty (rows x cols) sail grid with sail-space coordinates (u along the chord, v up the luff). */
function createSail(rows, cols, material, parent) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((rows + 1) * (cols + 1) * 3), 3));
  const uv = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) uv.push(i / cols, j / rows);
  geometry.setAttribute('sailUv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(gridIndex(rows + 1, cols + 1));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  parent.add(mesh);
  return { geometry, rows, cols };
}

const _n = new THREE.Vector3(), _tmp = new THREE.Vector3(), _L = new THREE.Vector3(), _R = new THREE.Vector3(), _P = new THREE.Vector3(), _rd = new THREE.Vector3();

/**
 * Lays a sail between tack, head and clew. Each horizontal chord bulges to leeward with a cambered profile
 * (depth as a fraction of the chord), the leech curves out by `roach`, and `flutter` ripples the leech.
 */
function shapeSail(sail, tack, head, clew, depth, roach, side, t, flutter) {
  _n.subVectors(head, tack).cross(_tmp.subVectors(clew, tack)).normalize();
  if (_n.z * side < 0) _n.negate();
  const pos = sail.geometry.attributes.position;
  let k = 0;
  for (let j = 0; j <= sail.rows; j++) {
    const vv = j / sail.rows;
    _L.lerpVectors(tack, head, vv);
    _R.lerpVectors(clew, head, vv);
    _rd.subVectors(_R, _L);
    if (_rd.lengthSq() > 1e-8) _R.addScaledVector(_rd.normalize(), roach * Math.sin(Math.PI * vv));
    const chord = _L.distanceTo(_R);
    for (let i = 0; i <= sail.cols; i++, k++) {
      const uu = i / sail.cols;
      _P.lerpVectors(_L, _R, uu);
      const camber = 4 * uu * (1 - uu) * (1 - 0.25 * uu) * depth * chord * (1 - 0.4 * vv) * (1 + 0.05 * Math.sin(t * 0.6));
      const ripple = flutter * uu * uu * Math.sin(t * 9 + vv * 14 + uu * 3) * 0.04 * chord;
      _P.addScaledVector(_n, camber + ripple);
      pos.setXYZ(k, _P.x, _P.y, _P.z);
    }
  }
  pos.needsUpdate = true;
  sail.geometry.computeVertexNormals();
}

// ---------------------------------------------------------------------------
// Rigging
// ---------------------------------------------------------------------------

/**
 * Wires are ~1 cm thick, much thinner than a pixel at chase distance. Each line is drawn with the opacity
 * of the pixel area it really covers, so distant rigging fades instead of crawling, and gets a
 * thin-cylinder glint when a wire lines up with the sun.
 */
function createRiggingLines(seg, pxUniform, sunUniform) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  const dirs = [];
  for (let i = 0; i < seg.length; i += 6) {
    const dx = seg[i + 3] - seg[i], dy = seg[i + 4] - seg[i + 1], dz = seg[i + 5] - seg[i + 2], l = Math.hypot(dx, dy, dz) || 1;
    dirs.push(dx / l, dy / l, dz / l, dx / l, dy / l, dz / l);
  }
  geometry.setAttribute('wireDir', new THREE.Float32BufferAttribute(dirs, 3));
  return new THREE.LineSegments(geometry, new THREE.ShaderMaterial({
    uniforms: { uPx: pxUniform, uSun: sunUniform }, transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      uniform float uPx; uniform vec3 uSun;
      attribute vec3 wireDir;
      varying float vAlpha; varying float vGlint;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec4 mv = viewMatrix * wp;
        vAlpha = clamp(0.012 * uPx / max(-mv.z, 0.1), 0.06, 1.0);
        vec3 T = normalize(mat3(modelMatrix) * wireDir);
        vec3 H = normalize(uSun + normalize(cameraPosition - wp.xyz));
        float th = dot(T, H);
        vGlint = pow(sqrt(max(1.0 - th * th, 0.0)), 80.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha; varying float vGlint;
      void main(){
        gl_FragColor = vec4(vec3(0.227, 0.255, 0.282) + vec3(1.0, 0.97, 0.92) * vGlint * 1.2, vAlpha);
      }`
  }));
}
