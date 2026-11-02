/**
 * Adaptive resolution as an engine system. Every 2 s it checks the average frame time and steps the
 * render resolution (pixel ratio) between 0.75x and the device's pixel ratio, capped at 1.5x:
 * down when below ~45 fps, up after 4 s above ~55 fps. Temporal AA hides most of the softness.
 * onChange() is called after the canvas has been resized, so render targets can follow.
 */
export function createResolutionScaler(renderer, onChange) {
  const MAX = Math.min(window.devicePixelRatio || 1, 1.5), MIN = 0.75, STEP = 0.125;
  let ratio = MAX;   // start sharp; step down only if the device struggles
  let warmup = 3, sum = 0, frames = 0, fastChecks = 0;   // skip the first seconds (shader compilation hitches)
  renderer.setPixelRatio(ratio);

  return {
    render(dt) {
      if (warmup > 0) { warmup -= dt; return; }
      sum += dt;
      frames++;
      if (sum < 2) return;
      const avg = sum / frames;
      sum = 0; frames = 0;

      let next = ratio;
      if (avg > 1 / 45) { next = Math.max(MIN, ratio - STEP); fastChecks = 0; }
      else if (avg < 1 / 55) { if (++fastChecks >= 2) { next = Math.min(MAX, ratio + STEP); fastChecks = 0; } }
      else fastChecks = 0;

      if (next !== ratio) {
        ratio = next;
        renderer.setPixelRatio(ratio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        onChange();
      }
    }
  };
}
