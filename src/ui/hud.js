import { deg } from '../core/util.js';

/**
 * HUD as an engine system: control knobs and the wind dial every frame, text a few times a second.
 * Dial: blue arrow = apparent wind, grey marker = true wind, line = boom.
 */
export function createHud(boat, input) {
  const el = (id) => document.getElementById(id);
  const helm = el('helm'), helmKnob = el('helmKnob'), sheet = el('sheet'), sheetKnob = el('sheetKnob');
  const speed = el('spd'), heading = el('hdg'), status = el('status');
  const apparent = el('awMark'), trueWind = el('twMark'), boom = el('boomMark');
  let textTimer = 0;

  return {
    render(dt) {
      helmKnob.style.transform = `translateX(${input.steer * 62}px)`;
      sheetKnob.style.transform = `translateY(${input.trim * (sheet.clientHeight - 60)}px)`;
      apparent.setAttribute('transform', `rotate(${deg(boat.awa).toFixed(1)})`);
      trueWind.setAttribute('transform', `rotate(${deg(boat.twa).toFixed(1)})`);
      boom.setAttribute('transform', `rotate(${(-deg(boat.boom)).toFixed(1)})`);

      textTimer -= dt;
      if (textTimer > 0) return;
      textTimer = 0.15;
      speed.textContent = (Math.max(0, boat.u) * 1.944).toFixed(1);   // m/s to knots
      const h = ((-deg(boat.psi)) % 360 + 360) % 360;
      heading.textContent = `Heading ${String(Math.round(h) % 360).padStart(3, '0')}°`;
      status.textContent = boat.status;
      helm.setAttribute('aria-valuenow', input.steer.toFixed(2));
      sheet.setAttribute('aria-valuenow', input.trim.toFixed(2));
    }
  };
}
