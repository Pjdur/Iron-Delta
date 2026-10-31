import * as THREE from 'three';
import { heightAt, normalAt, WATER_LEVEL, HALF } from './terrain.js';
import { mulberry32, wrapAngle } from './noise.js';

const _rootM = new THREE.Matrix4();
const _partM = new THREE.Matrix4();
const _lm = new THREE.Matrix4();
const _lp = new THREE.Vector3();
const _lq = new THREE.Quaternion();
const _ls = new THREE.Vector3(1, 1, 1);
const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _we = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _n = new THREE.Vector3();

function part(geo, mat, x, y, z) {
  return { geo, mat, pos: new THREE.Vector3(x, y, z) };
}

export class Soldiers {
  constructor(scene, count = 110) {
    this.scene = scene;
    this.count = count;
    this.group = new THREE.Group();
    scene.add(this.group);

    const rnd = mulberry32(97531);

    // ---------------- geometry / materials ----------------
    const cloth = new THREE.MeshLambertMaterial({ color: 0x4b5138 });
    const clothDark = new THREE.MeshLambertMaterial({ color: 0x33382a });
    const skin = new THREE.MeshLambertMaterial({ color: 0xb08a68 });
    const helmet = new THREE.MeshLambertMaterial({ color: 0x39412c });
    const gun = new THREE.MeshLambertMaterial({ color: 0x1a1c17 });

    const torsoGeo = new THREE.CapsuleGeometry(0.21, 0.5, 2, 6);
    const headGeo = new THREE.SphereGeometry(0.145, 7, 6);
    const helmGeo = new THREE.SphereGeometry(0.185, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.56);
    const legGeo = new THREE.CapsuleGeometry(0.10, 0.60, 2, 5);
    legGeo.translate(0, -0.40, 0);
    const armGeo = new THREE.CapsuleGeometry(0.085, 0.46, 2, 5);
    armGeo.translate(0, -0.30, 0);
    const rifleGeo = new THREE.BoxGeometry(0.055, 0.09, 0.92);
    const packGeo = new THREE.BoxGeometry(0.34, 0.42, 0.20);

    this.parts = {
      torso: part(torsoGeo, cloth, 0, 1.20, 0),
      pack: part(packGeo, clothDark, 0, 1.26, 0.24),
      head: part(headGeo, skin, 0, 1.70, 0),
      helmet: part(helmGeo, helmet, 0, 1.72, 0),
      legL: part(legGeo, clothDark, -0.13, 0.88, 0),
      legR: part(legGeo, clothDark, 0.13, 0.88, 0),
      armL: part(armGeo, cloth, -0.29, 1.44, 0),
      armR: part(armGeo, cloth, 0.29, 1.44, 0),
      rifle: part(rifleGeo, gun, 0.20, 1.20, -0.26),
    };

    this.meshes = {};
    for (const [name, p] of Object.entries(this.parts)) {
      const m = new THREE.InstancedMesh(p.geo, p.mat, count);
      m.castShadow = name === 'torso' || name === 'legL' || name === 'legR';
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      this.meshes[name] = m;
    }

    // ---------------- soldier state ----------------
    this.units = [];
    let guard = 0;
    while (this.units.length < count && guard < count * 40) {
      guard++;
      const x = (rnd() * 2 - 1) * (HALF - 300);
      const z = (rnd() * 2 - 1) * (HALF - 300);
      const d = Math.sqrt(x * x + z * z);
      if (d < 60) continue;
      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 4) continue;
      normalAt(x, z, _n);
      if (_n.y < 0.9) continue;

      this.units.push({
        x, z, y: h,
        yaw: rnd() * Math.PI * 2,
        phase: rnd() * Math.PI * 2,
        speed: 0,
        state: 'walk',
        dead: false,
        deadT: 0,
        fallDir: rnd() > 0.5 ? 1 : -1,
        home: { x, z },
        tx: x, tz: z,
        wait: rnd() * 3,
        rnd,
        fireCd: 1 + rnd() * 4,
        scale: 0.94 + rnd() * 0.14,
      });
    }

    // per-instance uniform tint
    for (const name of Object.keys(this.meshes)) {
      const m = this.meshes[name];
      const c = new THREE.Color();
      for (let i = 0; i < this.units.length; i++) {
        const t = 0.82 + rnd() * 0.36;
        c.setRGB(t, t, t);
        m.setColorAt(i, c);
      }
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    this._updateMeshesStatic(0);
  }

  _pickTarget(u) {
    const a = Math.random() * Math.PI * 2;
    const r = 20 + Math.random() * 90;
    const u2 = u;
    u2.tx = u2.home.x + Math.cos(a) * r;
    u2.tz = u2.home.z + Math.sin(a) * r;
  }

  update(dt, tankPos, camera, effects, time) {
    const meshes = this.meshes;

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];

      // --- death animation ---
      if (u.dead) {
        if (u.deadT < 1) {
          u.deadT = Math.min(1, u.deadT + dt * 1.6);
          this._writeUnit(i, u, 0, true);
        }
        continue;
      }

      const dx = u.x - tankPos.x;
      const dz = u.z - tankPos.z;
      const distToTank = Math.hypot(dx, dz);

      // --- AI ---
      let moveSpeed = 0;
      if (distToTank < 34) {
        // flee from the tank
        const a = Math.atan2(dx, dz) + (Math.sin(time * 2 + u.phase) * 0.3);
        u.tx = u.x + Math.sin(a) * 25;
        u.tz = u.z + Math.cos(a) * 25;
        moveSpeed = 4.4;
        u.state = 'flee';

        // occasionally fire at the tank
        u.fireCd -= dt;
        if (u.fireCd <= 0 && distToTank < 30) {
          u.fireCd = 2.5 + Math.random() * 4;
          _wp.set(u.x, u.y + 1.25, u.z);
          const dir = new THREE.Vector3(tankPos.x - u.x, tankPos.y + 1 - u.y, tankPos.z - u.z).normalize();
          effects.muzzleSmall(_wp.clone().addScaledVector(dir, 0.6), dir);
        }
      } else {
        u.state = 'walk';
        moveSpeed = 1.5;
        if (u.wait > 0) {
          u.wait -= dt;
          moveSpeed = 0;
        }
        const tdx = u.tx - u.x;
        const tdz = u.tz - u.z;
        if (Math.hypot(tdx, tdz) < 2.5) {
          this._pickTarget(u);
          u.wait = Math.random() * 3;
        }
        // stay near home
        const hx = u.x - u.home.x;
        const hz = u.z - u.home.z;
        if (Math.hypot(hx, hz) > 130) {
          u.tx = u.home.x;
          u.tz = u.home.z;
        }
      }

      // --- steering ---
      const tdx = u.tx - u.x;
      const tdz = u.tz - u.z;
      if (tdx * tdx + tdz * tdz > 0.4) {
        const desired = Math.atan2(tdx, tdz);
        u.yaw = wrapAngle(u.yaw + wrapAngle(desired - u.yaw) * Math.min(1, dt * 5));
      }

      const step = moveSpeed * dt;
      const nx = u.x + Math.sin(u.yaw) * step;
      const nz = u.z + Math.cos(u.yaw) * step;

      // keep out of deep water and off cliffs
      const nh = heightAt(nx, nz);
      if (nh > WATER_LEVEL + 1.5) {
        normalAt(nx, nz, _n);
        if (_n.y > 0.72) {
          u.x = nx;
          u.z = nz;
        }
      }
      u.y = heightAt(u.x, u.z);

      if (moveSpeed > 0.1) u.phase += dt * moveSpeed * 2.6;

      this._writeUnit(i, u, moveSpeed, false);
    }

    for (const name of Object.keys(meshes)) meshes[name].instanceMatrix.needsUpdate = true;
  }

  _writeUnit(i, u, moveSpeed, dead) {
    const swing = Math.sin(u.phase) * Math.min(0.62, 0.28 + moveSpeed * 0.09);

    // root transform
    _wp.set(u.x, u.y, u.z);
    if (dead) {
      _we.set(-Math.PI * 0.5 * u.deadT * u.fallDir, u.yaw, 0, 'YXZ');
      _wp.y = u.y + 0.12 + 0.15 * (1 - u.deadT);
    } else {
      _we.set(0, u.yaw, 0);
    }
    _wq.setFromEuler(_we);
    _rootM.compose(_wp, _wq, _one);

    const P = this.parts;

    // torso (with a little bob)
    _lp.copy(P.torso.pos);
    if (!dead) _lp.y += Math.abs(Math.sin(u.phase)) * 0.028;
    _lq.identity();
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.torso.setMatrixAt(i, _partM);

    _lp.copy(P.pack.pos);
    if (!dead) _lp.y += Math.abs(Math.sin(u.phase)) * 0.028;
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.pack.setMatrixAt(i, _partM);

    // head + helmet
    _lp.copy(P.head.pos);
    _lp.y += dead ? 0 : Math.abs(Math.sin(u.phase)) * 0.028;
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.head.setMatrixAt(i, _partM);

    _lp.copy(P.helmet.pos);
    _lp.y += dead ? 0 : Math.abs(Math.sin(u.phase)) * 0.028;
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.helmet.setMatrixAt(i, _partM);

    // legs
    const legSwing = dead ? -0.3 : swing;
    _lq.setFromEuler(_we.set(legSwing, 0, 0));
    _lp.copy(P.legL.pos);
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.legL.setMatrixAt(i, _partM);

    _lq.setFromEuler(_we.set(-legSwing, 0, 0));
    _lp.copy(P.legR.pos);
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.legR.setMatrixAt(i, _partM);

    // arms
    const armL = dead ? 0.4 : -swing * 0.7;
    const armR = dead ? -0.5 : swing * 0.5 - 0.35;
    _lq.setFromEuler(_we.set(armL, 0, 0));
    _lp.copy(P.armL.pos);
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.armL.setMatrixAt(i, _partM);

    _lq.setFromEuler(_we.set(armR, 0, 0.12));
    _lp.copy(P.armR.pos);
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.armR.setMatrixAt(i, _partM);

    // rifle
    _lq.setFromEuler(_we.set(dead ? 0.5 : -0.12, 0, 0));
    _lp.copy(P.rifle.pos);
    _lm.compose(_lp, _lq, _one);
    _partM.multiplyMatrices(_rootM, _lm);
    this.meshes.rifle.setMatrixAt(i, _partM);
  }

  _updateMeshesStatic() {
    for (let i = 0; i < this.units.length; i++) {
      this._writeUnit(i, this.units[i], 0, false);
    }
    for (const name of Object.keys(this.meshes)) {
      this.meshes[name].instanceMatrix.needsUpdate = true;
    }
  }

  /** Kill anyone inside the blast radius. */
  killNear(point, radius) {
    let killed = 0;
    const r2 = radius * radius;
    for (const u of this.units) {
      if (u.dead) continue;
      const dx = u.x - point.x;
      const dz = u.z - point.z;
      const dy = u.y - point.y;
      if (dx * dx + dz * dz + dy * dy < r2) {
        u.dead = true;
        u.deadT = 0;
        killed++;
      }
    }
    return killed;
  }

  get aliveCount() {
    let n = 0;
    for (const u of this.units) if (!u.dead) n++;
    return n;
  }
}
