import { smooth } from '../core/util.js';

/** Initial heading: a beam reach toward the sun. */
const START_HEADING = 0.15;

/** A steady breeze across the starting heading, with slow gusts. */
export const wind = {
  dirX: Math.sin(START_HEADING),   // direction the air moves toward (x, z), unit length
  dirZ: Math.cos(START_HEADING),
  speed(t) { return 7 + 1.4 * Math.sin(t * 0.13) + 0.7 * Math.sin(t * 0.41 + 1.7); }   // m/s
};

/**
 * Sailing physics as an engine system.
 *
 * Conventions: psi is the heading, with the bow pointing along (cos psi, -sin psi) in x/z and starboard
 * along (sin psi, cos psi). u is forward speed (m/s). boom is the signed boom angle (+ = starboard).
 *
 * Model: apparent wind (true wind minus boat velocity) sets the angle of attack on the sail, limited by
 * the sheet. Lift and drag give a driving force (forward) and a heeling force (sideways); the hull has
 * quadratic and linear drag. Turning needs water flow over the rudder.
 */
export function createBoat(input, obstacles) {
  return {
    x: 0, z: 0, psi: START_HEADING, u: 3, yawRate: 0, heel: 0, boom: 0.6,
    side: 1,              // +1 sails to starboard, -1 to port (always to leeward)
    fill: 1,              // 0 luffing .. 1 drawing
    awa: 0, twa: 0, aws: 0,   // apparent wind angle (0 = from ahead, + = from starboard), true wind angle, apparent speed
    maneuver: '', maneuverT: 0, gybe: 0, bump: 0, status: '',

    update(dt, t) {
      const fx = Math.cos(this.psi), fz = -Math.sin(this.psi);   // bow direction
      const sx = Math.sin(this.psi), sz = Math.cos(this.psi);    // starboard direction
      const W = wind.speed(t);

      // Apparent wind in the boat frame
      const ax = wind.dirX * W - fx * this.u, az = wind.dirZ * W - fz * this.u;
      const af = ax * fx + az * fz, as = ax * sx + az * sz;
      this.aws = Math.hypot(ax, az);
      this.awa = Math.atan2(-as, -af);
      this.twa = Math.atan2(-(wind.dirX * sx + wind.dirZ * sz), -(wind.dirX * fx + wind.dirZ * fz));
      const A = Math.abs(this.awa);

      // Sails go to leeward. When that side flips the boat has tacked (through the wind) or gybed
      // (through downwind). A small dead band avoids flicker when sailing straight into or away from the wind.
      const newSide = (A < 0.03 || A > Math.PI - 0.06) ? this.side : (this.awa > 0 ? -1 : 1);
      if (newSide !== this.side) {
        const isGybe = A >= Math.PI / 2;
        this.maneuver = isGybe ? 'Gybing' : 'Tacking';
        this.maneuverT = 2.5;
        if (isGybe) { this.gybe = 0.6; this.bump = Math.max(this.bump, 0.35); }
      }
      this.side = newSide;

      // The boom streams with the wind, but the sheet limits how far it can swing out
      const sheetMax = 0.05 + input.trim * 1.4;
      const free = Math.min(A, 1.45);
      const delta = Math.min(free, sheetMax);
      const alpha = A - delta;                                       // angle of attack
      this.fill = smooth(0.04, 0.2, alpha) * smooth(0.35, 0.55, A);  // luffing when eased too far or head to wind
      let CL = 1.25 * Math.sin(2 * Math.min(alpha, 0.785)) * this.fill;
      if (alpha > 0.785) CL *= Math.max(0, 1 - (alpha - 0.785) / 1.2);   // stall
      const CD = 0.08 + 1.1 * Math.sin(alpha) ** 2;
      const q = this.aws * this.aws;
      const drive = CL * Math.sin(A) - CD * Math.cos(A);
      const heelForce = CL * Math.cos(A) + CD * Math.sin(A);

      // Speed with inertia (a tack carries momentum through the wind); turning costs speed
      this.u += (0.0085 * q * drive - 0.02 * this.u * Math.abs(this.u) - 0.06 * this.u) * 0.45 * dt;
      this.u -= Math.abs(this.yawRate) * this.u * 0.18 * dt;

      // Steering needs flow over the rudder; stalled head to wind, the bow slowly falls off
      const yawTarget = -input.steer * (0.03 + 0.06 * Math.abs(this.u)) * (this.u >= 0 ? 1 : -1);
      this.yawRate += (yawTarget - this.yawRate) * Math.min(1, dt * 2.5);
      if (A < 0.5) this.yawRate += Math.sign(this.awa || 1) * (1 - this.fill) * 0.04 * dt;
      this.psi += this.yawRate * dt;

      this.heel += (this.side * Math.min(0.42, 0.0026 * q * heelForce * this.fill) - this.heel) * Math.min(1, dt * 1.2);
      this.boom += (this.side * delta - this.boom) * Math.min(1, dt * (this.gybe > 0 ? 7 : 2.2));   // a gybe slams the boom across
      this.gybe = Math.max(0, this.gybe - dt);
      this.maneuverT = Math.max(0, this.maneuverT - dt);

      this.x += fx * this.u * dt;
      this.z += fz * this.u * dt;
      this.collide(fx, fz);
      this.bump = Math.max(0, this.bump - dt * 1.5);

      this.status = this.maneuverT > 0 ? `${this.maneuver}.`
        : A < 0.55 ? 'In irons. Steer away from the wind.'
        : this.fill < 0.5 ? 'Luffing. Trim the sheet in.'
        : alpha > 1.0 && sheetMax < free - 0.3 ? 'Over-trimmed. Ease the sheet.' : '';
    },

    /**
     * Three circles along the hull (bow, middle, stern). On contact the boat simply stops against the
     * ice or land: it can't move further in, but it can turn away or drift back out.
     */
    collide(fx, fz) {
      for (const off of [4.2, 0.5, -3.6]) {
        for (const o of obstacles) {
          const cx = this.x + fx * off, cz = this.z + fz * off;
          const dx = cx - o.x, dz = cz - o.z, d = Math.hypot(dx, dz), min = o.r + 2.3;
          if (d < min + 0.3 && d > 1e-3) {
            const nx = dx / d, nz = dz / d, into = fx * nx + fz * nz;
            if (d < min) { this.x += nx * (min - d); this.z += nz * (min - d); }
            if ((into < 0 && this.u > 0) || (into > 0 && this.u < 0)) this.u = 0;
          }
        }
      }
    }
  };
}
