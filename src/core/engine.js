/**
 * Minimal game loop.
 *
 * Systems are plain objects with optional methods:
 *   update(dt, t)  runs at a fixed 60 Hz step (simulation, input)
 *   render(dt, t)  runs once per displayed frame (presentation, drawing)
 * Systems run in the order they were added.
 */
export function createEngine() {
  return {
    step: 1 / 60,
    acc: 0,
    time: 0,
    systems: [],

    add(system) {
      this.systems.push(system);
      return system;
    },

    start() {
      let last = performance.now();
      const tick = (now) => {
        const frame = Math.min((now - last) / 1000, 0.1);   // cap long pauses (tab switches)
        last = now;
        this.acc += frame;
        while (this.acc >= this.step) {
          this.time += this.step;
          for (const s of this.systems) if (s.update) s.update(this.step, this.time);
          this.acc -= this.step;
        }
        for (const s of this.systems) if (s.render) s.render(frame, this.time);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  };
}
