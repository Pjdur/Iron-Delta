import * as THREE from 'three';
import { Sea } from './sea.js';
import { Ship, SHIP_SPECS } from './ship.js';
import {
  buildIslands, navalHeightAt, paintNavalMinimap,
  ISLANDS, NAVAL_PLAY_RADIUS, NAVAL_HALF,
} from './navalterrain.js';
import { WATER_LEVEL } from './terrain.js';
import { clamp, wrapAngle } from './noise.js';

// ---------------------------------------------------------------------------
// NAVAL ENGAGEMENT — a self-contained battle on open water:
//   • bigger Gerstner sea with a warmer late-afternoon sky
//   • player destroyer: telegraph engine, rudder, 4x2 main battery, torpedoes
//   • enemy destroyers & cruisers with broadside AI, lead gunnery, torpedoes
//   • ballistic shells, water-column splashes, fires, catastrophic magazines
//   • sinking ships that list, settle and steam as they go under
// ---------------------------------------------------------------------------

const SUN_DIR = new THREE.Vector3(0.62, 0.36, 0.44).normalize();
const FOG_COLOR = 0xb7c3ca;
const GRAV = 9.81;
const WIND = new THREE.Vector3(1.6, 0, 0.9);   // smoke drift

const TELEGRAPH = [
  { v: -1, label: 'FULL ASTERN' },
  { v: -0.6, label: 'HALF ASTERN' },
  { v: -0.3, label: 'SLOW ASTERN' },
  { v: 0, label: 'ALL STOP' },
  { v: 0.3, label: 'SLOW AHEAD' },
  { v: 0.62, label: 'HALF AHEAD' },
  { v: 1, label: 'FULL AHEAD' },
];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _pv = new THREE.Vector3();
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Enemy difficulty scaling. The player hulls are fast and aggressive, so the
// AI gets a de-tuned copy of the same spec (slower, clumsier, softer, slower
// to reload) instead of sharing the player's buffed numbers directly.
// ---------------------------------------------------------------------------
const ENEMY_NERF = {
  speed: 0.55, chassis: 0.7, turn: 0.7, rudder: 0.8, hp: 0.55, reload: 2.6,
};

function enemySpec(base) {
  return {
    ...base,
    hp: Math.round(base.hp * ENEMY_NERF.hp),
    maxSpeed: base.maxSpeed * ENEMY_NERF.speed,
    astern: base.astern * ENEMY_NERF.speed,
    accel: base.accel * ENEMY_NERF.chassis,
    decel: base.decel * ENEMY_NERF.chassis,
    turnRate: base.turnRate * ENEMY_NERF.turn,
    rudderRate: base.rudderRate * ENEMY_NERF.rudder,
    reload: Math.max(9, base.reload * ENEMY_NERF.reload),
  };
}

// ---------------------------------------------------------------------------
// Particle pool (same proven pattern as the ground game's effects.js)
// ---------------------------------------------------------------------------
function makeSprite() {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.16)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
let SPRITE_TEX = null;

class ParticlePool {
  constructor(scene, capacity, blending) {
    this.cap = capacity;
    this.cursor = 0;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.pos[i * 3 + 1] = -9999;
      this.alpha[i] = 0;
      this.size[i] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: SPRITE_TEX || (SPRITE_TEX = makeSprite()) } },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        varying float vA;
        varying vec3 vC;
        void main() {
          vA = aAlpha; vC = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (620.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uTex;
        varying float vA;
        varying vec3 vC;
        void main() {
          float a = texture2D(uTex, gl_PointCoord).a * vA;
          if (a < 0.012) discard;
          gl_FragColor = vec4(vC, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.geo = geo;
  }

  emit(x, y, z, vx, vy, vz, r, g, b, size, life, grav, drag, grow = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.size0[i] = size; this.size[i] = size;
    this.grow[i] = grow;
    this.alpha[i] = 1;
    this.life[i] = life; this.maxLife[i] = life;
    this.grav[i] = grav; this.drag[i] = drag;
  }

  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0; this.size[i] = 0;
        this.pos[i * 3 + 1] = -9999;
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 2] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d + this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = t * t * 0.95 + t * 0.05;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * (1 - t));
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Naval FX — splashes, wakes, muzzle blasts, fires, foam rings
// ---------------------------------------------------------------------------
class NavalFX {
  constructor(scene) {
    this.scene = scene;
    this.pFire = new ParticlePool(scene, 2200, THREE.AdditiveBlending);
    this.pSmoke = new ParticlePool(scene, 3600, THREE.NormalBlending);

    this.flash = new THREE.PointLight(0xffc890, 0, 260, 2);
    this.flash.visible = false;
    scene.add(this.flash);
    this.flashTime = 0;

    // expanding foam rings on the water
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.78, 1.0, 26);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xeef5f8, transparent: true, opacity: 0, depthWrite: false,
      }));
      m.visible = false;
      m.renderOrder = 4;
      scene.add(m);
      this.rings.push({ mesh: m, t: 1, scale: 1 });
    }
    this.ringCur = 0;

    this.shake = 0;
  }

  ring(pos, scale) {
    const r = this.rings[this.ringCur];
    this.ringCur = (this.ringCur + 1) % this.rings.length;
    r.t = 0;
    r.scale = scale;
    r.mesh.position.set(pos.x, WATER_LEVEL + 0.25, pos.z);
    r.mesh.visible = true;
  }

  /** The iconic towering water column when a shell strikes the sea. */
  splash(pos, scale = 1) {
    const s = scale;
    for (let i = 0; i < 10 + Math.floor(8 * s); i++) {
      const th = Math.random() * Math.PI * 2;
      const rr = Math.random() * 2.2 * s;
      this.pSmoke.emit(
        pos.x + Math.cos(th) * rr, WATER_LEVEL + 0.3, pos.z + Math.sin(th) * rr,
        Math.cos(th) * 1.5, (16 + Math.random() * 24) * Math.min(1.6, s), Math.sin(th) * 1.5,
        0.86, 0.92, 0.99,
        (1.3 + Math.random() * 1.9) * s, 1.4 + Math.random() * 1.0,
        -14, 0.32, 0.55,
      );
    }
    // crowning spray at the top
    for (let i = 0; i < 8; i++) {
      const th = Math.random() * Math.PI * 2;
      this.pSmoke.emit(
        pos.x, WATER_LEVEL + 10 * s, pos.z,
        Math.cos(th) * (5 + Math.random() * 8) * s,
        8 + Math.random() * 14 * s,
        Math.sin(th) * (5 + Math.random() * 8) * s,
        0.90, 0.95, 1.0,
        (0.8 + Math.random() * 1.2) * s, 0.9 + Math.random() * 0.7,
        -16, 0.5, 0.4,
      );
    }
    // low base surge
    for (let i = 0; i < 8; i++) {
      const th = Math.random() * Math.PI * 2;
      this.pSmoke.emit(
        pos.x + Math.cos(th), WATER_LEVEL + 0.4, pos.z + Math.sin(th),
        Math.cos(th) * (7 + Math.random() * 9) * s,
        2 + Math.random() * 4,
        Math.sin(th) * (7 + Math.random() * 9) * s,
        0.82, 0.90, 0.97,
        (1.6 + Math.random() * 1.6) * s, 1.0 + Math.random() * 0.8,
        -3, 1.1, 2.2,
      );
    }
    this.ring(pos, 10 * s);
  }

  explosion(p, scale = 1) {
    const s = scale;
    for (let i = 0; i < 22; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI;
      const sp = (6 + Math.random() * 24) * s;
      this.pFire.emit(
        p.x, p.y, p.z,
        Math.cos(th) * Math.sin(ph) * sp,
        Math.abs(Math.cos(ph)) * sp * 0.9 + 4,
        Math.sin(th) * Math.sin(ph) * sp,
        1.0, 0.6 + Math.random() * 0.3, 0.15,
        (1.6 + Math.random() * 2.6) * s, 0.3 + Math.random() * 0.5,
        -6, 2.4, 0.9,
      );
    }
    for (let i = 0; i < 22; i++) {
      const th = Math.random() * Math.PI * 2;
      const sp = (12 + Math.random() * 40) * s;
      this.pFire.emit(
        p.x, p.y + 0.4, p.z,
        Math.cos(th) * sp, 4 + Math.random() * 24 * s, Math.sin(th) * sp,
        1.0, 0.85, 0.45,
        0.35 + Math.random() * 0.5, 0.5 + Math.random() * 0.7,
        -22, 0.7, 0,
      );
    }
    for (let i = 0; i < 24; i++) {
      const th = Math.random() * Math.PI * 2;
      const sp = (2 + Math.random() * 10) * s;
      const g = 0.2 + Math.random() * 0.2;
      this.pSmoke.emit(
        p.x + (Math.random() - 0.5) * 3 * s, p.y + Math.random() * 2 * s, p.z + (Math.random() - 0.5) * 3 * s,
        Math.cos(th) * sp, 3 + Math.random() * 7, Math.sin(th) * sp,
        g, g * 0.96, g * 0.9,
        (2.4 + Math.random() * 4) * s, 1.6 + Math.random() * 1.8,
        1.0, 1.1, 1.6,
      );
    }
    this.flash.position.copy(p);
    this.flash.intensity = 1400 * s;
    this.flash.visible = true;
    this.flashTime = 0.24;
    this.shake = Math.min(1, this.shake + 0.4 * s);
  }

  muzzle(pos, dir, scale = 1) {
    for (let i = 0; i < 14; i++) {
      this.pFire.emit(
        pos.x, pos.y, pos.z,
        dir.x * (20 + Math.random() * 30) * scale + (Math.random() - 0.5) * 9,
        dir.y * 22 * scale + (Math.random() - 0.5) * 7,
        dir.z * (20 + Math.random() * 30) * scale + (Math.random() - 0.5) * 9,
        1.0, 0.8, 0.4,
        (1.6 + Math.random() * 2.6) * scale, 0.14 + Math.random() * 0.16,
        0, 3.5, 1.1,
      );
    }
    for (let i = 0; i < 10; i++) {
      const g = 0.5 + Math.random() * 0.2;
      this.pSmoke.emit(
        pos.x, pos.y, pos.z,
        dir.x * (5 + Math.random() * 12) * scale + (Math.random() - 0.5) * 6,
        dir.y * 6 * scale + Math.random() * 4,
        dir.z * (5 + Math.random() * 12) * scale + (Math.random() - 0.5) * 6,
        g, g, g * 0.96,
        (2.0 + Math.random() * 2.4) * scale, 0.9 + Math.random() * 0.9,
        1.0, 2.0, 2.6,
      );
    }
    this.flash.position.copy(pos).addScaledVector(dir, 3);
    this.flash.intensity = 700 * scale;
    this.flash.visible = true;
    this.flashTime = 0.11;
  }

  wake(pos, fwd, k, len) {
    // propeller wash + trailing foam streak
    for (let i = 0; i < 2; i++) {
      const spread = (Math.random() - 0.5) * (4 + 8 * k);
      this.pSmoke.emit(
        pos.x + (Math.random() - 0.5) * 3 - fwd.x * Math.random() * 6,
        pos.y + 0.1,
        pos.z + (Math.random() - 0.5) * 3 - fwd.z * Math.random() * 6,
        -fwd.x * (2 + 5 * k) + spread, 0.3 + Math.random() * 0.6, -fwd.z * (2 + 5 * k) - spread,
        0.88, 0.93, 0.98,
        (1.4 + Math.random() * 2.2) * (0.5 + k), 2.8 + Math.random() * 3.2,
        -0.4, 0.8, 2.6,
      );
    }
  }

  bowSpray(x, y, z, fwd, dig, speed) {
    const side = Math.random() < 0.5 ? 1 : -1;
    _v3.set(-fwd.z, 0, fwd.x).multiplyScalar(side);
    for (let i = 0; i < 5; i++) {
      this.pSmoke.emit(
        x + _v3.x * Math.random() * 3, y, z + _v3.z * Math.random() * 3,
        _v3.x * (3 + Math.random() * 5) - fwd.x * speed * 0.3,
        2.5 + Math.random() * 5 * dig,
        _v3.z * (3 + Math.random() * 5) - fwd.z * speed * 0.3,
        0.85, 0.92, 0.99,
        0.7 + Math.random() * 1.2, 0.7 + Math.random() * 0.6,
        -12, 0.6, 0.8,
      );
    }
  }

  funnel(pos, k, isPlayer) {
    const g = isPlayer ? 0.5 + k * 0.14 : 0.38 + k * 0.12;
    this.pSmoke.emit(
      pos.x, pos.y, pos.z,
      WIND.x + (Math.random() - 0.5) * 1.4,
      5.5 + Math.random() * 3.5 + k * 3,
      WIND.z + (Math.random() - 0.5) * 1.4,
      g, g, g * 1.02,
      1.6 + Math.random() * 1.6, 3.2 + Math.random() * 3,
      0.35, 0.5, 4.2,
    );
  }

  fire(pos, power) {
    for (let i = 0; i < 2; i++) {
      this.pFire.emit(
        pos.x + (Math.random() - 0.5) * 3, pos.y + Math.random() * 1.4, pos.z + (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 2.4, (3.4 + Math.random() * 4.2) * power, (Math.random() - 0.5) * 2.4,
        1.0, 0.52 + Math.random() * 0.28, 0.1,
        (1.6 + Math.random() * 1.8) * power, 0.4 + Math.random() * 0.5,
        -1.4, 1.2, 2.2,
      );
    }
    if (Math.random() < 0.8) {
      const g = 0.13 + Math.random() * 0.08;
      this.pSmoke.emit(
        pos.x + (Math.random() - 0.5) * 3, pos.y + 2, pos.z + (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 1.6 + WIND.x * 0.4, 4 + Math.random() * 3, (Math.random() - 0.5) * 1.6 + WIND.z * 0.4,
        g, g, g * 1.05,
        2.6 + Math.random() * 2.4, 2.2 + Math.random() * 2,
        -0.5, 0.5, 3.4,
      );
    }
  }
  sinkFoam(pos, t) {
    this.pSmoke.emit(
      pos.x, pos.y, pos.z,
      (Math.random() - 0.5) * 4, 0.8 + Math.random() * 2.2, (Math.random() - 0.5) * 4,
      0.90, 0.95, 1.0,
      1.6 + Math.random() * 2.2, 1.6 + Math.random() * 1.6,
      -2, 1.2, 2.4,
    );
    if (Math.random() < 0.4) {
      this.pSmoke.emit(
        pos.x, pos.y + 0.6, pos.z,
        (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 2,
        0.75, 0.82, 0.88,
        0.4 + Math.random() * 0.6, 0.9 + Math.random() * 0.8,
        -4, 1.4, 0.8,
      );
    }
  }

  steam(pos) {
    const g = 0.72 + Math.random() * 0.1;
    this.pSmoke.emit(
      pos.x, pos.y, pos.z,
      (Math.random() - 0.5) * 2.4, 4.5 + Math.random() * 4, (Math.random() - 0.5) * 2.4,
      g, g, g,
      1.8 + Math.random() * 1.8, 1.8 + Math.random() * 1.6,
      0.6, 0.8, 3.2,
    );
  }

  update(dt) {
    this.pFire.update(dt);
    this.pSmoke.update(dt);

    if (this.flashTime > 0) {
      this.flashTime -= dt;
      this.flash.intensity *= Math.max(0, 1 - dt * 11);
      if (this.flashTime <= 0) {
        this.flash.visible = false;
        this.flash.intensity = 0;
      }
    }

    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += dt / 1.35;
      if (r.t >= 1) { r.mesh.visible = false; continue; }
      const s = 1 + r.t * r.scale;
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = 0.5 * (1 - r.t);
    }

    this.shake *= Math.max(0, 1 - dt * 3.0);
  }

  applyShake(camera, t) {
    if (this.shake <= 0.001) return;
    const a = this.shake * this.shake;
    camera.position.x += Math.sin(t * 47.3) * a * 0.8;
    camera.position.y += Math.sin(t * 61.7) * a * 0.6;
    camera.position.z += Math.cos(t * 53.1) * a * 0.8;
  }
}

// ---------------------------------------------------------------------------
// Sky — late golden afternoon over open water
// ---------------------------------------------------------------------------
function buildSky(scene) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uSunDir: { value: SUN_DIR } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 zenith  = vec3(0.16, 0.33, 0.60);
        vec3 horizon = vec3(0.78, 0.72, 0.64);
        vec3 col = mix(horizon, zenith, pow(h, 0.9));

        float sd = max(dot(d, normalize(uSunDir)), 0.0);
        col += vec3(1.0, 0.84, 0.58) * pow(sd, 300.0) * 2.6;
        col += vec3(1.0, 0.78, 0.5) * pow(sd, 12.0) * 0.30;
        col += vec3(1.0, 0.72, 0.44) * pow(sd, 3.5) * 0.10;

        // warm haze band hugging the horizon
        col = mix(vec3(0.80, 0.75, 0.68), col, smoothstep(-0.02, 0.14, d.y));
        col = mix(vec3(0.40, 0.44, 0.46), col, smoothstep(-0.30, -0.02, d.y));

        // drifting cumulus
        float c1 = sin(d.x * 3.1 + d.z * 2.2) * sin(d.z * 5.3 - d.x * 1.7);
        float c2 = sin(d.x * 6.7 - d.z * 4.1) * sin(d.z * 9.1 + d.x * 3.3);
        float cl = smoothstep(0.22, 0.9, c1 * 0.65 + c2 * 0.35);
        cl *= smoothstep(0.02, 0.30, d.y) * (1.0 - smoothstep(0.55, 0.95, d.y));
        col = mix(col, vec3(0.98, 0.95, 0.92), cl * 0.55);
        // silver lining toward the sun
        col += vec3(0.9, 0.8, 0.65) * cl * pow(sd, 4.0) * 0.35;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(6500, 32, 20), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);
  return sky;
}

// ---------------------------------------------------------------------------
// The battle itself
// ---------------------------------------------------------------------------
export class NavalBattle {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00034);

    this.camera = new THREE.PerspectiveCamera(
      55, window.innerWidth / window.innerHeight, 1.2, 15000,
    );

    // ---- lights ----
    this.hemi = new THREE.HemisphereLight(0xc4d5e2, 0x2e3a42, 0.68);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffe9c4, 2.35);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1400;
    this.sun.shadow.camera.left = -190;
    this.sun.shadow.camera.right = 190;
    this.sun.shadow.camera.top = 190;
    this.sun.shadow.camera.bottom = -190;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 1.2;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.renderer.shadowMap.needsUpdate = true;

    this.sky = buildSky(this.scene);

    this.sea = new Sea(this.scene, SUN_DIR, {
      size: 5800, segments: 340, snapStep: 7, waveScale: 1.55, minWaveLen: 14,
      fogDensity: 0.00031,
      colors: {
        abyss: 0x05202e, deep: 0x0e4058, shallow: 0x217288,
        sky: 0xa8bcc8, foam: 0xf4f8fa,
      },
    });

    this.fx = new NavalFX(this.scene);
    this.islands = null;
    this.mapBase = null;

    // ---- ships ----
    this.player = new Ship(this.scene, 'destroyer', { isPlayer: true, fx: this.fx, sea: this.sea });
    this.player.pos.set(0, WATER_LEVEL, 300);
    this.player.yaw = Math.PI;         // facing south, into the island ring
    this.enemies = [];

    // ---- shells & torpedoes ----
    this.shells = [];
    const shellGeo = new THREE.CylinderGeometry(0.16, 0.16, 3.2, 6);
    shellGeo.rotateX(Math.PI / 2);
    const shellMat = new THREE.MeshBasicMaterial({ color: 0xffdca8 });
    for (let i = 0; i < 48; i++) {
      const mesh = new THREE.Mesh(shellGeo, shellMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.shells.push({
        alive: false, life: 0, fromPlayer: true, puffT: 0,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), mesh,
      });
    }

    this.torps = [];
    const torpGeo = new THREE.CapsuleGeometry(0.42, 5.4, 4, 8);
    torpGeo.rotateX(Math.PI / 2);
    const torpMat = new THREE.MeshStandardMaterial({ color: 0x2c3a30, roughness: 0.6, metalness: 0.5 });
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(torpGeo, torpMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.torps.push({
        alive: false, travelled: 0, range: 0, yaw: 0, speed: 0, armed: false,
        owner: null, bubbleT: 0,
        pos: new THREE.Vector3(), mesh,
      });
    }

    // ---- game state ----
    this.keys = new Set();
    this.pointer = { x: 0, y: 0.1 };
    this.cam = { yaw: Math.PI, dist: 250, pitch: 0.17 };
    this.aimPoint = new THREE.Vector3(0, WATER_LEVEL, -1000);
    this.aimDist = 0;
    this.locked = null;
    this.score = 0;
    this.running = false;
    this.playerSunk = false;
    this.msgTimer = 0;
    this.elapsed = 0;
    this.frameCount = 0;
    this.spawnTimer = 2;
    this.groundCd = 0;
    this.hudAcc = 0;

    this._grabHud();
    this._buildCompass();
  }

  // ------------------------------------------------------------------ boot
  async build(progress, nextFrame) {
    progress(0.08, 'Charting the islands');
    await nextFrame();
    this.islands = buildIslands(this.scene);

    progress(0.5, 'Sounding the seabed');
    await nextFrame();
    const S = 180;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    paintNavalMinimap(cv.getContext('2d'), S);
    this.mapBase = cv;

    progress(0.7, 'Raising steam');
    await nextFrame();
    for (let i = 0; i < 3; i++) this.spawnFleet();

    progress(0.88, 'Manning the guns');
    await nextFrame();
    this.player._applyTransform();
    this.updateCamera(0.1, true);

    progress(1.0, 'Ready');
  }

  start(keys) {
    this.keys = keys;
    this.running = true;
  }

  // ------------------------------------------------------------------ HUD
  _grabHud() {
    this.el = {
      speed: document.getElementById('speedVal'),
      gear: document.getElementById('gear'),
      rudder: document.getElementById('rudderVal'),
      speedLbl: document.getElementById('speedLbl'),
      speedUnit: document.getElementById('speedUnit'),
      ammo: document.getElementById('ammoVal'),
      ammoTot: document.getElementById('ammoTot'),
      ammoLbl: document.getElementById('ammoLbl'),
      reload: document.getElementById('reloadFill'),
      health: document.getElementById('healthFill'),
      range: document.getElementById('range'),
      crosshair: document.getElementById('crosshair'),
      compass: document.getElementById('compassStrip'),
      grid: document.getElementById('gridRef'),
      score: document.getElementById('scoreVal'),
      torp: document.getElementById('torpVal'),
      torpTot: document.getElementById('torpTot'),
      torpFill: document.getElementById('torpFill'),
      msg: document.getElementById('msg'),
      mapCanvas: document.getElementById('mapCanvas'),
    };
    this.mapCtx = this.el.mapCanvas ? this.el.mapCanvas.getContext('2d') : null;
    if (this.el.speedLbl) this.el.speedLbl.textContent = 'Sea speed';
    if (this.el.speedUnit) this.el.speedUnit.textContent = 'kn';
    if (this.el.ammoLbl) this.el.ammoLbl.innerHTML = 'Main battery &mdash; 127 mm';
    this.telegraphIdx = 4;
  }

  _buildCompass() {
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let html = '';
    for (let c = 0; c < 3; c++) {
      for (const n of names) {
        html += `<span class="${n.length === 1 ? 'card' : ''}">${n}</span>`;
      }
    }
    if (this.el.compass) this.el.compass.innerHTML = html;
  }

  flashMessage(text, sticky = false) {
    if (this.el.msg) {
      this.el.msg.textContent = text;
      this.el.msg.classList.add('on');
    }
    this.msgTimer = sticky ? 9999 : 2.2;
  }

  addScore(pts, label, crit) {
    this.score += pts;
    if (this.el.score) this.el.score.textContent = this.score;
    if (label) {
      this.flashMessage(crit ? `CRITICAL HIT: ${label} +${pts}` : `HIT: ${label} +${pts}`);
    }
  }

  // ------------------------------------------------------------------ input
  onKey(code) {
    if (!this.running) return;
    if (code === 'KeyW' || code === 'ArrowUp') {
      this.telegraphIdx = Math.min(TELEGRAPH.length - 1, this.telegraphIdx + 1);
      this.player.throttle = TELEGRAPH[this.telegraphIdx].v;
    } else if (code === 'KeyS' || code === 'ArrowDown') {
      this.telegraphIdx = Math.max(0, this.telegraphIdx - 1);
      this.player.throttle = TELEGRAPH[this.telegraphIdx].v;
    } else if (code === 'Space') {
      this.telegraphIdx = 3;
      this.player.throttle = 0;
    } else if (code === 'KeyT') {
      this.tryTorpedoes();
    } else if (code === 'Enter' && this.playerSunk) {
      this.respawn();
    }
  }

  readHeld() {
    if (this.playerSunk) { this.player.rudder = 0; return; }
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    this.player.rudder = left && !right ? 1 : right && !left ? -1 : 0;
  }

  onMouseDown(button) {
    if (!this.running) return;
    if (button === 0) this.trySalvo();
    else if (button === 2) this.tryTorpedoes();
  }

  onWheel(dy) {
    this.cam.dist = clamp(this.cam.dist + Math.sign(dy) * 26, 90, 560);
  }

  onPointer(x, y) {
    this.pointer.x = x;
    this.pointer.y = y;
  }

  trySalvo() {
    if (!this.player.alive) return;
    if (this.player.gunReload > 0) {
      this.el.crosshair.classList.add('reloading');
      return;
    }
    const total = this.player.turrets.length;
    const ready = this.player.turretsReady;
    const shots = this.player.fireSalvo();
    if (!shots) {
      // no turret on target yet: say so, in numbers, not jargon
      this.flashMessage(`MAIN GUNS TRAINING — ${ready}/${total} TURRETS ON TARGET`);
      return;
    }
    if (ready < total) {
      this.flashMessage(`PARTIAL SALVO — ${shots.length / 2 | 0}/${total} TURRETS FIRED`);
    }
    for (const s of shots) {
      this.spawnShell(s.pos, s.dir, this.player.spec.shellSpeed, true);
    }
    this.fx.shake = Math.min(1, this.fx.shake + 0.22);
  }

  tryTorpedoes() {
    if (!this.player.alive) return;
    const launches = this.player.fireTorpedoes(this._aimYaw());
    if (!launches) return;
    for (const l of launches) this.spawnTorp(l);
    this.flashMessage('TORPEDOES AWAY');
  }

  _aimYaw() {
    const dx = this.aimPoint.x - this.player.pos.x;
    const dz = this.aimPoint.z - this.player.pos.z;
    return Math.atan2(-dx, -dz);
  }

  // ------------------------------------------------------------------ spawn
  spawnEnemy(typeKey, sx, sz, fleet = null) {
    const type = typeKey || (Math.random() < 0.72 ? 'destroyer' : 'cruiser');
    let x = sx, z = sz;
    if (x === undefined) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const a = Math.random() * Math.PI * 2;
        const r = 2300 + Math.random() * 1100;
        x = this.player.pos.x + Math.cos(a) * r;
        z = this.player.pos.z + Math.sin(a) * r;
        if (Math.hypot(x, z) > NAVAL_PLAY_RADIUS - 350) continue;
        if (navalHeightAt(x, z) > -26) break;
        x = undefined;
      }
      if (x === undefined) return null;
    }

    const e = new Ship(this.scene, type, { fx: this.fx, sea: this.sea, spec: enemySpec(SHIP_SPECS[type]) });
    e.pos.set(x, WATER_LEVEL, z);
    e.yaw = Math.random() * Math.PI * 2;
    e.ai = {
      state: 'approach', timer: 0, desiredYaw: e.yaw, throttle: 1,
      aim: new THREE.Vector3(x, WATER_LEVEL, z),
      scatter: new THREE.Vector3(), scatterT: 0,
      torpCd: 45 + Math.random() * 40,
      skill: 0.45 + Math.random() * 0.35,
      fleet, role: fleet ? (type === 'cruiser' ? 'leader' : 'escort') : 'solo',
      slot: Math.random() * Math.PI * 2,
      torpRun: 0,
      edge: false,   // committed to an inward turn at the play-area rim
    };
    if (fleet) fleet.ships.push(e);
    this.enemies.push(e);
    return e;
  }

  /** An enemy fleet: one cruiser with a screen of five destroyers around it. */
  spawnFleet() {
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1900 + Math.random() * 1000;
      const x = this.player.pos.x + Math.cos(a) * r;
      const z = this.player.pos.z + Math.sin(a) * r;
      if (Math.hypot(x, z) > NAVAL_PLAY_RADIUS - 800) continue;
      if (navalHeightAt(x, z) > -30) continue;

      const fleet = { ships: [], leader: null };
      const c = this.spawnEnemy('cruiser', x, z, fleet);
      if (!c) return null;
      fleet.leader = c;
      c.yaw = Math.atan2(-(this.player.pos.x - x), -(this.player.pos.z - z));

      // five destroyers in a protective ring around the cruiser
      let escorts = 0;
      for (let i = 0; i < 5; i++) {
        const sa = (i / 5) * Math.PI * 2;
        // keep trying angles/radii until the slot is on deep water inside the
        // boundary — every fleet ships with a full screen of five
        for (let k = 0; k < 14; k++) {
          const jitter = sa + (Math.random() - 0.5) * (k < 7 ? 0.4 : 1.4);
          const sr = 150 + Math.random() * 150;
          const ex = x + Math.cos(jitter) * sr;
          const ez = z + Math.sin(jitter) * sr;
          if (navalHeightAt(ex, ez) > -20) continue;
          if (Math.hypot(ex, ez) > NAVAL_PLAY_RADIUS - 400) continue;
          const d = this.spawnEnemy('destroyer', ex, ez, fleet);
          if (d) {
            d.yaw = c.yaw;
            d.ai.slot = jitter;   // remember which sector of the screen it holds
            escorts++;
          }
          break;
        }
      }
      // last resort for any slot that never found water: tight alongside
      while (escorts < 5) {
        const da = Math.random() * Math.PI * 2;
        const d = this.spawnEnemy('destroyer', x + Math.cos(da) * 90, z + Math.sin(da) * 90, fleet);
        if (!d) break;
        d.yaw = c.yaw;
        d.ai.slot = da;
        escorts++;
      }
      return c;
    }
    return null;
  }

  spawnShell(pos, dir, speed, fromPlayer) {
    const s = this.shells.find((x) => !x.alive);
    if (!s) return;
    s.alive = true;
    s.life = 9;
    s.fromPlayer = fromPlayer;
    s.puffT = 0;
    s.pos.copy(pos);
    s.prev.copy(pos);
    s.vel.copy(dir).multiplyScalar(speed);
    s.mesh.visible = true;
    s.mesh.position.copy(pos);
    s.mesh.quaternion.setFromUnitVectors(AXIS_Z, dir);
  }

  spawnTorp(l) {
    const t = this.torps.find((x) => !x.alive);
    if (!t) return;
    t.alive = true;
    t.travelled = 0;
    t.range = l.range;
    t.yaw = l.yaw;
    t.speed = l.speed;
    t.owner = l.owner;
    t.armed = false;
    t.bubbleT = 0;
    t.pos.set(l.x, WATER_LEVEL - 0.75, l.z);
    t.mesh.visible = true;
    t.mesh.rotation.y = t.yaw;
  }

  // ------------------------------------------------------------------ frame
  frame(dt) {
    this.elapsed += dt;
    this.frameCount++;

    this.readHeld();

    // ---- player ----
    const p = this.player;
    p.updateReloads(dt);
    if (!p.sinking) {
      this._boundary(p, dt);
      this._grounding(p, dt);
    }
    p.step(dt, this.sea);

    if (p.sinking && !this.playerSunk && p.sinkT > 0.1) {
      this.playerSunk = true;
      this.flashMessage('SHIP LOST — PRESS ENTER TO REDEPLOY', true);
      document.getElementById('hud').classList.add('wrecked');
    }

    // ---- enemies ----
    this.updateEnemies(dt);

    // ---- hull-to-hull collisions (matters now ships fight in formation) ----
    const hulls = [this.player, ...this.enemies].filter((s) => !s.sinking && !s.gone);
    for (let i = 0; i < hulls.length; i++) {
      for (let j = i + 1; j < hulls.length; j++) {
        this._shipCollision(hulls[i], hulls[j]);
      }
    }

    // ---- projectiles ----
    this.updateShells(dt);
    this.updateTorps(dt);

    // ---- world ----
    this.aimDist = this.updateAim();
    this.updateCamera(dt);
    p.aimTurrets(this.aimPoint, dt);

    this.sea.update(dt, this.camera, this.elapsed);
    this.fx.update(dt);
    this.sky.position.copy(this.camera.position);

    this.sun.position.copy(p.pos).addScaledVector(SUN_DIR, 500);
    this.sun.target.position.copy(p.pos);
    this.sun.target.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = this.frameCount % 2 === 0;

    this.fx.applyShake(this.camera, this.elapsed);

    this.updateHud(dt);
    this.drawMinimap();

    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------------ aim
  updateAim() {
    this.camera.updateMatrixWorld();
    _v1.set(this.pointer.x, this.pointer.y, 0.5).unproject(this.camera)
      .sub(this.camera.position).normalize();
    const o = this.camera.position;

    let t = 4500;
    if (_v1.y < -0.002) {
      const tw = (WATER_LEVEL - o.y) / _v1.y;
      if (tw > 0 && tw < 9000) t = tw;
    }
    // refine against islands: march the ray, find first terrain crossing
    let lo = 0, hi = t, hitLand = false;
    const steps = 12;
    _v2.copy(o).addScaledVector(_v1, hi);
    for (let i = 1; i <= steps; i++) {
      const m = (i / steps) * hi;
      _v3.copy(o).addScaledVector(_v1, m);
      if (navalHeightAt(_v3.x, _v3.z) > _v3.y) {
        hitLand = true;
        lo = ((i - 1) / steps) * hi;
        hi = m;
        break;
      }
    }
    if (hitLand) {
      for (let i = 0; i < 10; i++) {
        const m = (lo + hi) * 0.5;
        _v3.copy(o).addScaledVector(_v1, m);
        if (navalHeightAt(_v3.x, _v3.z) > _v3.y) hi = m;
        else lo = m;
      }
      t = hi;
    }

    this.aimPoint.copy(o).addScaledVector(_v1, t);
    if (hitLand) this.aimPoint.y = navalHeightAt(this.aimPoint.x, this.aimPoint.z);

    // lock-on: is an enemy hull under the cursor?
    this.locked = this.pickEnemyUnderCursor();
    if (this.locked) {
      this.aimPoint.copy(this.locked.pos);
      this.aimPoint.y += 3;
      return this.aimPoint.distanceTo(this.player.pos);
    }
    return this.aimPoint.distanceTo(this.player.pos);
  }

  pickEnemyUnderCursor() {
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect || 1;
    let best = null;
    let bestScore = 1;
    for (const e of this.enemies) {
      if (e.sinking || e.gone) continue;
      _v4.copy(e.pos);
      _v4.y += 4;
      const d = _v4.distanceTo(this.camera.position);
      if (d > 5200) continue;
      _pv.copy(_v4);
      _v4.project(this.camera);
      if (_v4.z > 1) continue;

      const halfH = Math.max(0.001, d * tanHalf);
      const rx = (e.spec.length * 0.42) / (halfH * aspect);
      const ry = 9 / halfH;
      const nx = (_v4.x - this.pointer.x) / rx;
      const ny = (_v4.y - this.pointer.y) / ry;
      const score = nx * nx + ny * ny;
      if (score < bestScore && this._losClear(this.camera.position, _pv, d)) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  _losClear(a, b, dist) {
    const steps = Math.max(3, Math.min(9, Math.ceil(dist / 350)));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t;
      if (navalHeightAt(x, z) > y) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ camera
  updateCamera(dt, instant = false) {
    const p = this.player;
    if (instant) this.cam.yaw = p.yaw;
    else {
      const delta = wrapAngle(p.yaw - this.cam.yaw);
      this.cam.yaw = wrapAngle(this.cam.yaw + delta * (1 - Math.exp(-dt * 2.6)));
    }
    const cp = Math.cos(this.cam.pitch);
    const sp = Math.sin(this.cam.pitch);
    _v1.set(p.pos.x, p.pos.y + 14, p.pos.z);
    _v2.set(
      Math.sin(this.cam.yaw) * cp,
      sp,
      Math.cos(this.cam.yaw) * cp,
    ).multiplyScalar(this.cam.dist).add(_v1);

    const minY = this.sea.surfaceHeight(_v2.x, _v2.z) + 7;
    if (_v2.y < minY) _v2.y = minY;

    if (instant) this.camera.position.copy(_v2);
    else this.camera.position.lerp(_v2, 1 - Math.exp(-dt * 6));

    p.forward(_v3);
    _v4.set(_v1.x + _v3.x * 45, _v1.y + 2, _v1.z + _v3.z * 45);
    this.camera.lookAt(_v4);
  }

  // ------------------------------------------------------------------ AI
  updateEnemies(dt) {
    const p = this.player;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.gone) {
        e.dispose();
        this.enemies.splice(i, 1);
        continue;
      }
      if (e.sinking) { e.step(dt, this.sea); continue; }

      const dx = p.pos.x - e.pos.x;
      const dz = p.pos.z - e.pos.z;
      const dist = Math.hypot(dx, dz);
      e.dist = dist;
      const bearingToPlayer = Math.atan2(-dx, -dz);

      // ---- replan ----
      e.ai.timer -= dt;
      if (e.ai.timer <= 0) {
        e.ai.timer = 0.45;
        const leader = e.ai.fleet && e.ai.fleet.leader && !e.ai.fleet.leader.gone
          ? e.ai.fleet.leader : null;
        if (!p.alive) {
          e.ai.state = 'idle';
          e.ai.throttle = 0.4;
          e.ai.desiredYaw = e.yaw + Math.sin(this.elapsed * 0.1 + e.pos.x) * 0.4;
        } else if (e.hp < e.maxHp * 0.22 && dist < 2400) {
          e.ai.state = 'retreat';
          e.ai.throttle = 1;
          e.ai.desiredYaw = bearingToPlayer + Math.PI + (Math.random() - 0.5) * 0.5;
        } else if (e.ai.role === 'escort' && leader && dist > 2600) {
          // player not yet a threat: hold formation around the fleet leader
          e.ai.state = 'escort';
        } else if (dist > 2100) {
          e.ai.state = 'approach';
          e.ai.throttle = 1;
          e.ai.desiredYaw = bearingToPlayer + (Math.random() - 0.5) * 0.35;
        } else if (
          e.spec.torps && e.ai.torpRun > 0 && dist > 500 &&
          Math.abs(wrapAngle(bearingToPlayer - e.yaw)) < 1.1
        ) {
          // committed torpedo run: charge straight in until the tubes bear
          e.ai.state = 'torpedorun';
          e.ai.throttle = 1;
          e.ai.desiredYaw = bearingToPlayer;
        } else {
          e.ai.state = 'battle';
          e.ai.throttle = 0.82;
          const band = dist < 1100 ? Math.PI : Math.PI / 2;  // open range / broadside
          const side = e.ai.broadsideSide || (e.ai.broadsideSide = Math.random() < 0.5 ? 1 : -1);
          e.ai.desiredYaw = bearingToPlayer + band * side;
        }
      }

      // ---- escort steering: keep station on the fleet leader ----
      if (e.ai.state === 'escort') {
        const leader = e.ai.fleet.leader;
        if (leader && !leader.gone) {
          const slotYaw = leader.yaw + e.ai.slot;
          const ring = e.spec.length * 2 + 120;
          const tx = leader.pos.x + Math.sin(slotYaw) * ring;
          const tz = leader.pos.z + Math.cos(slotYaw) * ring;
          const toX = tx - e.pos.x, toZ = tz - e.pos.z;
          const toD = Math.hypot(toX, toZ);
          if (toD > 30) e.ai.desiredYaw = Math.atan2(-toX, -toZ);
          // match the leader's speed so the screen holds together
          e.ai.throttle = clamp(toD / 220 + Math.abs(leader.speed) / leader.spec.maxSpeed, 0.3, 1);
        } else {
          e.ai.state = 'approach';
        }
      }

      // ---- play-area edge: commit to an inward turn BEFORE the boundary ----
      // Distance-based trigger, not heading-based: a tangential drifter with
      // barely-outward heading used to creep all the way to the hard clamp
      // before turning. Anything not already solidly inbound commits now.
      const dOrigin = Math.hypot(e.pos.x, e.pos.z);
      const outward = _v3.x * (e.pos.x / (dOrigin || 1)) + _v3.z * (e.pos.z / (dOrigin || 1));
      if (!e.ai.edge && dOrigin > NAVAL_PLAY_RADIUS - 900 && outward > -0.25) {
        e.ai.edge = true;
      }
      if (e.ai.edge) {
        if (dOrigin < NAVAL_PLAY_RADIUS - 1600) {
          e.ai.edge = false;
        } else {
          // steer at a waypoint 1100 m inward, biased toward the player so
          // ships curve back into the fight rather than circling the rim
          const inR = Math.max(0, dOrigin - 1100);
          const wx = (e.pos.x / (dOrigin || 1)) * inR + (p.pos.x - e.pos.x) * 0.3;
          const wz = (e.pos.z / (dOrigin || 1)) * inR + (p.pos.z - e.pos.z) * 0.3;
          e.ai.desiredYaw = Math.atan2(-(wx - e.pos.x), -(wz - e.pos.z));
          e.ai.throttle = Math.min(e.ai.throttle, 0.9);
        }
      }

      // ---- torpedo evasion ----
      for (const tp of this.torps) {
        if (!tp.alive || tp.owner === e) continue;
        const tdx = e.pos.x - tp.pos.x;
        const tdz = e.pos.z - tp.pos.z;
        const td = Math.hypot(tdx, tdz);
        if (td > 420) continue;
        const tdirx = -Math.sin(tp.yaw), tdirz = -Math.cos(tp.yaw);
        if ((tdx * tdirx + tdz * tdirz) / Math.max(1, td) > 0.75) {
          // closing: turn perpendicular to the torpedo track
          e.ai.desiredYaw = tp.yaw + Math.PI / 2 * (e.ai.broadsideSide || 1);
          e.ai.throttle = 1;
          break;
        }
      }

      // ---- island avoidance: ships never enter shallow water ----
      // Fans probes out around the hull and steers for the deepest channel.
      // A commitment timer keeps the chosen channel locked in so ships don't
      // dither along shorelines; this outranks every other steering want.
      e.forward(_v3);
      e.ai.avoidT = (e.ai.avoidT || 0) - dt;
      const lookD = 380 + Math.abs(e.speed) * 26;   // sees farther at speed
      const ahead = navalHeightAt(
        e.pos.x - _v3.x * lookD, e.pos.z - _v3.z * lookD,
      );
      if (ahead > -16) e.ai.avoidT = 2.4;           // shallow straight ahead?
      if (e.ai.avoidT > 0) {
        let bestScore = -Infinity;
        for (const off of [-1.3, -0.8, -0.4, 0, 0.4, 0.8, 1.3]) {
          const py = e.yaw + off;
          const dxp = -Math.sin(py), dzp = -Math.cos(py);
          let depth = Infinity;                     // shallowest point on ray
          for (const k of [0.25, 0.55, 1, 1.6]) {
            const h = navalHeightAt(e.pos.x + dxp * lookD * k, e.pos.z + dzp * lookD * k);
            if (h < depth) depth = h;
          }
          // near-ties prefer the heading the AI already wants, so avoidance
          // bends the route instead of replacing it
          const pref = -Math.abs(wrapAngle(e.ai.desiredYaw - py)) * 5;
          const score = depth + pref;
          if (score > bestScore) { bestScore = score; e.ai.desiredYaw = py; }
        }
        e.ai.throttle = Math.min(e.ai.throttle, ahead > -9 ? 0.4 : 0.75);
      }

      // ---- steering ----
      const err = wrapAngle(e.ai.desiredYaw - e.yaw);
      // an edge turn gets full-hard rudder so it answers immediately
      e.rudder = clamp(err * (e.ai.edge ? 3.0 : 1.7), -1, 1);
      e.throttle = e.ai.throttle;

      e.updateReloads(dt);
      e.step(dt, this.sea);
      this._boundary(e, dt);
      this._grounding(e, dt, true);

      // ---- torpedo runs: destroyers commit when tubes are ready ----
      if (e.spec.torps && e.ai.torpRun <= 0 && e.ai.torpCd < 8 && dist < 2600 && dist > 900) {
        e.ai.torpRun = 1;
      }

      // ---- gunnery ----
      e.ai.scatterT -= dt;
      if (e.ai.scatterT <= 0) {
        e.ai.scatterT = 2.5;
        // better bots scatter less: skill tightens the dispersion
        const rad = 40 + dist * 0.085 * (1.25 - e.ai.skill);
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * rad;
        e.ai.scatter.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
      }
      const tof = dist / e.spec.shellSpeed;
      // full lead prediction scaled by skill (was a flat 0.8 guess)
      const lead = 0.55 + 0.45 * e.ai.skill;
      e.ai.aim.copy(p.pos).addScaledVector(p.forward(_v3), p.speed * tof * lead);
      e.ai.aim.y += 2;
      if (!p.alive) e.ai.aim.copy(e.pos).addScaledVector(e.forward(_v3), 800).setY(WATER_LEVEL);
      e.ai.aim.add(e.ai.scatter);
      e.aimTurrets(e.ai.aim, dt);

      if (
        p.alive && e.gunReload <= 0 && dist < e.spec.range && dist > 60 &&
        e.turretsReady >= Math.ceil(e.turrets.length * 0.75) &&
        this._losClear(_v1.copy(e.pos).setY(e.pos.y + 10), _v2.copy(p.pos).setY(p.pos.y + 6), dist)
      ) {
        const shots = e.fireSalvo();
        if (shots) {
          for (const s of shots) this.spawnShell(s.pos, s.dir, e.spec.shellSpeed, false);
          // minimum reload floor: enemy guns stay leisurely no matter the spec
          e.gunReload = Math.max(e.gunReload, 9 + Math.random() * 6);
        }
      }

      // ---- enemy torpedoes (destroyers, on torpedo runs or close aboard) ----
      e.ai.torpCd -= dt;
      if (e.spec.torps && p.alive && e.ai.torpCd <= 0 && dist < 1600) {
        const broadside = Math.abs(Math.abs(wrapAngle(bearingToPlayer - e.yaw)) - Math.PI / 2) < 0.8;
        const bowed = Math.abs(wrapAngle(bearingToPlayer - e.yaw)) < 0.45;
        if (broadside || (bowed && e.ai.torpRun > 0)) {
          const leadT = dist / e.spec.torps.speed;
          const aimX = p.pos.x + p.forward(_v3).x * p.speed * leadT;
          const aimZ = p.pos.z + _v3.z * p.speed * leadT;
          const launches = e.fireTorpedoes(Math.atan2(-(aimX - e.pos.x), -(aimZ - e.pos.z)));
          if (launches) {
            for (const l of launches) this.spawnTorp(l);
            e.ai.torpCd = 120 + Math.random() * 60;
            e.ai.torpRun = 0;
            // snap off a retreat turn after launching
            e.ai.broadsideSide = e.ai.broadsideSide || 1;
            e.ai.state = 'battle';
            e.ai.timer = 0;
          }
        }
      }
    }

    // keep the fight populated: always keep several full fleets at sea
    this.spawnTimer -= dt;
    const aliveCount = this.enemies.filter((e) => !e.sinking).length;
    if (this.spawnTimer <= 0 && aliveCount < 10 && this.enemies.length < 13) {
      this.spawnTimer = 22;
      if (!this.spawnFleet()) this.spawnTimer = 6;
    }
  }

  // ------------------------------------------------------------------ shells
  updateShells(dt) {
    for (const s of this.shells) {
      if (!s.alive) continue;
      s.life -= dt;
      s.prev.copy(s.pos);
      s.vel.y -= GRAV * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.mesh.position.copy(s.pos);
      s.mesh.quaternion.setFromUnitVectors(AXIS_Z, _v1.copy(s.vel).normalize());

      // faint smoke puffs tracing the arc
      s.puffT -= dt;
      if (s.puffT <= 0) {
        s.puffT = 0.12;
        this.fx.pSmoke.emit(
          s.pos.x, s.pos.y, s.pos.z,
          0, 0.5, 0,
          0.8, 0.8, 0.78,
          0.5, 0.55, 0.2, 1.2, 1.2,
        );
      }

      // ---- ship hits (swept segment) ----
      let hit = null;
      let hitShip = null;
      if (s.fromPlayer) {
        for (const e of this.enemies) {
          if (e.sinking || e.gone) continue;
          const res = e.checkHit(s.prev, s.pos);
          if (res) { hit = res; hitShip = e; break; }
        }
      } else if (this.player.alive) {
        const res = this.player.checkHit(s.prev, s.pos);
        if (res) { hit = res; hitShip = this.player; }
      }
      if (hit && hitShip) {
        s.alive = false;
        s.mesh.visible = false;
        this._resolveShellHit(s, hitShip, hit);
        continue;
      }

      // ---- water ----
      const wl = this.sea.surfaceHeight(s.pos.x, s.pos.z);
      if (s.pos.y <= wl) {
        s.alive = false;
        s.mesh.visible = false;
        _v1.set(s.pos.x, wl, s.pos.z);
        let scale = 1;
        // near miss? drench the nearest hull with a taller column
        for (const e of this.enemies) {
          if (e.sinking) continue;
          if (Math.hypot(e.pos.x - s.pos.x, e.pos.z - s.pos.z) < 90) {
            scale = 1.5;
            e.flash = 0.1;
            break;
          }
        }
        this.fx.splash(_v1, scale);
        continue;
      }

      // ---- island ----
      if (s.pos.y <= navalHeightAt(s.pos.x, s.pos.z)) {
        s.alive = false;
        s.mesh.visible = false;
        _v1.copy(s.pos);
        _v1.y += 1;
        this.fx.explosion(_v1, 0.8);
        continue;
      }

      if (s.life <= 0) {
        s.alive = false;
        s.mesh.visible = false;
      }
    }
  }

  _resolveShellHit(s, ship, hit) {
    const shooterSpec = s.fromPlayer ? this.player.spec : ship === this.player ? null : null;
    // damage: shooter's shell stats (enemy shells use their own spec)
    let dmg;
    if (s.fromPlayer) {
      const sp = this.player.spec;
      dmg = sp.shellDamage[0] + Math.random() * (sp.shellDamage[1] - sp.shellDamage[0]);
    } else {
      dmg = 55 + Math.random() * 55;
    }
    let crit = false;
    let pts = hit.points;
    if (hit.module === 'magazine' && Math.random() < hit.critChance) {
      crit = true;
      dmg *= 2.6;
      pts = 1500;
    }
    dmg *= hit.mult;

    this.fx.explosion(hit.point, 1.15);

    const killed = ship.takeDamage(dmg, hit.module);

    if (ship === this.player) {
      this.fx.shake = Math.min(1.2, this.fx.shake + 0.35);
      this.flashMessage(crit ? 'MAGAZINE HIT — HEAVY DAMAGE' : `HULL HIT — ${hit.module.toUpperCase()}`);
    } else {
      this.addScore(pts, crit ? 'MAGAZINE' : hit.module, crit);
      if (killed) {
        this.addScore(1500, null);
        this.flashMessage(`ENEMY ${ship.spec.name} SUNK  +1500`);
      }
    }
  }

  // ------------------------------------------------------------------ torps
  updateTorps(dt) {
    for (const t of this.torps) {
      if (!t.alive) continue;
      t.travelled += t.speed * dt;
      t.pos.x += -Math.sin(t.yaw) * t.speed * dt;
      t.pos.z += -Math.cos(t.yaw) * t.speed * dt;
      t.pos.y = this.sea.surfaceHeight(t.pos.x, t.pos.z) - 0.75;
      t.mesh.position.copy(t.pos);
      if (!t.armed && t.travelled > 60) t.armed = true;

      // bubble wake
      t.bubbleT -= dt;
      if (t.bubbleT <= 0) {
        t.bubbleT = 0.09;
        this.fx.pSmoke.emit(
          t.pos.x + (Math.random() - 0.5), this.sea.surfaceHeight(t.pos.x, t.pos.z) - 0.1, t.pos.z + (Math.random() - 0.5),
          (Math.random() - 0.5) * 1.5, 0.8 + Math.random() * 1.4, (Math.random() - 0.5) * 1.5,
          0.88, 0.94, 1.0,
          0.7 + Math.random() * 0.9, 0.9 + Math.random() * 0.7,
          -1.5, 1.2, 1.4,
        );
      }

      // ---- ship hits ----
      if (t.armed) {
        _v1.copy(t.pos).addScaledVector(_v2.set(-Math.sin(t.yaw), 0, -Math.cos(t.yaw)), t.speed * dt);
        let hitShip = null;
        let hit = null;
        if (t.owner !== this.player && this.player.alive) {
          hit = this.player.checkHit(t.pos, _v1);
          if (hit) hitShip = this.player;
        }
        if (!hitShip) {
          for (const e of this.enemies) {
            if (e === t.owner || e.sinking || e.gone) continue;
            const res = e.checkHit(t.pos, _v1);
            if (res) { hit = res; hitShip = e; break; }
          }
        }
        if (hitShip) {
          t.alive = false;
          t.mesh.visible = false;
          this.fx.explosion(hit.point, 2.8);
          this.fx.splash(_v3.copy(hit.point).setY(WATER_LEVEL), 2.6);
          const dmg = hitShip === this.player ? 2200 : 5200;
          const killed = hitShip.takeDamage(dmg, 'hull');
          if (hitShip === this.player) {
            this.flashMessage('TORPEDO HIT — FLOODING!', true);
            this.fx.shake = Math.min(1.4, this.fx.shake + 0.8);
          } else {
            this.addScore(600, 'TORPEDO', true);
            if (killed) {
              this.addScore(1500, null);
              this.flashMessage(`ENEMY ${hitShip.spec.name} SUNK  +1500`);
            }
          }
          continue;
        }
      }

      // ---- island / range ----
      if (navalHeightAt(t.pos.x, t.pos.z) > -7) {
        t.alive = false;
        t.mesh.visible = false;
        _v1.copy(t.pos).setY(WATER_LEVEL);
        this.fx.splash(_v1, 1.8);
        continue;
      }
      if (t.travelled > t.range) {
        t.alive = false;
        t.mesh.visible = false;
      }
    }
  }

  // ------------------------------------------------------------------ world
  _boundary(ship, dt) {
    const d = Math.hypot(ship.pos.x, ship.pos.z);
    if (d > NAVAL_PLAY_RADIUS) {
      const s = NAVAL_PLAY_RADIUS / d;
      ship.pos.x *= s;
      ship.pos.z *= s;
      ship.speed *= 0.985;
      // anything that touches the hard clamp turns back in immediately
      if (ship.ai && !ship.sinking) ship.ai.edge = true;
      if (ship === this.player && this.frameCount % 60 === 0) {
        this.flashMessage('BATTLE BOUNDARY — COME ABOUT');
      }
    } else if (ship === this.player && d > NAVAL_PLAY_RADIUS - 300 && this.frameCount % 90 === 0) {
      this.flashMessage('APPROACHING BATTLE BOUNDARY');
    }
  }

  _grounding(ship, dt, silent = false) {
    const spec = ship.spec;
    ship.forward(_v3);
    const bx = ship.pos.x + _v3.x * spec.length * 0.45;
    const bz = ship.pos.z + _v3.z * spec.length * 0.45;
    const hBow = navalHeightAt(bx, bz);
    const hHere = navalHeightAt(ship.pos.x, ship.pos.z);
    if (hBow > -7 || hHere > -6) {
      // scrape to a stop and shove off toward deeper water
      ship.speed *= Math.max(0, 1 - dt * 2.4);
      let gx = navalHeightAt(ship.pos.x + 8, ship.pos.z) - navalHeightAt(ship.pos.x - 8, ship.pos.z);
      let gz = navalHeightAt(ship.pos.x, ship.pos.z + 8) - navalHeightAt(ship.pos.x, ship.pos.z - 8);
      const gl = Math.hypot(gx, gz) || 1;
      ship.pos.x -= (gx / gl) * 9 * dt;
      ship.pos.z -= (gz / gl) * 9 * dt;
      if (!silent) {
        this.groundCd -= dt;
        if (this.groundCd <= 0) {
          this.groundCd = 4.0;
          ship.takeDamage(60, 'hull');
          this.flashMessage('GROUNDING! BACK ENGINES');
          this.fx.splash(_v1.set(bx, WATER_LEVEL, bz), 1.2);
        }
      }
    }
  }

  _shipCollision(a, b) {
    const dx = b.pos.x - a.pos.x;
    const dz = b.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    const minD = (a.spec.length + b.spec.length) * 0.23;
    if (d > minD || d < 0.01) return;
    const nx = dx / d, nz = dz / d;
    const push = (minD - d) * 0.5;
    a.pos.x -= nx * push; a.pos.z -= nz * push;
    b.pos.x += nx * push; b.pos.z += nz * push;
    const impact = Math.abs(a.speed) + Math.abs(b.speed);
    if (impact > 4) {
      a.speed *= 0.4; b.speed *= 0.4;
      _v1.set((a.pos.x + b.pos.x) / 2, WATER_LEVEL, (a.pos.z + b.pos.z) / 2);
      this.fx.splash(_v1, 1.4);
      if (a === this.player || b === this.player) {
        this.flashMessage('COLLISION!');
        this.fx.shake = Math.min(1, this.fx.shake + 0.4);
      }
    }
  }

  // ------------------------------------------------------------------ HUD
  updateHud(dt) {
    // crosshair follows the cursor every frame
    const px = (this.pointer.x * 0.5 + 0.5) * window.innerWidth;
    const py = (-this.pointer.y * 0.5 + 0.5) * window.innerHeight;
    if (this.el.crosshair) {
      this.el.crosshair.style.left = `${px}px`;
      this.el.crosshair.style.top = `${py}px`;
      this.el.crosshair.classList.toggle('onTarget', !!this.locked);
      this.el.crosshair.classList.toggle('reloading', this.player.gunReload > 0);
      this.el.crosshair.classList.toggle(
        'training',
        this.player.gunReload <= 0 && this.player.turretsReady < this.player.turrets.length,
      );
    }
    if (this.el.range) {
      this.el.range.style.left = `${px}px`;
      this.el.range.style.top = `${py + 52}px`;
      this.el.range.textContent = this.locked
        ? `TARGET ${this.locked.spec.name} ${Math.round(this.aimDist)} m`
        : `${Math.round(this.aimDist)} m`;
    }

    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0 && this.el.msg) this.el.msg.classList.remove('on');
    }

    this.hudAcc += dt;
    if (this.hudAcc < 0.06 || !this.el.speed) return;
    this.hudAcc = 0;
    const p = this.player;

    this.el.speed.textContent = p.speedKnots.toFixed(1);
    this.el.gear.textContent = TELEGRAPH[this.telegraphIdx].label;
    if (this.el.rudder) {
      const r = p.rudderAngle;
      const deg = Math.round(Math.abs(r) * 35);
      this.el.rudder.textContent = deg < 2 ? 'RUDDER AMIDSHIPS'
        : `${r > 0 ? '\u25C0\u25C0' : '\u25B6\u25B6'} ${deg}\u00B0`;
    }

    this.el.ammo.textContent = p.gunReload > 0 ? p.gunReload.toFixed(1) : 'READY';
    this.el.reload.style.width = `${(1 - p.gunReload / p.spec.reload) * 100}%`;
    this.el.health.style.width = `${(p.hp / p.maxHp) * 100}%`;

    if (this.el.torp) {
      this.el.torp.textContent = p.torpSalvos;
      this.el.torpFill.style.width = p.torpSalvos >= 2 ? '100%'
        : p.torpReload > 0 ? `${(1 - p.torpReload / p.spec.torps.reload) * 100}%` : '100%';
    }

    // compass + grid
    const heading = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const perDeg = 272 / 360;
    this.el.compass.style.transform = `translateX(${170 - 272 - heading * perDeg}px)`;
    const gx = clamp(Math.round((p.pos.x + NAVAL_HALF) / (NAVAL_HALF * 2 / 26)), 0, 25);
    const gz = clamp(Math.round((NAVAL_HALF - p.pos.z) / (NAVAL_HALF * 2 / 26)), 0, 25);
    this.el.grid.textContent = `${String.fromCharCode(65 + gx)}${gz}`;
  }

  drawMinimap() {
    if (!this.mapBase || !this.mapCtx || !this._mapVisible()) return;
    const ctx = this.mapCtx;
    const S = 180;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this.mapBase, 0, 0);

    const toMap = (x, z) => [
      ((x + NAVAL_HALF) / (NAVAL_HALF * 2)) * S,
      ((z + NAVAL_HALF) / (NAVAL_HALF * 2)) * S,
    ];

    // boundary
    const [cx, cz] = toMap(0, 0);
    ctx.strokeStyle = 'rgba(255,181,69,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cz, (NAVAL_PLAY_RADIUS / (NAVAL_HALF * 2)) * S, 0, Math.PI * 2);
    ctx.stroke();

    // torpedoes
    ctx.fillStyle = 'rgba(120,220,235,0.9)';
    for (const t of this.torps) {
      if (!t.alive) continue;
      const [tx, tz] = toMap(t.pos.x, t.pos.z);
      ctx.fillRect(tx - 1, tz - 1, 2, 2);
    }

    // enemies — cruisers as squares, destroyers as triangles, with heading
    for (const e of this.enemies) {
      if (e.gone) continue;
      const [ex, ez] = toMap(e.pos.x, e.pos.z);
      const dead = e.sinking;
      ctx.strokeStyle = dead ? 'rgba(255,120,80,0.4)' : 'rgba(255,80,60,0.95)';
      ctx.fillStyle = dead ? 'rgba(255,120,80,0.5)' : 'rgba(255,80,60,0.95)';
      // heading line uses the same -sin/-cos forward convention as the hulls
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ex, ez);
      ctx.lineTo(ex - Math.sin(e.yaw) * 7, ez - Math.cos(e.yaw) * 7);
      ctx.stroke();

      const hx = -Math.sin(e.yaw), hz = -Math.cos(e.yaw);   // forward unit
      ctx.beginPath();
      if (e.spec.key === 'cruiser') {
        // square, sized for the bigger hull
        ctx.save();
        ctx.translate(ex, ez);
        ctx.rotate(-e.yaw);
        ctx.fillRect(-3, -4, 6, 8);
        ctx.restore();
      } else {
        // triangle pointing along the heading
        ctx.moveTo(ex + hx * 4, ez + hz * 4);
        ctx.lineTo(ex - hx * 3 - hz * 2.6, ez - hz * 3 + hx * 2.6);
        ctx.lineTo(ex - hx * 3 + hz * 2.6, ez - hz * 3 - hx * 2.6);
        ctx.closePath();
        ctx.fill();
      }
    }

    // player
    const p = this.player;
    const [px, pz] = toMap(p.pos.x, p.pos.z);
    ctx.save();
    ctx.translate(px, pz);
    // canvas y grows downward, so the arrow needs -yaw to match the
    // -sin/-cos forward convention used by the ships themselves
    ctx.rotate(-p.yaw);
    ctx.fillStyle = p.alive ? '#ffb545' : 'rgba(255,181,69,0.4)';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _mapVisible() {
    const panel = document.getElementById('mapPanel');
    return panel && !panel.classList.contains('hidden');
  }

  // ------------------------------------------------------------------ misc
  respawn() {
    const p = this.player;
    // find open water near the middle
    let x = 0, z = 300;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 300 + Math.random() * 700;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      if (navalHeightAt(x, z) < -30) break;
    }
    // clear enemies crowding the respawn point
    for (const e of this.enemies) {
      if (Math.hypot(e.pos.x - x, e.pos.z - z) < 1500) e.startSink(true);
    }

    p.hp = p.maxHp;
    p.engineFactor = 1;
    p.sinking = false;
    p.sinkT = 0;
    p.gone = false;
    p.speed = 0;
    p.throttle = 0.3;
    this.telegraphIdx = 4;
    p.torpSalvos = 2;
    p.torpReload = 0;
    p.roll = 0; p.pitch = 0; p.heel = 0;
    p.pos.set(x, WATER_LEVEL, z);
    p.yaw = Math.random() * Math.PI * 2;
    this.playerSunk = false;
    this.msgTimer = 0;
    document.getElementById('hud').classList.remove('wrecked');
    if (this.el.msg) this.el.msg.classList.remove('on');
    this.updateCamera(0.05, true);
    this.flashMessage('REDEPLOYED — FULL AHEAD');
  }

  buy(item) {
    if (item === 'health') {
      if (this.score < 400) return this.flashMessage('INSUFFICIENT SCORE');
      this.score -= 400;
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + 3500);
      if (this.player.hp > 0 && this.player.sinking) {
        // patched up and limping: refloat at reduced strength
        this.player.sinking = false;
        this.player.sinkT = 0;
        this.player.roll *= 0.3;
        this.player.pitch *= 0.3;
        this.playerSunk = false;
        document.getElementById('hud').classList.remove('wrecked');
      }
      this.flashMessage('HULL REPAIR PARTIES AT WORK (+3500)');
    } else if (item === 'dc') {
      if (this.score < 250) return this.flashMessage('INSUFFICIENT SCORE');
      this.score -= 250;
      this.player.engineFactor = Math.min(1, this.player.engineFactor + 0.3);
      this.flashMessage('DAMAGE CONTROL — FIRES OUT, ENGINES RESTORED');
    } else if (item === 'torps') {
      if (this.score < 300) return this.flashMessage('INSUFFICIENT SCORE');
      this.score -= 300;
      this.player.torpSalvos = 2;
      this.player.torpReload = 0;
      this.flashMessage('TORPEDO TUBES RELOADED');
    }
    if (this.el.score) this.el.score.textContent = this.score;
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
