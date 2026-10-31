import * as THREE from 'three';
import { heightAt, normalAt, WATER_LEVEL, PLAY_RADIUS } from './terrain.js';
import { clamp, wrapAngle } from './noise.js';

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

// ---------------------------------------------------------------------------
// Shared assets (created once for every enemy on the field)
// ---------------------------------------------------------------------------
const G = (() => {
  const hull = new THREE.BoxGeometry(3.0, 0.9, 6.0);
  const glacis = new THREE.BoxGeometry(3.0, 1.1, 1.9);
  const track = new THREE.BoxGeometry(0.8, 1.15, 6.45);
  const turret = new THREE.CylinderGeometry(1.28, 1.52, 0.8, 10);
  const barrel = new THREE.CylinderGeometry(0.1, 0.14, 4.4, 8);
  barrel.rotateX(Math.PI / 2);
  barrel.translate(0, 0, -2.2);
  const mantlet = new THREE.BoxGeometry(1.0, 0.62, 0.85);
  const wheel = new THREE.CylinderGeometry(0.4, 0.4, 0.34, 8);
  wheel.rotateZ(Math.PI / 2);
  const hatch = new THREE.CylinderGeometry(0.34, 0.34, 0.16, 8);
  const box = new THREE.BoxGeometry(0.62, 0.34, 0.9);
  return { hull, glacis, track, turret, barrel, mantlet, wheel, hatch, box };
})();

const MAT_TRACK = new THREE.MeshStandardMaterial({ color: 0x191a16, roughness: 0.95, metalness: 0.35 });
const MAT_ID = new THREE.MeshStandardMaterial({
  color: 0x8f2b1c, roughness: 0.75, metalness: 0.1, emissive: 0x2a0a05,
});
const MAT_GLASS = new THREE.MeshStandardMaterial({ color: 0x2b3a3c, roughness: 0.3, metalness: 0.6 });

const SHELL_GEO = new THREE.CylinderGeometry(0.11, 0.11, 1.5, 6);
SHELL_GEO.rotateX(Math.PI / 2);
const SHELL_MAT = new THREE.MeshBasicMaterial({ color: 0xffb066 });

let ENEMY_UID = 0;

// ---------------------------------------------------------------------------
// Enemy tank — hull AI, turret AI, module based damage, burning wreck
// ---------------------------------------------------------------------------
export class EnemyTank {
  constructor(scene, effects, playerTank, x, z) {
    this.id = ++ENEMY_UID;
    this.scene = scene;
    this.effects = effects;
    this.player = playerTank;
    this.manager = null;

    this.pos = new THREE.Vector3(x, heightAt(x, z) + 1.05, z);
    this.quat = new THREE.Quaternion();
    this.yaw = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.maxSpeed = 6.5 + Math.random() * 2.5;

    this.turretYaw = 0;
    this.gunPitch = 0;
    this.reload = 3.5 + Math.random() * 4;
    this.fireRange = 360;
    this.engageRange = 190;
    this.holdRange = 95;
    // sloppy crew: slow traverse, long reload, wide dispersion
    this.traverseRate = 0.55 + Math.random() * 0.25;
    this.turnRate = 0.5 + Math.random() * 0.25;

    this.health = 100;
    this.maxHealth = 100;
    this.dead = false;
    this.gone = false;
    this.wreckTimer = 0;
    this.flash = 0;
    this.smokeTimer = 0;
    this.dist = 9999;
    this.shellsFired = 0;

    this._buildModel();
    this._applyTransform();
  }

  // ------------------------------------------------------------------ model
  _buildModel() {
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0x4a4436, roughness: 0.9, metalness: 0.18,
    });
    const turretMat = new THREE.MeshStandardMaterial({
      color: 0x413b2f, roughness: 0.9, metalness: 0.18,
    });
    this.hullMat = hullMat;
    this.turretMat = turretMat;

    this.root = new THREE.Group();
    this.root.name = `enemy_${this.id}`;

    // --- hull ---
    const hull = new THREE.Mesh(G.hull, hullMat);
    hull.position.y = 0.02;
    hull.castShadow = true;
    hull.receiveShadow = true;
    this.root.add(hull);

    const glacis = new THREE.Mesh(G.glacis, hullMat);
    glacis.position.set(0, 0.3, -2.5);
    glacis.rotation.x = -0.5;
    glacis.castShadow = true;
    this.root.add(glacis);

    // --- running gear ---
    for (const side of [-1, 1]) {
      const track = new THREE.Mesh(G.track, MAT_TRACK);
      track.position.set(side * 1.52, -0.12, 0);
      track.castShadow = true;
      this.root.add(track);

      for (let i = 0; i < 4; i++) {
        const w = new THREE.Mesh(G.wheel, MAT_TRACK);
        w.position.set(side * 1.86, -0.25, -2.2 + i * 1.45);
        this.root.add(w);
      }
    }

    // --- turret ---
    this.turret = new THREE.Group();
    this.turret.position.set(0, 0.72, 0.15);
    this.root.add(this.turret);

    const tur = new THREE.Mesh(G.turret, turretMat);
    tur.castShadow = true;
    tur.receiveShadow = true;
    this.turret.add(tur);

    const hatch = new THREE.Mesh(G.hatch, turretMat);
    hatch.position.set(0.45, 0.46, 0.35);
    this.turret.add(hatch);

    // recognition stripe so the player can tell friend from foe
    const stripe = new THREE.Mesh(G.box, MAT_ID);
    stripe.position.set(0, 0.18, 1.2);
    stripe.scale.set(1.55, 0.35, 0.35);
    this.turret.add(stripe);

    // --- gun ---
    this.gunPivot = new THREE.Group();
    this.gunPivot.position.set(0, 0.06, -1.1);
    this.turret.add(this.gunPivot);

    const mantlet = new THREE.Mesh(G.mantlet, turretMat);
    mantlet.castShadow = true;
    this.gunPivot.add(mantlet);

    const barrel = new THREE.Mesh(G.barrel, turretMat);
    barrel.castShadow = true;
    this.gunPivot.add(barrel);

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, -4.35);
    this.gunPivot.add(this.muzzle);

    // optics
    const optic = new THREE.Mesh(G.box, MAT_GLASS);
    optic.position.set(-0.55, 0.42, -0.55);
    optic.scale.set(0.7, 0.4, 0.6);
    this.turret.add(optic);

    this.scene.add(this.root);
  }

  _applyTransform() {
    normalAt(this.pos.x, this.pos.z, _n);
    _q.setFromUnitVectors(UP, _n);
    _q2.setFromAxisAngle(UP, this.yaw);
    this.quat.copy(_q).multiply(_q2);

    this.root.position.copy(this.pos);
    this.root.quaternion.copy(this.quat);
  }

  // ------------------------------------------------------------------ brain
  update(dt) {
    if (this.dead) { this._updateWreck(dt); return; }

    const p = this.player.pos;
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.dist = dist;

    // heading that points the hull at the player (forward is -Z)
    const toPlayerYaw = Math.atan2(-dx, -dz);

    // ---- hull intent -----------------------------------------------------
    let desiredYaw = toPlayerYaw;
    let targetSpeed;

    if (!this.player.alive) {
      targetSpeed = 0;
    } else if (dist > this.engageRange) {
      targetSpeed = this.maxSpeed;                    // advance
    } else if (dist < this.holdRange) {
      desiredYaw = toPlayerYaw + Math.PI;             // back off
      targetSpeed = this.maxSpeed * 0.5;
    } else {
      desiredYaw = toPlayerYaw + 0.45;                // flank / circle
      targetSpeed = this.maxSpeed * 0.42;
    }

    const dyaw = wrapAngle(desiredYaw - this.yaw);
    this.yaw += clamp(dyaw, -this.turnRate * dt, this.turnRate * dt);

    this.speed += clamp(targetSpeed - this.speed, -7 * dt, 7 * dt);

    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const nx = this.pos.x + fx * this.speed * dt;
    const nz = this.pos.z + fz * this.speed * dt;

    // don't drown, don't leave the map
    const nh = heightAt(nx, nz);
    if (nh < WATER_LEVEL + 2 || Math.hypot(nx, nz) > PLAY_RADIUS - 60) {
      this.speed *= -0.25;
      this.yaw += 0.6 * dt * Math.sign(dyaw || 1);
    } else {
      this.pos.x = nx;
      this.pos.z = nz;
    }

    this.pos.y = heightAt(this.pos.x, this.pos.z) + 1.05;
    this._applyTransform();

    // ---- turret ----------------------------------------------------------
    const desiredLocal = wrapAngle(toPlayerYaw - this.yaw);
    const turretErr = wrapAngle(desiredLocal - this.turretYaw);
    this.turretYaw += clamp(turretErr, -this.traverseRate * dt, this.traverseRate * dt);
    this.turret.rotation.y = this.turretYaw;

    const dy = (p.y + 1.5) - (this.pos.y + 0.9);
    const targetPitch = clamp(Math.atan2(dy, Math.max(1, dist)), -0.14, 0.32);
    this.gunPitch += clamp(targetPitch - this.gunPitch, -1.2 * dt, 1.2 * dt);
    this.gunPivot.rotation.x = this.gunPitch;

    // ---- gunnery ---------------------------------------------------------
    this.reload -= dt;
    const aligned = Math.abs(turretErr) < 0.36;
    if (
      this.player.alive && dist < this.fireRange && dist > 28 &&
      aligned && this.reload <= 0 && this._hasLineOfSight()
    ) {
      if (Math.random() < 0.32) {
        // dumb crew: they lose their nerve and hesitate
        this.reload = 2 + Math.random() * 2.5;
      } else {
        this._fire();
        this.reload = 11 + Math.random() * 7;
      }
    }

    // ---- hit flash -------------------------------------------------------
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt);
      const k = (this.flash / 0.18) * 1.1;
      this.hullMat.emissive.setRGB(k, k * 0.35, k * 0.15);
      this.turretMat.emissive.setRGB(k, k * 0.35, k * 0.15);
    }
  }

  _hasLineOfSight() {
    const a = this.pos;
    const b = this.player.pos;
    const steps = 8;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = (a.y + 1.6) + ((b.y + 1.6) - (a.y + 1.6)) * t;
      if (heightAt(x, z) > y) return false;
    }
    return true;
  }

  _fire() {
    this.root.updateMatrixWorld(true);
    const muzzle = this.muzzle.getWorldPosition(_v).clone();

    const p = this.player.pos;
    const speed = 320;
    const tof = this.dist / speed;

    // simple lead + ballistic compensation (poorly estimated — these crews
    // are not marksmen, so they under-lead a moving target)
    const aim = _v2.copy(p)
      .addScaledVector(this.player.vel, tof * 0.12);
    aim.y += 0.5 * 12.5 * tof * tof;

    const dir = aim.sub(muzzle).normalize();
    const spread = 0.060 + Math.min(0.090, this.dist * 0.00020);
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    this.effects.muzzle(muzzle, dir);
    this.shellsFired++;
    if (this.manager) this.manager.spawnShell(muzzle, dir);
  }

  // -------------------------------------------------------------- damage in
  /**
   * Swept segment (a -> b) against the hull/turret/track box in local space.
   * Returns null when nothing was struck.
   */
  checkHit(a, b) {
    if (this.dead) return null;

    // broadphase: skip if the whole segment is far away
    const dx0 = a.x - this.pos.x;
    const dz0 = a.z - this.pos.z;
    const dx1 = b.x - this.pos.x;
    const dz1 = b.z - this.pos.z;
    if (Math.min(dx0 * dx0 + dz0 * dz0, dx1 * dx1 + dz1 * dz1) > 90 * 90 &&
      (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 90 * 90) {
      // both ends far from the tank and the segment is short
      if (dx0 * dx0 + dz0 * dz0 > 90 * 90) return null;
    }

    // world -> local (yaw only, tank is essentially planar here)
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const o = [
      (a.x - this.pos.x) * c - (a.z - this.pos.z) * s,
      a.y - this.pos.y,
      (a.x - this.pos.x) * s + (a.z - this.pos.z) * c,
    ];
    const d = [
      (b.x - a.x) * c - (b.z - a.z) * s,
      b.y - a.y,
      (b.x - a.x) * s + (b.z - a.z) * c,
    ];

    const lo = [-1.75, -0.62, -3.3];
    const hi = [1.75, 1.62, 3.3];

    let tmin = 0;
    let tmax = 1;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-7) {
        if (o[i] < lo[i] || o[i] > hi[i]) return null;
      } else {
        let t1 = (lo[i] - o[i]) / d[i];
        let t2 = (hi[i] - o[i]) / d[i];
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
    }

    const hx = o[0] + d[0] * tmin;
    const hy = o[1] + d[1] * tmin;
    const hz = o[2] + d[2] * tmin;

    let module = 'hull';
    let points = 200;
    let damage = 42;
    let critical = false;

    if (hy > 0.5 && Math.abs(hz) < 2.3) {
      module = 'turret';
      points = 500;
      damage = 65;
    } else if (hz > 1.2 && hy < 0.5) {
      module = 'ammo_rack';
      points = 1200;
      damage = 130;
      critical = true;
    } else if (hy < -0.1) {
      module = 'tracks';
      points = 150;
      damage = 25;
    }

    const point = new THREE.Vector3(
      a.x + (b.x - a.x) * tmin,
      a.y + (b.y - a.y) * tmin,
      a.z + (b.z - a.z) * tmin,
    );

    return { point, module, points, damage, critical };
  }

  takeDamage(amount) {
    if (this.dead) return false;
    this.health -= amount;
    this.flash = 0.18;
    if (this.health <= 0) {
      this._destroy();
      return true;
    }
    return false;
  }

  _destroy() {
    this.dead = true;
    this.health = 0;
    this.speed = 0;
    this.wreckTimer = 18;
    this.smokeTimer = 0;
    this.hullMat.emissive.setRGB(0.09, 0.03, 0.01);
    this.turretMat.emissive.setRGB(0.09, 0.03, 0.01);
    // turret pops off and the hull sags
    this.turret.position.y = 0.55;
    this.turret.rotation.z = 0.12;
    this.gunPivot.rotation.x = -0.25;
    this.effects.explosion(this.pos, 2.2);
  }

  _updateWreck(dt) {
    // burning smoke
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0 && this.wreckTimer > 2) {
      this.smokeTimer = 0.12;
      const p = _v3.copy(this.pos);
      p.y += 1.1;
      p.x += (Math.random() - 0.5) * 1.6;
      p.z += (Math.random() - 0.5) * 1.6;
      this.effects.fireSmoke
        ? this.effects.fireSmoke(p)
        : this.effects.dust(p, _v2.set(0, 0, 0), 1);
    }

    this.wreckTimer -= dt;
    if (this.wreckTimer < 4) {
      this.root.position.y -= dt * 0.35;   // settle into the mud
    }
    if (this.wreckTimer <= 0) this.gone = true;
  }

  dispose() {
    this.scene.remove(this.root);
    this.hullMat.dispose();
    this.turretMat.dispose();
  }

  get alive() { return !this.dead; }
}

// ---------------------------------------------------------------------------
// Manager — spawns, updates, resolves player shells, runs enemy shells
// ---------------------------------------------------------------------------
export class EnemyManager {
  constructor(scene, effects, playerTank, count = 6) {
    this.scene = scene;
    this.effects = effects;
    this.player = playerTank;
    this.count = count;

    this.tanks = [];
    this.shells = [];
    this.onHit = null;
    this.onKill = null;
    this.spawnTimer = 4;
    this.kills = 0;

    for (let i = 0; i < 20; i++) {
      const mesh = new THREE.Mesh(SHELL_GEO, SHELL_MAT);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.shells.push({
        alive: false,
        life: 0,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        mesh,
      });
    }

    for (let i = 0; i < count; i++) {
      this.spawnOne(i * (Math.PI * 2 / count) + Math.random());
    }
  }

  get aliveCount() {
    let n = 0;
    for (const t of this.tanks) if (!t.dead) n++;
    return n;
  }

  forEachAlive(fn) {
    for (const t of this.tanks) if (!t.dead) fn(t);
  }

  spawnOne(angleBias = Math.random() * Math.PI * 2, radiusBias = null) {
    const px = this.player.pos.x;
    const pz = this.player.pos.z;

    for (let attempt = 0; attempt < 26; attempt++) {
      const a = angleBias + attempt * 0.77;
      const r = radiusBias !== null
        ? radiusBias
        : 300 + Math.random() * 330;
      let x = px + Math.cos(a) * r;
      let z = pz + Math.sin(a) * r;

      // pull back inside the playable ring
      const d = Math.hypot(x, z);
      const limit = PLAY_RADIUS - 120;
      if (d > limit) {
        const k = limit / d;
        x *= k; z *= k;
      }

      if (Math.hypot(x - px, z - pz) < 180) continue;   // never spawn on top of the player
      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 4) continue;
      normalAt(x, z, _n);
      if (_n.y < 0.84) continue;                        // no spawns on cliffs

      const enemy = new EnemyTank(this.scene, this.effects, this.player, x, z);
      enemy.manager = this;
      this.tanks.push(enemy);
      return enemy;
    }
    return null;
  }

  /** Player shell segment test. Applies damage and reports score events. */
  hitTest(a, b) {
    for (const e of this.tanks) {
      if (e.dead) continue;
      const res = e.checkHit(a, b);
      if (!res) continue;

      const killed = e.takeDamage(res.damage);
      if (!killed) this.effects.explosion(res.point, 0.45);

      if (this.onHit) this.onHit(res, killed, e);
      if (killed) {
        this.kills++;
        if (this.onKill) this.onKill(e);
      }
      return { ...res, killed };
    }
    return null;
  }

  /** Nearest live enemy intersected by a ray — used for the lock-on reticle. */
  raycast(origin, dir, maxDist) {
    let best = null;
    let bestT = Infinity;
    for (const e of this.tanks) {
      if (e.dead) continue;
      const ox = e.pos.x - origin.x;
      const oy = (e.pos.y + 1.1) - origin.y;
      const oz = e.pos.z - origin.z;
      const t = ox * dir.x + oy * dir.y + oz * dir.z;
      if (t < 0 || t > maxDist || t > bestT) continue;
      const d2 = ox * ox + oy * oy + oz * oz - t * t;
      if (d2 > 10.5) continue;          // ~3.2 m radius around the hull
      best = e;
      bestT = t;
    }
    return best ? { tank: best, dist: bestT } : null;
  }

  spawnShell(pos, dir) {
    const s = this.shells.find((x) => !x.alive);
    if (!s) return;
    // Enemy gunners are not lasers — a little dispersion means some rounds
    // whistle past instead of every single one landing on the player.
    const spread = 0.016;
    const dx = dir.x + (Math.random() - 0.5) * spread;
    const dy = dir.y + (Math.random() - 0.5) * spread;
    const dz = dir.z + (Math.random() - 0.5) * spread;
    s.alive = true;
    s.life = 3.4;
    s.pos.copy(pos);
    s.prev.copy(pos);
    s.vel.set(dx, dy, dz).normalize().multiplyScalar(320);
    s.mesh.visible = true;
    s.mesh.position.copy(pos);
  }

  _segmentHitsPlayer(a, b, radius) {
    const c = _v.copy(this.player.pos);
    c.y += 0.9;
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const abLen2 = abx * abx + aby * aby + abz * abz;
    let t = abLen2 > 1e-6 ? (acx * abx + acy * aby + acz * abz) / abLen2 : 0;
    t = clamp(t, 0, 1);
    const dx = acx - abx * t;
    const dy = acy - aby * t;
    const dz = acz - abz * t;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  }

  update(dt) {
    for (const e of this.tanks) e.update(dt);

    // recycle wrecks that finished burning
    for (let i = this.tanks.length - 1; i >= 0; i--) {
      if (this.tanks[i].gone) {
        this.tanks[i].dispose();
        this.tanks.splice(i, 1);
      }
    }

    // keep the battlefield populated
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.aliveCount < this.count) {
      this.spawnTimer = 7;
      this.spawnOne();
    }

    // ---- hostile shells --------------------------------------------------
    for (const s of this.shells) {
      if (!s.alive) continue;

      s.prev.copy(s.pos);
      s.vel.y -= 12.5 * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.mesh.position.copy(s.pos);
      s.mesh.quaternion.setFromUnitVectors(AXIS_Z, _v2.copy(s.vel).normalize());
      s.life -= dt;

      const ground = heightAt(s.pos.x, s.pos.z);
      const hitPlayer = this.player.alive &&
        this._segmentHitsPlayer(s.prev, s.pos, 2.7);

      if (hitPlayer) {
        s.alive = false;
        s.mesh.visible = false;
        this.player.takeDamage(11 + Math.random() * 9);
        this.effects.explosion(s.pos, 0.9);
        continue;
      }

      if (s.pos.y <= ground || s.life <= 0) {
        s.alive = false;
        s.mesh.visible = false;
        if (s.pos.y <= ground) {
          this.effects.explosion(
            _v3.set(s.pos.x, ground + 0.4, s.pos.z), 0.85,
          );
        }
      }
    }
  }
}
