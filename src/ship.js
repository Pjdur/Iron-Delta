import * as THREE from 'three';
import { clamp, wrapAngle } from './noise.js';
import { WATER_LEVEL } from './terrain.js';

// ---------------------------------------------------------------------------
// Warships for the naval engagement. Two classes:
//   • destroyer — fast, agile, 4x2 main guns + torpedoes (player & enemies)
//   • cruiser   — bigger, slower, 4x3 heavier guns, no torpedoes
//
// Physics is "captain's chair" arcade-realism in the spirit of World of
// Warships: huge linear inertia, a telegraph-driven engine, a rudder that
// bites with speed, and buoyancy sampled from the Gerstner sea at four
// points so the hull genuinely rides, pitches and rolls on the swell.
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const SHIP_TRAVEL_SPEED_MULTIPLIER = 8;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------
export const SHIP_SPECS = {
  destroyer: {
    key: 'destroyer', name: 'DESTROYER',
    length: 114, beam: 12.4, draft: 4.1, freeboard: 2.6,
    hp: 10500, maxSpeed: 17.2, astern: 6.2, accel: 1.15, decel: 0.55,
    turnRate: 0.5, rudderRate: 1.05,
    turrets: [
      { z: -40.5, barrels: 2 }, { z: -13.5, barrels: 2 },
      { z: 16.5, barrels: 2 }, { z: 41, barrels: 2 },
    ],
    traverse: 0.55, gunPitchRate: 0.42, gunH: 4.6,
    shellSpeed: 720, shellDamage: [240, 340], reload: 0.3,
    spread: 0.012, range: 3600,
    funnels: [{ z: -13 }, { z: 0.5 }],
    torps: { mounts: [{ z: 7 }], perSalvo: 4, speed: 31, range: 6500, reload: 55, spread: 0.045 },
  },
  cruiser: {
    key: 'cruiser', name: 'LIGHT CRUISER',
    length: 172, beam: 19, draft: 6.3, freeboard: 3.5,
    hp: 16500, maxSpeed: 14.6, astern: 5.2, accel: 0.78, decel: 0.40,
    turnRate: 0.034, rudderRate: 0.85,
    turrets: [
      { z: -66, barrels: 3 }, { z: -34, barrels: 3 },
      { z: 38, barrels: 3 }, { z: 68, barrels: 3 },
    ],
    traverse: 0.42, gunPitchRate: 0.34, gunH: 6.0,
    shellSpeed: 780, shellDamage: [300, 420], reload: 9.0,
    spread: 0.014, range: 4200,
    funnels: [{ z: -11 }, { z: 9 }],
    torps: null,
  },
};

// ---------------------------------------------------------------------------
// Hull geometry — lofted cross-sections: a real ship silhouette, not a box.
// ---------------------------------------------------------------------------
function buildHullGeometry(spec) {
  const L = spec.length, B = spec.beam, T = spec.draft, F = spec.freeboard;
  const ST = 26;      // stations along the length
  const P = 5;        // points per half-section

  const stations = [];
  for (let i = 0; i < ST; i++) {
    const t = i / (ST - 1);                    // 0 stern -> 1 bow
    const z = L / 2 - t * L;                   // bow at -z
    let w;
    if (t < 0.5) w = 0.68 + 0.32 * Math.pow(t / 0.5, 1.25);
    else w = Math.pow(Math.cos(((t - 0.5) / 0.5) * Math.PI / 2), 0.72);
    const deckY = F * (1 + 0.9 * Math.pow(t, 3.2));            // sheer
    const keelY = -T * (1 - 0.55 * Math.pow(t, 2.6));          // rising forefoot
    stations.push({ z, w: Math.max(0.03, w) * B / 2, deckY, keelY });
  }

  const ring = (st) => {
    const pts = [];
    for (let k = 0; k < P; k++) {              // starboard, keel -> deck
      const s = k / (P - 1);
      const a = s * Math.PI / 2;
      const x = st.w * Math.pow(Math.sin(a), 0.85) * (1 + 0.09 * s * s * s);
      const y = st.keelY + (st.deckY - st.keelY) * Math.pow(s, 1.12);
      pts.push([x, y]);
    }
    for (let k = P - 2; k >= 1; k--) {         // port, deck -> keel
      const s = k / (P - 1);
      const a = s * Math.PI / 2;
      const x = st.w * Math.pow(Math.sin(a), 0.85) * (1 + 0.09 * s * s * s);
      const y = st.keelY + (st.deckY - st.keelY) * Math.pow(s, 1.12);
      pts.push([-x, y]);
    }
    return pts;
  };

  const rings = stations.map(ring);
  const RN = rings[0].length;
  const vcount = ST * RN + 2 + RN;             // loft + transom centre + transom rim
  const pos = new Float32Array(vcount * 3);

  for (let i = 0; i < ST; i++) {
    for (let j = 0; j < RN; j++) {
      const v = i * RN + j;
      pos[v * 3] = rings[i][j][0];
      pos[v * 3 + 1] = rings[i][j][1];
      pos[v * 3 + 2] = stations[i].z;
    }
  }
  // transom centre + rim duplicates (slightly inset)
  const cIdx = ST * RN;
  const stern = rings[0];
  let cx = 0, cy = 0;
  for (const p of stern) { cx += p[0]; cy += p[1]; }
  pos[cIdx * 3] = cx / RN * 0.35;
  pos[cIdx * 3 + 1] = cy / RN * 0.35;
  pos[cIdx * 3 + 2] = stations[0].z - 0.3;
  for (let j = 0; j < RN; j++) {
    const v = cIdx + 1 + j;
    pos[v * 3] = stern[j][0] * 0.97;
    pos[v * 3 + 1] = stern[j][1] * 0.97;
    pos[v * 3 + 2] = stations[0].z - 0.15;
  }

  const idx = [];
  for (let i = 0; i < ST - 1; i++) {
    for (let j = 0; j < RN; j++) {
      const jn = (j + 1) % RN;
      const a = i * RN + j, b = i * RN + jn;
      const cc = (i + 1) * RN + j, d = (i + 1) * RN + jn;
      idx.push(a, cc, b, b, cc, d);
    }
  }
  for (let j = 0; j < RN; j++) {
    const jn = (j + 1) % RN;
    idx.push(cIdx, cIdx + 1 + j, cIdx + 1 + jn);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildDeckGeometry(spec) {
  const L = spec.length, B = spec.beam, F = spec.freeboard;
  const ST = 14;
  const pos = [];
  const idx = [];
  for (let i = 0; i < ST; i++) {
    const t = i / (ST - 1);
    const z = L / 2 - t * L;
    let w;
    if (t < 0.5) w = 0.66 + 0.34 * Math.pow(t / 0.5, 1.25);
    else w = Math.pow(Math.cos(((t - 0.5) / 0.5) * Math.PI / 2), 0.72);
    w = Math.max(0.06, w) * B / 2;
    const deckY = F * (1 + 0.9 * Math.pow(t, 3.2)) + 0.02;
    pos.push(-w, deckY, z, w, deckY, z);
  }
  for (let i = 0; i < ST - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// shared geometry cache — every ship of a class reuses the same buffers
const GEO = new Map();
function getGeos(spec) {
  if (!GEO.has(spec.key)) {
    GEO.set(spec.key, {
      hull: buildHullGeometry(spec),
      deck: buildDeckGeometry(spec),
    });
  }
  return GEO.get(spec.key);
}

// low-arc ballistic elevation from (horiz distance, vertical drop) — the
// same solution the tank gun uses, tuned for naval shell speeds.
function ballisticPitch(v, g, x, dy) {
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * x * x + 2 * dy * v2);
  if (disc < 0) return Math.atan2(dy, Math.max(0.01, x));
  return Math.atan((v2 - Math.sqrt(disc)) / (g * Math.max(0.01, x)));
}

// ---------------------------------------------------------------------------
export class Ship {
  constructor(scene, typeKey, opts = {}) {
    this.spec = SHIP_SPECS[typeKey];
    this.scene = scene;
    this.isPlayer = !!opts.isPlayer;
    this.fx = opts.fx || null;
    this.sea = opts.sea || null;

    this.pos = new THREE.Vector3(0, WATER_LEVEL, 0);
    this.yaw = 0;
    this.speed = 0;
    this.throttle = 0;         // -1..1 (engine telegraph value)
    this.rudder = 0;           // commanded -1..1
    this.rudderAngle = 0;      // actual blade angle, eases toward command
    this.yawRate = 0;
    this.pitch = 0;
    this.roll = 0;
    this.heel = 0;

    this.hp = this.spec.hp;
    this.maxHp = this.spec.hp;
    this.engineFactor = 1;
    this.gunReload = 4;
    this.torpSalvos = this.spec.torps ? 2 : 0;
    this.torpReload = 0;
    this.sinking = false;
    this.sinkT = 0;
    this.gone = false;
    this.flash = 0;
    this.dist = 9999;
    this._fxAcc = 0;
    this._smokeAcc = 0;
    this._turretsReady = 0;

    // AI scratch (managed by naval.js)
    this.ai = null;

    this._build();
    this.root.position.copy(this.pos);
  }

  forward(out = _fwd) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  right(out = _rgt) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }
  get alive() { return !this.sinking && this.hp > 0; }
  get speedKnots() { return Math.min(30, Math.abs(this.speed) * 1.9438); }

  // ------------------------------------------------------------------ model
  _build() {
    const spec = this.spec;
    const L = spec.length, B = spec.beam, F = spec.freeboard;

    const scheme = this.isPlayer
      ? { hull: 0x5d6873, sup: 0x6b7681, deck: 0x464d55, band: 0xffb545 }
      : { hull: 0x424a52, sup: 0x4a525a, deck: 0x383e45, band: 0x8f2b1c };

    this.hullMat = new THREE.MeshStandardMaterial({
      color: scheme.hull, roughness: 0.62, metalness: 0.25,
    });
    this.supMat = new THREE.MeshStandardMaterial({
      color: scheme.sup, roughness: 0.66, metalness: 0.2,
    });
    const deckMat = new THREE.MeshStandardMaterial({
      color: scheme.deck, roughness: 0.9, metalness: 0.1,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x22262b, roughness: 0.8, metalness: 0.4,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x18262e, roughness: 0.25, metalness: 0.7,
    });
    const bandMat = new THREE.MeshStandardMaterial({
      color: scheme.band, roughness: 0.7, metalness: 0.1,
    });

    this.root = new THREE.Group();

    const geos = getGeos(spec);
    const hull = new THREE.Mesh(geos.hull, this.hullMat);
    hull.castShadow = true;
    hull.receiveShadow = true;
    this.root.add(hull);
    const deck = new THREE.Mesh(geos.deck, deckMat);
    deck.receiveShadow = true;
    this.root.add(deck);

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = this.root) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // ---- superstructure ----
    const supL = L * 0.30;
    const supH = 2.6;
    add(new THREE.BoxGeometry(B * 0.62, supH, supL), this.supMat, 0, F + supH / 2, -L * 0.02);
    // bridge block with a window band
    add(new THREE.BoxGeometry(B * 0.78, 2.0, L * 0.075), this.supMat, 0, F + supH + 0.95, -L * 0.10);
    add(new THREE.BoxGeometry(B * 0.79, 0.62, L * 0.062), glassMat, 0, F + supH + 1.15, -L * 0.108);
    add(new THREE.BoxGeometry(B * 0.5, 1.2, L * 0.05), this.supMat, 0, F + supH + 2.5, -L * 0.095);
    // open bridge wings
    add(new THREE.BoxGeometry(B * 0.95, 0.12, L * 0.05), darkMat, 0, F + supH + 0.35, -L * 0.095);

    // ---- funnels (raked, with recognition band & black cap) ----
    this.funnelTops = [];
    const funR = Math.max(1.1, B * 0.13);
    for (const f of spec.funnels) {
      const fg = new THREE.Group();
      fg.position.set(0, F + 1.7, f.z);
      fg.rotation.x = 0.12;                         // raked aft
      this.root.add(fg);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(funR, funR * 1.12, 5.4, 12), this.supMat);
      tube.castShadow = true;
      fg.add(tube);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(funR * 1.06, funR * 1.06, 0.7, 12), darkMat);
      cap.position.y = 2.8;
      fg.add(cap);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(funR * 1.06, funR * 1.07, 0.85, 12), bandMat);
      band.position.y = 0.8;
      fg.add(band);
      this.funnelTops.push(new THREE.Vector3(0, F + 4.6, f.z));
    }

    // ---- masts ----
    const foremast = add(new THREE.CylinderGeometry(0.11, 0.2, L * 0.13, 6), darkMat,
      0, F + supH + L * 0.055, -L * 0.12);
    foremast.rotation.x = 0.06;
    add(new THREE.CylinderGeometry(0.05, 0.05, B * 0.9, 4), darkMat,
      0, F + supH + L * 0.08, -L * 0.12, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.09, 0.15, L * 0.085, 6), darkMat,
      0, F + 1.8 + L * 0.035, L * 0.16);
    // fighting-top
    add(new THREE.CylinderGeometry(0.55, 0.65, 0.8, 8), this.supMat,
      0, F + supH + L * 0.075, -L * 0.12);

    // ---- torpedo mounts ----
    this.torpMounts = [];
    if (spec.torps) {
      for (const tm of spec.torps.mounts) {
        const g = new THREE.Group();
        g.position.set(0, F + 1.15, tm.z);
        this.root.add(g);
        add(new THREE.BoxGeometry(2.6, 0.5, 2.0), darkMat, 0, -0.45, 0, 0, 0, 0, g);
        for (let i = 0; i < 4; i++) {
          const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 5.2, 8), darkMat);
          tube.rotation.x = Math.PI / 2;
          tube.position.set((i % 2 ? 0.62 : -0.62), i < 2 ? 0.15 : 0.78, 0);
          tube.castShadow = true;
          g.add(tube);
        }
        this.torpMounts.push(g);
      }
    }

    // ---- main turrets ----
    this.turrets = [];
    for (const ts of spec.turrets) {
      const mount = new THREE.Group();
      mount.position.set(0, F + 0.55, ts.z);
      this.root.add(mount);

      add(new THREE.CylinderGeometry(1.05, 1.25, 0.5, 12), darkMat, 0, -0.2, 0, 0, 0, 0, mount);

      const hw = 0.95 + ts.barrels * 0.62;
      const house = new THREE.Mesh(new THREE.BoxGeometry(hw, 1.45, 3.2), this.supMat);
      house.position.set(0, 0.65, 0.15);
      house.castShadow = true;
      mount.add(house);
      // sloped face
      const face = new THREE.Mesh(new THREE.CylinderGeometry(hw * 0.52, hw * 0.52, 1.5, 10, 1, false, 0, Math.PI), this.supMat);
      face.rotation.set(Math.PI / 2, 0, Math.PI / 2);
      face.scale.set(1, 1, 1.05);
      face.position.set(0, 0.65, -1.32);
      mount.add(face);

      const pivot = new THREE.Group();
      pivot.position.set(0, 0.78, -0.9);
      mount.add(pivot);
      const muzzles = [];
      for (let b = 0; b < ts.barrels; b++) {
        const off = (b - (ts.barrels - 1) / 2) * 0.62;
        const bg = new THREE.CylinderGeometry(0.10, 0.13, 5.4, 8);
        bg.rotateX(Math.PI / 2);
        bg.translate(0, 0, -2.7);
        const barrel = new THREE.Mesh(bg, darkMat);
        barrel.position.x = off;
        barrel.castShadow = true;
        pivot.add(barrel);
        const mz = new THREE.Object3D();
        mz.position.set(off, 0, -5.4);
        pivot.add(mz);
        muzzles.push(mz);
      }

      this.turrets.push({
        spec: ts, mount, pivot, muzzles,
        yaw: 0, pitch: 0, recoil: 0, ready: false, baseZ: ts.z,
      });
    }

    // ---- fluff: AA mounts, boats, depth charges ----
    const aaBase = new THREE.CylinderGeometry(0.42, 0.55, 0.35, 8);
    const aaGun = new THREE.CylinderGeometry(0.06, 0.06, 1.9, 5);
    for (const side of [-1, 1]) {
      for (const z of [-L * 0.06, L * 0.05]) {
        const x = side * (B * 0.30);
        add(aaBase, darkMat, x, F + 1.35, z);
        add(aaGun, darkMat, x, F + 1.65, z, 0.5, 0, side * 0.4);
        add(aaGun, darkMat, x, F + 1.65, z, 0.5, 0, -side * 0.4);
      }
    }
    const boatGeo = new THREE.CapsuleGeometry(0.55, 2.6, 4, 8);
    boatGeo.rotateZ(Math.PI / 2);
    add(boatGeo, this.supMat, -B * 0.30, F + 1.45, L * 0.01);
    add(boatGeo, this.supMat, B * 0.30, F + 1.45, L * 0.01);
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.8, 0.5, 1.6), darkMat, side * B * 0.26, F + 0.6, L * 0.30);
      add(new THREE.CylinderGeometry(0.16, 0.16, 0.8, 6), darkMat, side * B * 0.26, F + 0.9, L * 0.30);
    }

    // jackstaff pennant for a spot of colour
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 0.55),
      new THREE.MeshBasicMaterial({ color: this.isPlayer ? 0xffb545 : 0x8f2b1c, side: THREE.DoubleSide }),
    );
    flag.position.set(0, F + 2.2, -L * 0.08);
    flag.rotation.y = Math.PI / 2;
    this.root.add(flag);

    this.scene.add(this.root);
  }

  // ------------------------------------------------------------------ physics
  step(dt, sea) {
    this.sea = sea || this.sea;
    if (this.sinking) { this._sinkStep(dt); return; }

    const spec = this.spec;

    // ---- engine ----
    const tgt = this.throttle >= 0
      ? this.throttle * spec.maxSpeed * this.engineFactor
      : this.throttle * spec.astern;
    const hardTurn = 1 - 0.20 * Math.abs(this.rudderAngle) * Math.min(1, Math.abs(this.speed) / spec.maxSpeed);
    const rate = (Math.abs(tgt) > Math.abs(this.speed)) ? spec.accel : spec.decel;
    this.speed += clamp(tgt * hardTurn - this.speed, -rate * dt * 2.2, rate * dt);

    // ---- rudder & yaw ----
    this.rudderAngle += clamp(this.rudder - this.rudderAngle, -spec.rudderRate * dt, spec.rudderRate * dt);
    const sf = clamp(Math.abs(this.speed) / (0.28 * spec.maxSpeed), 0, 1)
      * (1 - 0.22 * Math.abs(this.speed) / spec.maxSpeed);
    const tgtYawRate = this.rudderAngle * spec.turnRate * sf * (this.speed < -0.2 ? -1 : 1);
    this.yawRate += (tgtYawRate - this.yawRate) * Math.min(1, dt * 1.25);
    this.yaw += this.yawRate * dt;

    // ships heel outward in a hard turn (starboard dips on a port turn)
    const heelT = -this.rudderAngle * sf * Math.min(1, Math.abs(this.speed) / (0.55 * spec.maxSpeed)) * 0.13;
    this.heel += (heelT - this.heel) * Math.min(1, dt * 0.8);

    this.forward(_fwd);
    this.pos.x += _fwd.x * this.speed * SHIP_TRAVEL_SPEED_MULTIPLIER * dt;
    this.pos.z += _fwd.z * this.speed * SHIP_TRAVEL_SPEED_MULTIPLIER * dt;

    // ---- buoyancy: ride the Gerstner sea ----
    if (this.sea) {
      const L = spec.length, B = spec.beam;
      this.right(_rgt);
      const bx = this.pos.x + _fwd.x * L * 0.42, bz = this.pos.z + _fwd.z * L * 0.42;
      const sx = this.pos.x - _fwd.x * L * 0.42, sz = this.pos.z - _fwd.z * L * 0.42;
      const px = this.pos.x - _rgt.x * B * 0.5, pz = this.pos.z - _rgt.z * B * 0.5;
      const qx = this.pos.x + _rgt.x * B * 0.5, qz = this.pos.z + _rgt.z * B * 0.5;
      const hb = this.sea.surfaceHeight(bx, bz);
      const hs = this.sea.surfaceHeight(sx, sz);
      const hp = this.sea.surfaceHeight(px, pz);
      const hq = this.sea.surfaceHeight(qx, qz);

      const avg = (hb + hs + hp + hq) * 0.25;
      this.pos.y += (avg - this.pos.y) * Math.min(1, dt * 2.6);

      const pitchT = Math.atan2(hb - hs, L * 0.84) * 0.92;
      const rollT = Math.atan2(hq - hp, B) * 0.92;
      this.pitch += (pitchT - this.pitch) * Math.min(1, dt * 2.3);
      this.roll += (rollT - this.roll) * Math.min(1, dt * 1.9);

      // bow spray when she digs into a wave at speed
      if (this.fx && Math.abs(this.speed) > 7) {
        const bowY = this.pos.y + Math.sin(this.pitch) * L * 0.42;
        const dig = hb - bowY;
        if (dig > 0.9 && Math.random() < 0.7) {
          this.fx.bowSpray(bx, hb + 0.4, bz, _fwd, Math.min(2.2, dig), Math.abs(this.speed));
        }
      }
    }

    this._applyTransform();

    // ---- wake, funnel smoke, fires ----
    this._shipFx(dt);

    // ---- turret recoil anim ----
    for (const t of this.turrets) {
      if (t.recoil > 0) {
        t.recoil = Math.max(0, t.recoil - dt * 2.4);
        t.pivot.position.z = -0.9 + t.recoil * 0.55;
      }
    }

    // ---- hit flash ----
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt);
      const k = (this.flash / 0.22) * 0.9;
      this.hullMat.emissive.setRGB(k, k * 0.4, k * 0.16);
      this.supMat.emissive.setRGB(k, k * 0.4, k * 0.16);
    }
  }

  _applyTransform() {
    this.root.position.copy(this.pos);
    _q1.setFromAxisAngle(UP, this.yaw);
    _v1.set(1, 0, 0);
    _q2.setFromAxisAngle(_v1, this.pitch);
    _q1.multiply(_q2);
    _v1.set(0, 0, 1);
    _q2.setFromAxisAngle(_v1, this.roll + this.heel);
    _q1.multiply(_q2);
    this.root.quaternion.copy(_q1);
  }

  _shipFx(dt) {
    if (!this.fx) return;
    const spec = this.spec;
    const sp = Math.abs(this.speed);

    // propeller wash + trailing foam
    this._fxAcc += dt;
    if (this._fxAcc > 0.09 && sp > 1.2) {
      this._fxAcc = 0;
      this.forward(_fwd);
      _v1.copy(this.pos).addScaledVector(_fwd, -spec.length * 0.48);
      _v1.y = this.sea ? this.sea.surfaceHeight(_v1.x, _v1.z) - 0.15 : WATER_LEVEL;
      const k = Math.min(1, sp / spec.maxSpeed);
      this.fx.wake(_v1, _fwd, k, spec.length);
    }

    // funnel smoke — she's oil-fired and proud of it
    this._smokeAcc += dt;
    if (this._smokeAcc > 0.16) {
      this._smokeAcc = 0;
      const k = Math.min(1, Math.abs(this.speed) / spec.maxSpeed);
      for (let i = 0; i < this.funnelTops.length; i++) {
        const f = this.funnelTops[i];
        _v1.set(f.x, f.y, f.z).applyQuaternion(this.root.quaternion).add(this.pos);
        this.fx.funnel(_v1, k, this.isPlayer);
      }
    }

    // fires when badly hurt
    if (this.hp < this.maxHp * 0.42 && Math.random() < dt * 6) {
      _v1.set((Math.random() - 0.5) * spec.beam * 0.5, spec.freeboard + 2, (Math.random() - 0.5) * spec.length * 0.3);
      _v1.applyQuaternion(this.root.quaternion).add(this.pos);
      this.fx.fire(_v1, 1);
    }
  }

  // ------------------------------------------------------------------ guns
  aimTurrets(aim, dt) {
    const spec = this.spec;
    const dx = aim.x - this.pos.x;
    const dz = aim.z - this.pos.z;
    const worldYaw = Math.atan2(-dx, -dz);
    let readyCount = 0;

    for (const t of this.turrets) {
      const desired = wrapAngle(worldYaw - this.yaw);
      const err = wrapAngle(desired - t.yaw);
      t.yaw += clamp(err, -spec.traverse * dt, spec.traverse * dt);
      t.mount.rotation.y = t.yaw;

      // elevation from this turret's gun position to the aim point
      _v1.set(0, spec.gunH - spec.freeboard, t.baseZ).applyQuaternion(this.root.quaternion).add(this.pos);
      const hx = aim.x - _v1.x;
      const hz = aim.z - _v1.z;
      const horiz = Math.hypot(hx, hz);
      const dy = aim.y - _v1.y;
      const e = clamp(ballisticPitch(spec.shellSpeed, 9.81, horiz, dy), -0.10, 0.55);
      t.pitch += clamp(e - t.pitch, -spec.gunPitchRate * dt, spec.gunPitchRate * dt);
      t.pivot.rotation.x = t.pitch;

      t.ready = Math.abs(err) < 0.08 && Math.abs(e - t.pitch) < 0.06;
      if (t.ready) readyCount++;
    }
    this._turretsReady = readyCount;
  }

  get turretsReady() { return this._turretsReady; }

  /** Fire every turret that is on target. Returns shot list or null. */
  fireSalvo(spreadRad = this.spec.spread) {
    if (this.sinking || this.gunReload > 0) return null;
    const shots = [];
    this.root.updateMatrixWorld(true);
    let bigMuzzle = false;
    for (const t of this.turrets) {
      if (!t.ready) continue;
      for (const mz of t.muzzles) {
        mz.getWorldPosition(_v1);
        mz.getWorldQuaternion(_q1);
        _v2.set(0, 0, -1).applyQuaternion(_q1);
        _v2.x += (Math.random() - 0.5) * spreadRad * 2;
        _v2.y += (Math.random() - 0.5) * spreadRad * 1.1;
        _v2.z += (Math.random() - 0.5) * spreadRad * 2;
        shots.push({ pos: _v1.clone(), dir: _v2.clone().normalize() });
      }
      t.recoil = 1;
      if (!bigMuzzle && this.fx) {
        bigMuzzle = true;
        this.fx.muzzle(_v1, _v2, this.spec.length > 150 ? 1.7 : 1.1);
      }
    }
    if (shots.length) this.gunReload = this.spec.reload;
    return shots.length ? shots : null;
  }

  /** Launch a torpedo spread toward a world yaw. Returns launches or null. */
  fireTorpedoes(worldYaw) {
    const spec = this.spec.torps;
    if (!spec || this.sinking || this.torpSalvos <= 0) return null;
    const launches = [];
    const n = spec.perSalvo;
    for (let i = 0; i < n; i++) {
      const a = worldYaw + (i - (n - 1) / 2) * spec.spread;
      launches.push({
        x: this.pos.x - Math.sin(this.yaw) * 4 - Math.sin(a) * 8,
        z: this.pos.z - Math.cos(this.yaw) * 4 - Math.cos(a) * 8,
        yaw: a,
        speed: spec.speed + Math.max(0, this.speed),
        range: spec.range,
        owner: this,
      });
    }
    this.torpSalvos--;
    if (this.torpSalvos === 1 && this.torpReload <= 0) this.torpReload = spec.reload;
    return launches;
  }

  updateReloads(dt) {
    if (this.gunReload > 0) this.gunReload = Math.max(0, this.gunReload - dt);
    const spec = this.spec.torps;
    if (spec && this.torpReload > 0) {
      this.torpReload = Math.max(0, this.torpReload - dt);
      if (this.torpReload <= 0 && this.torpSalvos < 2) {
        this.torpSalvos++;
        if (this.torpSalvos < 2) this.torpReload = spec.reload;
      }
    }
  }

  // -------------------------------------------------------------- damage in
  /**
   * Swept segment (a->b) against the hull in yaw-local space.
   * Returns { point, module, points, mult, critChance } or null.
   */
  checkHit(a, b) {
    if (this.gone) return null;
    const spec = this.spec;
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

    const lo = [-spec.beam / 2 - 0.6, -spec.draft, -spec.length * 0.48];
    const hi = [spec.beam / 2 + 0.6, spec.freeboard + 9, spec.length * 0.48];

    let tmin = 0, tmax = 1;
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
    let points = 180;
    let mult = 1;
    let critChance = 0;

    if (hy > 2.2 && this.turrets.some((t) => Math.abs(hz - t.baseZ) < 4.5)) {
      module = 'turret'; points = 420; mult = 1.3;
    } else if (hy > 5 && Math.abs(hz) < spec.length * 0.16) {
      module = 'bridge'; points = 380; mult = 1.15;
    } else if (hy < 0.8 && Math.abs(hz) < spec.length * 0.13) {
      module = 'magazine'; points = 1500; mult = 1; critChance = 0.16;
    } else if (hy > 3 && this.spec.funnels.some((f) => Math.abs(hz - f.z) < 6)) {
      module = 'engine'; points = 350; mult = 1;
    }

    const point = new THREE.Vector3(
      a.x + (b.x - a.x) * tmin,
      a.y + (b.y - a.y) * tmin,
      a.z + (b.z - a.z) * tmin,
    );
    return { point, module, points, mult, critChance };
  }

  takeDamage(amount, module) {
    if (this.sinking) return false;
    this.hp -= amount;
    this.flash = 0.22;
    if (module === 'engine') this.engineFactor = Math.max(0.55, this.engineFactor - 0.14);
    if (this.hp <= 0) {
      this.startSink(false);
      return true;
    }
    return false;
  }

  startSink(catastrophic) {
    if (this.sinking) return;
    this.sinking = true;
    this.sinkT = 0;
    this.listDir = Math.random() < 0.5 ? -1 : 1;
    this.pitchDir = Math.random() < 0.65 ? 1 : -1;
    this.sinkBoost = catastrophic ? 2.4 : 1;
    this.hp = 0;
    this.rudder = 0;
    if (this.fx) {
      _v1.copy(this.pos); _v1.y += 4;
      this.fx.explosion(_v1, 2.6);
    }
  }

  _sinkStep(dt) {
    this.sinkT += dt * this.sinkBoost;
    const t = this.sinkT;
    this.speed *= Math.max(0, 1 - dt * 0.5);
    this.forward(_fwd);
    this.pos.x += _fwd.x * this.speed * dt;
    this.pos.z += _fwd.z * this.speed * dt;

    this.roll += (this.listDir * 0.62 - this.roll) * Math.min(1, dt * 0.24);
    this.pitch += (this.pitchDir * 0.34 - this.pitch) * Math.min(1, dt * 0.18);
    this.pos.y -= (0.30 + t * 0.11) * dt;

    this._applyTransform();

    // churning foam + escaping steam while she goes down
    this._fxAcc += dt;
    if (this.fx && this._fxAcc > 0.07) {
      this._fxAcc = 0;
      const spec = this.spec;
      this.right(_rgt);
      for (let i = 0; i < 3; i++) {
        _v1.copy(this.pos)
          .addScaledVector(_fwd, (Math.random() - 0.5) * spec.length * 0.7)
          .addScaledVector(_rgt, (Math.random() - 0.5) * spec.beam * 1.4);
        const wy = this.sea ? this.sea.surfaceHeight(_v1.x, _v1.z) : WATER_LEVEL;
        _v1.y = wy - 0.1;
        this.fx.sinkFoam(_v1, t);
      }
      if (Math.random() < 0.5) {
        _v1.set((Math.random() - 0.5) * 4, spec.freeboard + 3, (Math.random() - 0.5) * spec.length * 0.3)
          .applyQuaternion(this.root.quaternion).add(this.pos);
        this.fx.steam(_v1);
      }
    }

    if (t > 15) this.gone = true;
  }

  dispose() {
    this.scene.remove(this.root);
    this.hullMat.dispose();
    this.supMat.dispose();
  }
}
