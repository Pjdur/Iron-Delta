// ---------------------------------------------------------------------------
// UnderwaterView — layered "you are under water" rendering on top of the 3D
// scene. The old effect was a single blue-tint DOM layer ("blue fog"); this
// one stacks several layers so submersion reads as actually being IN the
// water:
//
//   1. depth tint    — DOM gradient that multiplies the screen deep teal,
//                      darkening toward the edges and with depth
//   2. surface glow  — DOM gradient adding light at the top of the screen
//                      (the sunlit surface shimmering above you); fades
//                      away as you sink
//   3. god rays      — canvas: swaying light shafts pouring down from the
//                      surface; strongest just under the surface, gone in
//                      the deep
//   4. marine snow   — canvas: tiny slow specks drifting past the camera
//   5. bubbles       — canvas: wobbling bubbles rising past the camera
//
// All layers fade with `depth` (0 = at the surface, 1 = ~6 m down) so
// dipping below the waves is a smooth transition, not a hard cut. The
// particle field shifts against camera motion, so driving forward streams
// the water past you.
// ---------------------------------------------------------------------------

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class UnderwaterView {
  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'underwater';
    this.root.style.cssText = 'position:fixed;inset:0;z-index:15;pointer-events:none;';

    // ---- layer 1: depth tint (multiply blend so it darkens the world) ----
    this.tintEl = document.createElement('div');
    this.tintEl.style.cssText = `
      position:absolute;inset:0;opacity:0;transition:opacity .25s ease-out;
      mix-blend-mode:multiply;
      background:radial-gradient(ellipse at 50% 42%,
        rgba(10, 52, 66, 0.10) 0%,
        rgba(8, 44, 58, 0.35) 40%,
        rgba(4, 24, 38, 0.80) 78%,
        rgba(2, 14, 24, 0.95) 100%);
    `;
    this.root.appendChild(this.tintEl);

    // ---- layer 2: sunlit surface glow above (screen blend so it adds light) ----
    this.surfaceEl = document.createElement('div');
    this.surfaceEl.style.cssText = `
      position:absolute;inset:0;opacity:0;transition:opacity .25s ease-out;
      mix-blend-mode:screen;
      background:linear-gradient(180deg,
        rgba(60, 150, 150, 0.55) 0%,
        rgba(30, 96, 110, 0.28) 22%,
        rgba(10, 40, 56, 0.0) 55%,
        rgba(0, 0, 0, 0.0) 100%);
    `;
    this.root.appendChild(this.surfaceEl);

    // ---- layers 3-5: canvas (god rays, marine snow, bubbles) ----
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    this.ctx = this.canvas.getContext('2d');
    this.root.appendChild(this.canvas);
    document.body.appendChild(this.root);

    this.depth = 0;        // eased 0..1 — what the layers currently show
    this.targetDepth = 0;  // 0..1 — where the tank actually is
    this.time = 0;
    this._wasActive = false;

    this._lastCamX = 0; this._lastCamY = 0; this._lastCamZ = 0;
    this._hasLastCam = false;

    // god rays — swaying shafts falling from the top of the screen
    this.rays = [];
    for (let i = 0; i < 7; i++) {
      this.rays.push({
        x: (i + 0.28 + Math.random() * 0.44) / 7, // spread across the width
        w: 0.04 + Math.random() * 0.07,           // half-width at the top
        lean: (Math.random() - 0.5) * 0.35,       // how far they lean as they fall
        sway: 0.02 + Math.random() * 0.05,        // horizontal sway amplitude
        speed: 0.10 + Math.random() * 0.22,       // sway speed
        phase: Math.random() * Math.PI * 2,
        alpha: 0.30 + Math.random() * 0.45,
      });
    }

    this.snow = [];
    for (let i = 0; i < 46; i++) this.snow.push(this._newSnow(true));

    this.bubbles = [];
    this._bubbleTimer = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _newSnow(anywhere) {
    return {
      x: Math.random(),
      y: anywhere ? Math.random() : 1.05 + Math.random() * 0.1,
      z: 0.25 + Math.random() * 0.75,             // parallax factor (near = fast)
      r: 0.4 + Math.random() * 1.1,
      fall: 0.008 + Math.random() * 0.02,         // screen fractions per second
      drift: (Math.random() - 0.5) * 0.01,
    };
  }

  _newBubble() {
    return {
      x: Math.random(),
      y: 1.08 + Math.random() * 0.15,
      z: 0.35 + Math.random() * 0.65,
      r: 1.2 + Math.random() * 3.2,
      rise: 0.10 + Math.random() * 0.16,
      wob: Math.random() * Math.PI * 2,
      wobSpeed: 2.2 + Math.random() * 3.4,
    };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** How far below the surface, in metres (clamped negative → 0). */
  setDepth(surfaceDepth) {
    this.targetDepth = Math.min(1, Math.max(0, surfaceDepth / 6.0));
  }

  update(dt, camera) {
    this.time += dt;
    // ease toward the target so surfacing/dipping isn't a hard cut
    this.depth += (this.targetDepth - this.depth) * (1 - Math.exp(-dt * 6));

    const d = this.depth;
    if (d < 0.01 && this.targetDepth < 0.01) {
      if (this._wasActive) {
        this.ctx.clearRect(0, 0, this.w, this.h);
        this.tintEl.style.opacity = '0';
        this.surfaceEl.style.opacity = '0';
        this._hasLastCam = false;
        this._wasActive = false;
      }
      return;
    }
    this._wasActive = true;

    // ---- camera motion → particle parallax (the water streams past you) ----
    let sx = 0, sy = 0;
    if (camera) {
      const p = camera.position;
      if (this._hasLastCam) {
        const e = camera.matrixWorld.elements;
        // camera's right vector in world space
        const rx = e[0], rz = e[2];
        // moving right shifts the water left on screen, and vice versa
        sx = -((p.x - this._lastCamX) * rx + (p.z - this._lastCamZ) * rz) / 30;
        // rising makes the water column slide down the screen
        sy = (p.y - this._lastCamY) / 30;
      }
      this._lastCamX = p.x; this._lastCamY = p.y; this._lastCamZ = p.z;
      this._hasLastCam = true;
    }

    // ---- DOM layers: tint darkens with depth, surface glow fades as you sink ----
    this.tintEl.style.opacity = (d * 0.95).toFixed(3);
    this.surfaceEl.style.opacity = (Math.max(0, 1 - d * 1.35) * 0.9).toFixed(3);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // ---- god rays: bright just below the surface, gone in the deep ----
    const rayStrength = smoothstep(0.03, 0.22, d) * (1 - smoothstep(0.45, 0.90, d));
    if (rayStrength > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (const ray of this.rays) {
        const sway = Math.sin(this.time * ray.speed * Math.PI + ray.phase);
        const x0 = (ray.x + sway * ray.sway) * this.w;
        const x1 = x0 + ray.lean * this.w;
        const topW = ray.w * this.w * 0.5;
        const botW = topW * 3.2;
        const a = ray.alpha * rayStrength *
                  (0.7 + 0.3 * Math.sin(this.time * 0.7 + ray.phase * 2));
        const g = ctx.createLinearGradient(0, 0, 0, this.h);
        g.addColorStop(0, `rgba(150, 220, 215, ${a.toFixed(3)})`);
        g.addColorStop(0.55, `rgba(110, 185, 190, ${(a * 0.45).toFixed(3)})`);
        g.addColorStop(1, 'rgba(90, 160, 170, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x0 - topW, 0);
        ctx.lineTo(x0 + topW, 0);
        ctx.lineTo(x1 + botW, this.h);
        ctx.lineTo(x1 - botW, this.h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // ---- marine snow: slow specks sinking past the camera ----
    for (const p of this.snow) {
      p.y += (p.fall * d) * dt + sy * p.z;
      p.x += p.drift * dt + sx * p.z;
      if (p.y > 1.12) { p.y -= 1.24; p.x = Math.random(); }
      if (p.y < -0.12) { p.y += 1.24; p.x = Math.random(); }
      if (p.x > 1.06) p.x -= 1.12;
      if (p.x < -0.06) p.x += 1.12;
      const a = (0.08 + 0.20 * p.z) * d;
      ctx.fillStyle = `rgba(190, 215, 220, ${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x * this.w, p.y * this.h, p.r * (0.6 + p.z), 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- bubbles: spawn occasionally, wobble upward, pop off the top ----
    this._bubbleTimer -= dt;
    if (this._bubbleTimer <= 0 && this.bubbles.length < 14) {
      this.bubbles.push(this._newBubble());
      this._bubbleTimer = 0.5 + Math.random() * 1.6;
    }
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.wob += b.wobSpeed * dt;
      b.y -= b.rise * d * dt;                       // bubbles rise → y shrinks
      b.x += Math.sin(b.wob) * 0.0009 + sx * b.z * 0.6;
      b.y += sy * b.z;
      if (b.y < -0.12) { this.bubbles.splice(i, 1); continue; }
      const r = b.r * (0.5 + b.z);
      const a = 0.45 * d * b.z;
      ctx.strokeStyle = `rgba(205, 235, 240, ${a.toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(b.x * this.w, b.y * this.h, r, 0, Math.PI * 2);
      ctx.stroke();
      // little glint so they read as bubbles, not rings
      ctx.fillStyle = `rgba(230, 248, 250, ${(a * 0.8).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(b.x * this.w - r * 0.3, b.y * this.h - r * 0.3,
              Math.max(0.5, r * 0.22), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
