import * as THREE from 'three';
import { clamp } from '../core/util.js';
import { waveAt } from '../world/waves.js';

/**
 * Chase camera as an engine system. It sits behind the yacht, swings round turns a little late,
 * looks slightly into the turn, leans a third of the heel, and rides the swell.
 * Drag to orbit (it drifts back behind the boat after 3 s), pinch or scroll to zoom.
 * `onMoved(position)` lets the world follow the camera (sky dome, sea grid, mist).
 */
export function createChaseCamera({ camera, canvas, boat, yacht, engine, onMoved }) {
  const cam = {
    yawOff: 0,                     // orbit offset from "behind the boat"
    pitch: 0.2,
    dist: 50,
    lastDrag: -10,
    lookPt: new THREE.Vector3(),   // shared with the mirror pass
    pos: new THREE.Vector3(),
    psiS: 0,                       // smoothed heading
    roll: 0,
    ready: false,

    render(dt, t) {
      if (t - this.lastDrag > 3) this.yawOff *= Math.exp(-dt * 0.8);
      if (!this.ready) this.psiS = boat.psi;
      this.psiS += (boat.psi - this.psiS) * (1 - Math.exp(-dt * 1.3));
      const a = this.psiS + Math.PI + this.yawOff, cp = Math.cos(this.pitch);
      const lead = -boat.yawRate * 7;
      this.lookPt.set(boat.x + Math.sin(boat.psi) * lead, 4 + yacht.waterlineY * 0.5, boat.z + Math.cos(boat.psi) * lead);
      const desired = new THREE.Vector3(
        this.lookPt.x + Math.cos(a) * cp * this.dist,
        this.lookPt.y + Math.sin(this.pitch) * this.dist,
        this.lookPt.z - Math.sin(a) * cp * this.dist);
      if (!this.ready) { this.pos.copy(desired); this.ready = true; }
      else this.pos.lerp(desired, 1 - Math.exp(-dt * 2.2));

      camera.position.copy(this.pos);
      camera.position.y += waveAt(this.pos.x, this.pos.z, t) * 0.4;
      if (boat.bump > 0) {
        camera.position.addScaledVector(new THREE.Vector3(Math.sin(t * 61), Math.sin(t * 47), Math.cos(t * 53)), boat.bump * 0.35);
      }
      camera.lookAt(this.lookPt);
      this.roll += (-boat.heel * 0.3 * Math.cos(this.yawOff) - this.roll) * Math.min(1, dt * 2);
      camera.rotateZ(this.roll);
      onMoved(camera.position);
    }
  };

  // Orbit and zoom
  const pointers = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      cam.yawOff -= (e.clientX - prev.x) * 0.006;
      cam.pitch = clamp(cam.pitch + (e.clientY - prev.y) * 0.004, 0.05, 1.2);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0) cam.dist = clamp(cam.dist * pinch / d, 15, 130);
      pinch = d;
    }
    cam.lastDrag = engine.time;
  });
  const release = e => { pointers.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    cam.dist = clamp(cam.dist * (1 + e.deltaY * 0.001), 15, 130);
  }, { passive: false });

  return cam;
}
