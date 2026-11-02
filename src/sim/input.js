import { clamp } from '../core/util.js';

const KEYS = ['a', 'd', 'w', 's', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'];

/**
 * Player input as an engine system.
 *   steer  -1 (port) .. +1 (starboard), eased toward the target
 *   trim   0 (sheet hauled in) .. 1 (fully eased)
 * Sources: keyboard (A/D steer, W/S trim, or arrows), the on-screen helm pad (springs back to centre)
 * and the sheet slider (stays where it is left).
 */
export function createInput(canvas) {
  const helm = document.getElementById('helm');
  const sheet = document.getElementById('sheet');

  const input = {
    steer: 0,
    trim: 0.55,
    keys: new Set(),
    helmTarget: 0,
    helmHeld: false,

    update(dt) {
      const k = this.keys;
      const keySteer = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      const target = this.helmHeld ? this.helmTarget : keySteer;
      this.steer += (target - this.steer) * Math.min(1, dt * 6);
      if (k.has('w') || k.has('arrowup')) this.trim = Math.max(0, this.trim - dt * 0.45);
      if (k.has('s') || k.has('arrowdown')) this.trim = Math.min(1, this.trim + dt * 0.45);
    }
  };

  window.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    if (!KEYS.includes(key)) return;
    if (e.target === helm || e.target === sheet || e.target === canvas || e.target === document.body) e.preventDefault();
    input.keys.add(key);
  });
  window.addEventListener('keyup', e => input.keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => input.keys.clear());

  bindPad(helm, e => {
    const r = helm.getBoundingClientRect();
    input.helmHeld = true;
    input.helmTarget = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2 - 22), -1, 1);
  }, () => {
    input.helmHeld = false;
    input.helmTarget = 0;
  });
  bindPad(sheet, e => {
    const r = sheet.getBoundingClientRect();
    input.trim = clamp((e.clientY - r.top - 30) / (r.height - 60), 0, 1);
  });

  return input;
}

/** Pointer handling for a touch pad: onMove while pressed (pointer captured), onEnd on release. */
function bindPad(el, onMove, onEnd) {
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); onMove(e); });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) onMove(e); });
  const end = e => {
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (onEnd) onEnd();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
