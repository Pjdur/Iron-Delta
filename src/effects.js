import * as THREE from "three";
import { heightAt } from "./terrain.js";

// ---------------------------------------------------------------------------
// Soft round sprite for all particles
// ---------------------------------------------------------------------------
function makeSprite() {
  const S = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.75)");
  g.addColorStop(0.75, "rgba(255,255,255,0.16)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const SPRITE = { tex: null };
function spriteTexture() {
  if (!SPRITE.tex) SPRITE.tex = makeSprite();
  return SPRITE.tex;
}

// ---------------------------------------------------------------------------
// A fixed-capacity pool of GPU points simulated on the CPU.
// ---------------------------------------------------------------------------
class ParticlePool {
  constructor(scene, capacity, blending, gravityScale = 1) {
    this.cap = capacity;
    this.cursor = 0;
    this.gravityScale = gravityScale;

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
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: spriteTexture() } },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        varying float vA;
        varying vec3 vC;
        void main() {
          vA = aAlpha;
          vC = aColor;
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
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.size0[i] = size;
    this.size[i] = size;
    this.grow[i] = grow;
    this.alpha[i] = 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = grav;
    this.drag[i] = drag;
  }

  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
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
// Shells
// ---------------------------------------------------------------------------
class Shell {
  constructor() {
    const g = new THREE.CylinderGeometry(0.09, 0.09, 1.6, 6);
    g.rotateX(Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.alive = false;
    this.life = 0;
  }
}

// ---------------------------------------------------------------------------
// Effects manager
// ---------------------------------------------------------------------------
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.fire = new ParticlePool(scene, 1400, THREE.AdditiveBlending);
    this.smoke = new ParticlePool(scene, 1600, THREE.NormalBlending);

    this.shells = [];
    for (let i = 0; i < 12; i++) {
      const s = new Shell();
      scene.add(s.mesh);
      this.shells.push(s);
    }

    this.flash = new THREE.PointLight(0xffb066, 0, 120, 2);
    this.flash.visible = false;
    scene.add(this.flash);
    this.flashTime = 0;

    this.shake = 0;
    this.onImpact = null; // callback(pos, radius)
  }

  // ---------------------------------------------------------------- shells
  fireShell(pos, dir, speed) {
    const s = this.shells.find((x) => !x.alive) || this.shells[0];
    s.alive = true;
    s.life = 3.2;
    s.pos.copy(pos);
    s.vel.copy(dir).multiplyScalar(speed);
    s.mesh.visible = true;
    s.mesh.position.copy(pos);
    // shell geometry is aligned along +Z
    s.mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      dir.clone().normalize(),
    );
    return s;
  }

  // ------------------------------------------------------------ explosions
  explosion(p, scale = 1) {
    const s = scale;
    // fireball
    for (let i = 0; i < 26; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI;
      const sp = 6 + Math.random() * 26 * s;
      this.fire.emit(
        p.x,
        p.y,
        p.z,
        Math.cos(th) * Math.sin(ph) * sp,
        Math.abs(Math.cos(ph)) * sp * 0.9 + 3,
        Math.sin(th) * Math.sin(ph) * sp,
        1.0,
        0.62 + Math.random() * 0.3,
        0.16,
        (1.4 + Math.random() * 2.6) * s,
        0.35 + Math.random() * 0.55,
        -6,
        2.4,
        0.9,
      );
    }
    // sparks
    for (let i = 0; i < 28; i++) {
      const th = Math.random() * Math.PI * 2;
      const sp = 14 + Math.random() * 45 * s;
      this.fire.emit(
        p.x,
        p.y + 0.4,
        p.z,
        Math.cos(th) * sp,
        4 + Math.random() * 26 * s,
        Math.sin(th) * sp,
        1.0,
        0.85,
        0.45,
        0.35 + Math.random() * 0.5,
        0.5 + Math.random() * 0.7,
        -22,
        0.7,
        0,
      );
    }
    // smoke
    for (let i = 0; i < 30; i++) {
      const th = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 11 * s;
      const g = 0.18 + Math.random() * 0.2;
      this.smoke.emit(
        p.x + (Math.random() - 0.5) * 2,
        p.y + Math.random() * 1.5,
        p.z + (Math.random() - 0.5) * 2,
        Math.cos(th) * sp,
        2 + Math.random() * 7,
        Math.sin(th) * sp,
        g,
        g * 0.96,
        g * 0.9,
        (2.6 + Math.random() * 4.5) * s,
        1.5 + Math.random() * 1.8,
        1.1,
        1.1,
        1.6,
      );
    }
    // mud & debris kicked up
    for (let i = 0; i < 34; i++) {
      const th = Math.random() * Math.PI * 2;
      const sp = 5 + Math.random() * 22 * s;
      this.smoke.emit(
        p.x,
        p.y + 0.3,
        p.z,
        Math.cos(th) * sp,
        8 + Math.random() * 20 * s,
        Math.sin(th) * sp,
        0.2,
        0.15,
        0.1,
        0.5 + Math.random() * 0.9,
        0.8 + Math.random() * 1.1,
        -20,
        0.6,
        0,
      );
    }

    this.flash.position.copy(p);
    this.flash.color.setHex(0xffb066);
    this.flash.intensity = 900 * s;
    this.flash.visible = true;
    this.flashTime = 0.22;

    this.shake = Math.min(1, this.shake + 0.55 * s);
    if (this.onImpact) this.onImpact(p, 7 * s);
  }

  muzzle(pos, dir) {
    for (let i = 0; i < 12; i++) {
      this.fire.emit(
        pos.x,
        pos.y,
        pos.z,
        dir.x * (18 + Math.random() * 26) + (Math.random() - 0.5) * 8,
        dir.y * 20 + (Math.random() - 0.5) * 8,
        dir.z * (18 + Math.random() * 26) + (Math.random() - 0.5) * 8,
        1.0,
        0.75,
        0.35,
        1.4 + Math.random() * 2.2,
        0.16 + Math.random() * 0.18,
        0,
        3.5,
        1.2,
      );
    }
    for (let i = 0; i < 10; i++) {
      const g = 0.42 + Math.random() * 0.2;
      this.smoke.emit(
        pos.x,
        pos.y,
        pos.z,
        dir.x * (4 + Math.random() * 10) + (Math.random() - 0.5) * 5,
        dir.y * 5 + Math.random() * 3,
        dir.z * (4 + Math.random() * 10) + (Math.random() - 0.5) * 5,
        g,
        g,
        g * 0.95,
        1.6 + Math.random() * 2.0,
        0.7 + Math.random() * 0.7,
        1.2,
        2.2,
        2.4,
      );
    }
    this.flash.position.copy(pos).addScaledVector(dir, 2);
    this.flash.color.setHex(0xffd9a0);
    this.flash.intensity = 420;
    this.flash.visible = true;
    this.flashTime = 0.1;
    this.shake = Math.min(1, this.shake + 0.28);
  }

  dust(pos, vel, amount = 2) {
    for (let i = 0; i < amount; i++) {
      const g = 0.33 + Math.random() * 0.16;
      this.smoke.emit(
        pos.x + (Math.random() - 0.5) * 2.4,
        pos.y + 0.2,
        pos.z + (Math.random() - 0.5) * 2.4,
        -vel.x * 0.18 + (Math.random() - 0.5) * 3,
        1.2 + Math.random() * 2.4,
        -vel.z * 0.18 + (Math.random() - 0.5) * 3,
        g,
        g * 0.94,
        g * 0.82,
        1.2 + Math.random() * 2.2,
        0.8 + Math.random() * 1.0,
        1.4,
        1.6,
        2.2,
      );
    }
  }

  muzzleSmall(pos, dir) {
    for (let i = 0; i < 4; i++) {
      this.fire.emit(
        pos.x,
        pos.y,
        pos.z,
        dir.x * 20 + (Math.random() - 0.5) * 4,
        dir.y * 20 + (Math.random() - 0.5) * 4,
        dir.z * 20 + (Math.random() - 0.5) * 4,
        1.0,
        0.78,
        0.4,
        0.5 + Math.random() * 0.4,
        0.07 + Math.random() * 0.05,
        0,
        4,
        0,
      );
    }
  }

  // Burning wreck: flames licking out of the engine deck plus heavy black smoke.
  burn(pos, power = 1) {
    for (let i = 0; i < 2; i++) {
      this.fire.emit(
        pos.x + (Math.random() - 0.5) * 2.3,
        pos.y + Math.random() * 0.7,
        pos.z + (Math.random() - 0.5) * 2.3,
        (Math.random() - 0.5) * 2.4,
        (2.8 + Math.random() * 3.6) * power,
        (Math.random() - 0.5) * 2.4,
        1.0,
        0.5 + Math.random() * 0.28,
        0.1,
        (1.4 + Math.random() * 1.6) * power,
        0.4 + Math.random() * 0.5,
        -1.4,
        1.2,
        2.4,
      );
    }
    if (Math.random() < 0.8) {
      const g = 0.12 + Math.random() * 0.09;
      this.smoke.emit(
        pos.x + (Math.random() - 0.5) * 2.1,
        pos.y + 1.5,
        pos.z + (Math.random() - 0.5) * 2.1,
        (Math.random() - 0.5) * 1.7,
        3.2 + Math.random() * 2.8,
        (Math.random() - 0.5) * 1.7,
        g, g, g * 1.05,
        2.4 + Math.random() * 2.2,
        2.0 + Math.random() * 1.8,
        -0.6,
        0.5,
        3.2,
      );
    }
  }

  // ---------------------------------------------------------------- update
  update(dt, camera) {
    this.fire.update(dt);
    this.smoke.update(dt);

    if (this.flashTime > 0) {
      this.flashTime -= dt;
      this.flash.intensity *= Math.max(0, 1 - dt * 12);
      if (this.flashTime <= 0) {
        this.flash.visible = false;
        this.flash.intensity = 0;
      }
    }

    // shells
    // Inside Effects update(dt) loop for shells:
    for (const s of this.shells) {
      if (!s.alive) continue;
      s.life -= dt;
      s.vel.y -= 12.5 * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.mesh.position.copy(s.pos);
      s.mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        s.vel.clone().normalize(),
      );

      const ground = heightAt(s.pos.x, s.pos.z);

      // Check collision with enemy armor (swept segment test)
      let targetHit = false;
      if (!s.prev) s.prev = new THREE.Vector3();
      s.prev.copy(s.pos).addScaledVector(s.vel, -dt);
      const game = window.__game;
      if (game && game.hitTest) {
        const res = game.hitTest(s.prev, s.pos);
        if (res) targetHit = true;
      }

      if (s.pos.y <= ground || s.life <= 0 || targetHit) {
        s.alive = false;
        s.mesh.visible = false;
        if (s.pos.y <= ground || targetHit) {
          this.explosion(
            new THREE.Vector3(
              s.pos.x,
              Math.max(s.pos.y, ground + 0.5),
              s.pos.z,
            ),
            1.15,
          );
        }
      }
    }

    this.shake *= Math.max(0, 1 - dt * 3.2);
  }

  /** Push a camera transform around to simulate shockwaves. */
  applyShake(camera, t) {
    if (this.shake <= 0.001) return;
    const a = this.shake * this.shake;
    camera.position.x += Math.sin(t * 47.3) * a * 0.55;
    camera.position.y += Math.sin(t * 61.7) * a * 0.45;
    camera.position.z += Math.cos(t * 53.1) * a * 0.55;
  }
}
