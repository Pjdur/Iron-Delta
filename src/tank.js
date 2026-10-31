import * as THREE from 'three';
import { heightAt, normalAt, PLAY_RADIUS } from './terrain.js';
import { clamp, wrapAngle } from './noise.js';
import { TrackSystem } from './tracks.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _dq = new THREE.Quaternion();

// ---------------------------------------------------------------------------
function makeTrackTexture() {
  const W = 128, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#14140f';
  ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 8) {
    ctx.fillStyle = 'rgba(70,66,52,0.85)';
    ctx.fillRect(0, y, W, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, y + 5, W, 2);
  }
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = `rgba(${40 + Math.random() * 40},${38 + Math.random() * 30},${26 + Math.random() * 25},${Math.random() * 0.4})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 4);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
export class Tank {
  constructor(scene, effects) {
    this.effects = effects;

    this.root = new THREE.Group();
    scene.add(this.root);

    // ---- rigid body state ----
    this.pos = new THREE.Vector3(0, heightAt(0, 0) + 1.15, 0);
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();

    this.mass = 4200;
    this.invInertia = 1 / 21000;
    this.springK = 85000;       // Increased for stronger suspension on steep terrain
    this.damp = 12000;          // Increased damping for stability
    this.restLen = 0.78;
    this.maxComp = 0.8;         // Increased max compression
    this.engineForce = 65000;   // Increased engine power to climb mountains
    this.brakeForce = 45000;

    this.wheels = [
      new THREE.Vector3(-1.35, -0.55, -2.45),
      new THREE.Vector3(1.35, -0.55, -2.45),
      new THREE.Vector3(-1.35, -0.55, 2.45),
      new THREE.Vector3(1.35, -0.55, 2.45),
    ];

    // ---- controls / gun ----
    this.throttle = 0;
    this.steer = 0;
    this.braking = false;
    this.boost = false;

    this.turretYaw = 0;
    this.gunPitch = 0;
    this.aimPoint = new THREE.Vector3(0, 0, -400);
    this.reload = 0;
    this.reloadTime = 0.1;
    this.ammo = 1000;
    this.maxAmmo = 1000;
    this.health = 1000;

    this.treadPrev = [null, null];
    this.travel = 0;
    this.contactCount = 0;
    this.speed = 0;
    this.sliding = 0;
    this.flipTimer = 0;

    this.trackTex = makeTrackTexture();

    this._build();
    this.root.position.copy(this.pos);
  }

  // ------------------------------------------------------------------ model
  _build() {
    const olive = new THREE.MeshStandardMaterial({ color: 0x6e7850, roughness: 0.86, metalness: 0.04 });
    const oliveDark = new THREE.MeshStandardMaterial({ color: 0x59613f, roughness: 0.9, metalness: 0.04 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2e22, roughness: 0.85, metalness: 0.3 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8c9188, roughness: 0.45, metalness: 0.75 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x22241b, roughness: 1.0, metalness: 0.0 });
    this.trackMat = new THREE.MeshStandardMaterial({
      map: this.trackTex, color: 0x9a9a92, roughness: 0.95, metalness: 0.25,
    });

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = true;
      m.receiveShadow = true;
      this.body.add(m);
      return m;
    };

    const body = new THREE.Group();
    this.root.add(body);
    this.body = body;

    // ---- hull ----
    add(new THREE.BoxGeometry(3.05, 0.85, 6.4), oliveDark, 0, -0.18, 0);

    add(new THREE.BoxGeometry(3.45, 0.55, 5.9), olive, 0, 0.50, 0.10);

    // sloped glacis plate
    add(new THREE.BoxGeometry(3.45, 1.15, 1.9), olive, 0, 0.22, -2.85, -0.62);

    // rear plate
    add(new THREE.BoxGeometry(3.3, 0.9, 0.5), oliveDark, 0, 0.25, 3.05, 0.22);

    // side skirts
    add(new THREE.BoxGeometry(0.14, 0.7, 5.6), oliveDark, -1.78, 0.15, 0);
    add(new THREE.BoxGeometry(0.14, 0.7, 5.6), oliveDark, 1.78, 0.15, 0);

    // fenders / stowage
    add(new THREE.BoxGeometry(0.55, 0.35, 1.5), olive, -1.62, 0.72, 1.6);
    add(new THREE.BoxGeometry(0.55, 0.35, 1.5), olive, 1.62, 0.72, 1.6);
    add(new THREE.BoxGeometry(0.6, 0.28, 1.0), oliveDark, 1.6, 0.78, -1.9);
    add(new THREE.BoxGeometry(0.6, 0.28, 1.0), oliveDark, -1.6, 0.78, -1.9);

    // tow hooks
    add(new THREE.BoxGeometry(0.14, 0.14, 0.5), steel, -0.9, 0.05, -3.5);
    add(new THREE.BoxGeometry(0.14, 0.14, 0.5), steel, 0.9, 0.05, -3.5);

    // ---- running gear ----
    this.wheelMeshes = [];
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.30, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.34, 10);
    hubGeo.rotateZ(Math.PI / 2);

    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const z = -2.4 + i * 0.96;
        const w = add(wheelGeo, rubber, side * 1.62, -0.46, z);
        add(hubGeo, steel, side * 1.635, -0.46, z);
        this.wheelMeshes.push(w);
      }
      // drive sprocket + idler
      const sp = add(new THREE.CylinderGeometry(0.5, 0.5, 0.26, 12), steel, side * 1.62, -0.05, 2.75);
      sp.geometry.rotateZ(Math.PI / 2);
      this.wheelMeshes.push(sp);
      const idler = add(new THREE.CylinderGeometry(0.46, 0.46, 0.26, 12), steel, side * 1.62, -0.05, -2.85);
      this.wheelMeshes.push(idler);

      // track band (outer surface)
      const band = add(new THREE.BoxGeometry(0.10, 1.02, 6.9), this.trackMat, side * 1.84, -0.25, 0);
      band.castShadow = true;
      // top run
      add(new THREE.BoxGeometry(0.32, 0.12, 6.9), this.trackMat, side * 1.62, 0.20, 0);
    }

    // ---- turret ----
    this.turret = new THREE.Group();
    this.turret.position.set(0, 0.88, 0.05);
    body.add(this.turret);

    const turretBase = new THREE.Mesh(new THREE.CylinderGeometry(1.44, 1.66, 0.42, 12), olive);
    turretBase.position.y = 0.12;
    turretBase.castShadow = true; turretBase.receiveShadow = true;
    this.turret.add(turretBase);

    const turretBody = new THREE.Mesh(new THREE.CylinderGeometry(1.30, 1.62, 0.62, 12), olive);
    turretBody.position.y = 0.62;
    turretBody.castShadow = true; turretBody.receiveShadow = true;
    this.turret.add(turretBody);

    const bustle = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 1.5), olive);
    bustle.position.set(0, 0.55, 1.35);
    bustle.castShadow = true;
    this.turret.add(bustle);

    // commander cupola
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.32, 10), oliveDark);
    cup.position.set(-0.55, 1.03, 0.35);
    cup.castShadow = true;
    this.turret.add(cup);
    const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.40, 0.06, 10), olive);
    hatch.position.set(-0.55, 1.22, 0.35);
    this.turret.add(hatch);

    // gun
    this.gunPivot = new THREE.Group();
    this.gunPivot.position.set(0, 0.62, -1.15);
    this.turret.add(this.gunPivot);

    const mantlet = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.62, 0.65), oliveDark);
    mantlet.position.set(0, 0, -0.2);
    mantlet.castShadow = true;
    this.gunPivot.add(mantlet);

    const barrelGeo = new THREE.CylinderGeometry(0.11, 0.135, 4.9, 12);
    barrelGeo.rotateX(Math.PI / 2);
    barrelGeo.translate(0, 0, -2.7);
    const barrel = new THREE.Mesh(barrelGeo, oliveDark);
    barrel.castShadow = true;
    this.gunPivot.add(barrel);

    const brakeGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.55, 10);
    brakeGeo.rotateX(Math.PI / 2);
    brakeGeo.translate(0, 0, -5.05);
    const brake = new THREE.Mesh(brakeGeo, steel);
    brake.castShadow = true;
    this.gunPivot.add(brake);

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, -5.4);
    this.gunPivot.add(this.muzzle);

    // coaxial MG + antenna
    const coax = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), dark);
    coax.rotation.x = Math.PI / 2;
    coax.position.set(0.62, 0.62, -1.9);
    this.turret.add(coax);

    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, 2.2, 4), dark);
    antenna.position.set(0.95, 1.6, 0.9);
    antenna.rotation.z = 0.09;
    this.turret.add(antenna);
  }

  // --------------------------------------------------------------- physics
  step(dt, input, tracks) {
    // A wrecked hull cannot drive: kill the engine inputs and lock the brakes.
    if (!this.alive) {
      this.throttle = 0;
      this.steer = 0;
      this.braking = true;
      this.boost = false;
      this._burnFx(dt);
    } else {
      this.throttle = input.throttle;
      this.steer = input.steer;
      this.braking = input.brake;
      this.boost = input.boost;
    }

    const SUB = 4;
    const h = dt / SUB;
    for (let i = 0; i < SUB; i++) this._substep(h);

    // keep inside the playable area
    // Keep inside the playable area
    const d = Math.hypot(this.pos.x, this.pos.z);
    if (d > PLAY_RADIUS) {
      const s = PLAY_RADIUS / d;
      this.pos.x *= s;
      this.pos.z *= s;
      const nx = this.pos.x / PLAY_RADIUS;
      const nz = this.pos.z / PLAY_RADIUS;
      const out = this.vel.x * nx + this.vel.z * nz;
      if (out > 0) { this.vel.x -= nx * out * 1.5; this.vel.z -= nz * out * 1.5; }
    }

    // Anti-sink terrain floor check for steep mountain slopes
    const groundH = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < groundH + 1) {
      this.pos.y = groundH + 1;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    // tunnel safety
    const gh = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < gh - 6) {
      this.pos.y = gh + 2.0;
      this.vel.set(0, 0, 0);
      this.angVel.set(0, 0, 0);
      this.quat.identity();
    }

    // ------- visuals -------
    this.root.position.copy(this.pos);
    this.root.quaternion.copy(this.quat);

    this.speed = this.vel.dot(_fwd.set(0, 0, -1).applyQuaternion(this.quat));

    // wheels spin from ground speed
    const spin = (this.speed / 0.42) * dt;
    for (const w of this.wheelMeshes) w.rotation.x -= spin;

    // track texture scroll
    this.trackTex.offset.y -= this.speed * dt * 0.55;

    // ------- ground contact dust + track marks -------
    if (this.contactCount > 0 && Math.abs(this.speed) > 0.6) {
      if (Math.random() < 0.6) {
        _v1.set(this.pos.x, this.pos.y - 1.2, this.pos.z)
          .addScaledVector(_v2.set(0, 0, 1).applyQuaternion(this.quat), 2.6);
        this.effects.dust(_v1, this.vel, Math.abs(this.speed) > 8 ? 2 : 1);
      }
      if (this.sliding > 0.35 && Math.random() < 0.5) {
        _v1.set(this.pos.x, this.pos.y - 1.1, this.pos.z);
        _v3.copy(_v4.set(1, 0, 0).applyQuaternion(this.quat));
        // sideways mud spray
        for (let i = 0; i < 3; i++) {
          this.effects.smoke.emit(
            _v1.x, _v1.y + 0.3, _v1.z,
            _v3.x * this.sliding * 9 * (Math.random() - 0.5) * 2,
            3 + Math.random() * 4,
            _v3.z * this.sliding * 9 * (Math.random() - 0.5) * 2,
            0.18, 0.13, 0.08,
            0.5 + Math.random() * 0.7,
            0.5 + Math.random(), -18, 0.6, 0
          );
        }
      }
    }

    if (tracks && this.contactCount > 0) {
      this.travel += Math.abs(this.speed) * dt;
      if (this.travel > 0.9) {
        this.travel = 0;
        const right = _v4.set(1, 0, 0).applyQuaternion(this.quat);
        const f = _v2.set(0, 0, 1).applyQuaternion(this.quat);
        for (let s = 0; s < 2; s++) {
          const side = s === 0 ? -1.42 : 1.42;
          const c = _v1.copy(this.pos)
            .addScaledVector(right, side)
            .addScaledVector(f, 0);
          c.y = heightAt(c.x, c.z);
          const e = TrackSystem.edges(c, right, 1.05);
          const prev = this.treadPrev[s];
          if (prev) {
            tracks.addQuad(prev.l, prev.r, e.l, e.r);
          }
          this.treadPrev[s] = e;
        }
      }
    }
  }

  _substep(dt) {
    const force = _v3.set(0, -9.81 * this.mass, 0).clone();
    const torque = new THREE.Vector3();

    const fwd = _fwd.set(0, 0, -1).applyQuaternion(this.quat);
    const right = _v1.set(1, 0, 0).applyQuaternion(this.quat);
    const up = _v2.copy(UP).applyQuaternion(this.quat);

    const worldUp = UP;
    const bodyYawAxis = up.clone();

    let contacts = 0;
    const avgNormal = new THREE.Vector3();
    let lateralSlip = 0;

    for (const wl of this.wheels) {
      const wp = wl.clone().applyQuaternion(this.quat).add(this.pos);
      const gH = heightAt(wp.x, wp.z);
      const dist = wp.y - gH;

      if (dist > this.restLen) continue;

      contacts++;
      const comp = Math.min(this.restLen - dist, this.maxComp);

      const r = wp.clone().sub(this.pos);
      const pv = this.angVel.clone().cross(r).add(this.vel);
      const upVel = pv.dot(worldUp);

      let springF = this.springK * comp - this.damp * upVel;
      if (springF < 0) springF = 0;
      // Allow higher spring force limit for steep slopes
      springF = Math.min(springF, this.mass * 150);

      const normal = normalAt(wp.x, wp.z, _n);
      avgNormal.add(normal);

      const f = normal.clone().multiplyScalar(springF);
      force.add(f);
      torque.add(r.clone().cross(f));

      // ---- ground-plane basis ----
      const fwdP = fwd.clone().addScaledVector(normal, -fwd.dot(normal));
      if (fwdP.lengthSq() < 1e-6) continue;
      fwdP.normalize();
      const rightP = new THREE.Vector3().crossVectors(fwdP, normal).normalize();

      // ---- drive / brake ----
      let drive = this.engineForce * this.throttle * (this.boost ? 1.35 : 1);
      if (this.braking) {
        const vs = pv.dot(fwdP);
        drive = -Math.sign(vs) * Math.min(Math.abs(vs) * 4000, this.brakeForce);
      }
      if (drive !== 0) {
        // don't spin the tracks when airborne-ish
        const df = fwdP.clone().multiplyScalar(drive * 0.25);
        force.add(df);
        torque.add(r.clone().cross(df));
      }

      // ---- lateral grip (tracks resist sideways slip) ----
      const latV = pv.dot(rightP);
      lateralSlip += Math.abs(latV);
      const grip = clamp(-latV * 3200, -26000, 26000);
      const lf = rightP.clone().multiplyScalar(grip * 0.25);
      force.add(lf);
      torque.add(r.clone().cross(lf));

      // ---- rolling resistance ----
      const longV = pv.dot(fwdP);
      const roll = -longV * 900;
      const rf = fwdP.clone().multiplyScalar(roll * 0.25);
      force.add(rf);
      torque.add(r.clone().cross(rf));
    }

    // ---- track friction: hold position on gentle slopes when idle ----
    if (contacts > 0 && Math.abs(this.throttle) < 0.01 && !this.braking) {
      const planar = new THREE.Vector3(this.vel.x, 0, this.vel.z);
      const pl = planar.length();
      if (pl < 3.0) {
        force.addScaledVector(planar, -this.mass * 3.4);
      }
    }

    this.contactCount = contacts;
    this.sliding = contacts ? lateralSlip / contacts : 0;

    // ---- yaw steering ----
    if (contacts > 0) {
      const speed = this.vel.dot(fwd);
      const sf = Math.min(1, Math.abs(speed) / 3.5) * (1 - Math.min(0.62, Math.abs(speed) / 42));
      const dir = speed < -0.4 ? -1 : 1;
      const target = this.steer * 1.35 * sf * dir;
      const cur = this.angVel.dot(bodyYawAxis);
      this.angVel.addScaledVector(bodyYawAxis, (target - cur) * Math.min(1, dt * 7));

      // righting torque: keep the hull aligned with the average contact normal
      avgNormal.normalize();
      const axis = up.clone().cross(avgNormal);
      const align = axis.length();
      if (align > 0.001) {
        const strength = Math.min(align, 1) * this.mass * 9.0;
        torque.addScaledVector(axis.normalize(), strength);
      }
      // damp pitch/roll oscillation
      const yawComp = this.angVel.dot(bodyYawAxis);
      const side = this.angVel.clone().addScaledVector(bodyYawAxis, -yawComp);
      this.angVel.addScaledVector(side, -Math.min(0.5, dt * 5));
    }

    // ---- aerodynamic / drivetrain drag ----
    const vlen = this.vel.length();
    force.addScaledVector(this.vel, -vlen * 55);
    force.addScaledVector(this.vel, -8);

    // ---- integrate ----
    this.vel.addScaledVector(force, dt / this.mass);
    this.angVel.addScaledVector(torque, dt * this.invInertia);
    this.angVel.multiplyScalar(Math.max(0, 1 - 1.6 * dt));

    const maxAng = 5.5;
    if (this.angVel.lengthSq() > maxAng * maxAng) this.angVel.setLength(maxAng);

    this.pos.addScaledVector(this.vel, dt);

    const w = this.angVel;
    _dq.set(w.x, w.y, w.z, 0).multiply(this.quat);
    this.quat.set(
      this.quat.x + _dq.x * 0.5 * dt,
      this.quat.y + _dq.y * 0.5 * dt,
      this.quat.z + _dq.z * 0.5 * dt,
      this.quat.w + _dq.w * 0.5 * dt
    ).normalize();
  }

  // ---------------------------------------------------------------- turret
  aimAt(point, dt) {
    this.aimPoint.copy(point);

    const fwd = _fwd.set(0, 0, -1).applyQuaternion(this.quat);
    const bodyYaw = Math.atan2(-fwd.x, -fwd.z);

    const dx = point.x - this.pos.x;
    const dz = point.z - this.pos.z;
    const dy = point.y - (this.pos.y + 1.4);

    const worldYaw = Math.atan2(-dx, -dz);
    let targetLocal = wrapAngle(worldYaw - bodyYaw);

    // turret traverse limit
    targetLocal = clamp(targetLocal, -Math.PI, Math.PI);
    this.turretYaw = wrapAngle(
      this.turretYaw + clamp(wrapAngle(targetLocal - this.turretYaw), -1.5 * dt, 1.5 * dt)
    );

    const horiz = Math.hypot(dx, dz);
    let targetPitch = Math.atan2(dy, Math.max(0.01, horiz));
    targetPitch = clamp(targetPitch, -0.16, 0.34);
    this.gunPitch += clamp(targetPitch - this.gunPitch, -0.9 * dt, 0.9 * dt);

    this.turret.rotation.y = this.turretYaw;
    this.gunPivot.rotation.x = this.gunPitch;
  }

  canFire() {
    return this.alive && this.reload <= 0 && this.ammo > 0;
  }

  fire() {
    if (!this.canFire()) return null;
    this.ammo--;
    this.reload = this.reloadTime;

    this.root.updateMatrixWorld(true);

    const muzzlePos = new THREE.Vector3();
    this.muzzle.getWorldPosition(muzzlePos);

    // Object3D.getWorldDirection() returns +Z; the barrel points down -Z.
    const dir = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.muzzle.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();

    // recoil
    this.vel.addScaledVector(dir, -2.2);
    this.angVel.y += (Math.random() - 0.5) * 0.05;

    this.effects.muzzle(muzzlePos, dir);
    this.effects.fireShell(
      muzzlePos.clone().addScaledVector(dir, 1.2),
      dir,
      620
    );
    return { pos: muzzlePos, dir };
  }

  updateReload(dt) {
    if (this.reload > 0) this.reload = Math.max(0, this.reload - dt);
  }

  get alive() {
    return this.health > 0;
  }

  takeDamage(amount) {
    if (this.health <= 0) return;
    this.health = Math.max(0, this.health - amount);
    if (this.effects) {
      this.effects.shake = Math.min(1.4, (this.effects.shake || 0) + 0.45);
    }
    if (this.health <= 0) {
      this.burning = true;
      this.burnPower = 1;
      this.ammo = 0;
    }
  }

  // Fire + rolling black smoke pouring off the engine deck of a burning wreck.
  _burnFx(dt) {
    if (!this.burning || !this.effects) return;
    this._burnAccum = (this._burnAccum || 0) + dt;
    if (this._burnAccum < 0.045) return;
    this._burnAccum = 0;
    _v1.set(0, 0.95, 0.25).applyQuaternion(this.quat).add(this.pos);
    this.effects.burn(_v1, this.burnPower || 1);
    this.burnPower = Math.max(0.45, (this.burnPower || 1) - dt * 0.01);
  }

  rightSelf() {
    // find a pose aligned with the local terrain normal
    normalAt(this.pos.x, this.pos.z, _n);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, _n);
    this.quat.slerp(q, 0.85);
    this.pos.y = heightAt(this.pos.x, this.pos.z) + 1.3;
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.flipTimer = 0;
  }

  get bodyUpY() {
    return _v1.set(0, 1, 0).applyQuaternion(this.quat).y;
  }

  get speedKmh() {
    return Math.abs(this.speed) * 3.6;
  }
}
