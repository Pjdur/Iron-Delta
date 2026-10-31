import * as THREE from 'three';
import { heightAt, normalAt, vegDensity, WATER_LEVEL, HALF } from './terrain.js';
import { mulberry32 } from './noise.js';

// ---------------------------------------------------------------------------
// Shared wind uniforms (driven every frame from main.js)
// ---------------------------------------------------------------------------
export const windUniforms = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(0.86, 0.51).normalize() },
};

/**
 * Patches a material so that vertices above `base` (local Y) sway in the wind.
 * The offset is added in object space AFTER instancing, which keeps the wind
 * direction coherent across randomly rotated instances.
 */
function patchWind(mat, base, span, amp, speed) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec2 uWind;
         vec3 vWindOffset;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 wOrigin = instanceMatrix[3].xyz;
          #else
            vec3 wOrigin = vec3(0.0);
          #endif
          float ph = wOrigin.x * 0.31 + wOrigin.z * 0.27;
          float gust = 0.5 + 0.5 * sin(uTime * 0.55 + wOrigin.x * 0.005 + wOrigin.z * 0.004);
          float s1 = sin(uTime * ${speed.toFixed(3)} + ph);
          float s2 = sin(uTime * ${(speed * 2.17).toFixed(3)} + ph * 1.7);
          float w = s1 * 0.7 + s2 * 0.3;
          float hn = clamp((position.y - ${base.toFixed(3)}) / ${span.toFixed(3)}, 0.0, 1.0);
          float amt = hn * hn * ${amp.toFixed(3)} * (0.45 + gust * 1.1);
          vWindOffset = vec3(uWind.x, 0.0, uWind.y) * (w * amt);
        }`
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition.xyz += vWindOffset;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`
      );
  };
  mat.customProgramCacheKey = () =>
    `wind_${base}_${span}_${amp}_${speed}`;
  return mat;
}

// ---------------------------------------------------------------------------
// TREE PLACEMENT
// ---------------------------------------------------------------------------
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();

function scatter(count, opts) {
  const rnd = mulberry32(opts.seed || 1234);
  const out = [];
  let tries = 0;
  const maxTries = count * 16;
  while (out.length < count && tries < maxTries) {
    tries++;
    const x = (rnd() * 2 - 1) * (HALF - 80);
    const z = (rnd() * 2 - 1) * (HALF - 80);
    const d = Math.sqrt(x * x + z * z);
    if (d < (opts.minRadius || 90)) continue;

    const h = heightAt(x, z);
    if (h < WATER_LEVEL + 3) continue;
    if (h > (opts.maxHeight || 320)) continue;

    normalAt(x, z, _n);
    if (_n.y < (opts.minNormalY || 0.87)) continue;

    const dens = vegDensity(x, z);
    const spawnPenalty = d < 300 ? 0.12 : 1;
    if (rnd() > (0.22 + dens * 0.9) * spawnPenalty * (opts.density || 1)) continue;

    out.push({ x, y: h, z, rnd: rnd() });
  }
  return out;
}

function makeInstanced(geo, mat, mats, colors, castShadow) {
  const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
  for (let i = 0; i < mats.length; i++) {
    mesh.setMatrixAt(i, mats[i]);
    if (colors) mesh.setColorAt(i, colors[i]);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = !!castShadow;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// VEGETATION
// ---------------------------------------------------------------------------
export class Vegetation {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.instanced = [];
    this._buildTrees();
    this._buildScrub();
  }

  /** Fraction of instances to draw (0..1) — cheap runtime density control. */
  setCountScale(s) {
    for (const { mesh, max } of this.instanced) {
      mesh.count = Math.max(1, Math.floor(max * s));
    }
  }

  _buildTrees() {
    // -------- gathering --------
    const coniferPts = scatter(1050, { seed: 91, density: 1.25 });
    const broadPts = scatter(700, { seed: 442, density: 1.0, minRadius: 120 });

    const coniferMats = [];
    const coniferCols = [];
    const broadMats = [];
    const broadCols = [];

    for (const p of coniferPts) {
      const sc = 0.72 + p.rnd * 0.85;
      _q.setFromEuler(_e.set(0, p.rnd * Math.PI * 2, 0));
      _s.set(sc, sc * (0.9 + p.rnd * 0.45), sc);
      _p.set(p.x, p.y - 0.3, p.z);
      coniferMats.push(new THREE.Matrix4().compose(_p, _q, _s));
      const tint = 0.78 + p.rnd * 0.4;
      coniferCols.push(new THREE.Color(0.16 * tint, 0.29 * tint, 0.13 * tint));
    }

    for (const p of broadPts) {
      const sc = 0.8 + p.rnd * 0.9;
      _q.setFromEuler(_e.set(0, p.rnd * Math.PI * 2, 0));
      _s.set(sc, sc * (0.85 + p.rnd * 0.5), sc);
      _p.set(p.x, p.y - 0.3, p.z);
      broadMats.push(new THREE.Matrix4().compose(_p, _q, _s));
      const tint = 0.8 + p.rnd * 0.45;
      broadCols.push(new THREE.Color(0.22 * tint, 0.31 * tint, 0.12 * tint));
    }

    // -------- conifer: trunk + 3 foliage tiers --------
    const trunkMat = patchWind(
      new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 1.0, metalness: 0.0 }),
      0, 3.2, 0.05, 1.5
    );
    const conifMat = patchWind(
      new THREE.MeshStandardMaterial({ color: 0x2e4a26, roughness: 0.95, metalness: 0.0, flatShading: true }),
      0.8, 8.4, 0.30, 1.35
    );

    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.28, 3.4, 6);
    trunkGeo.translate(0, 1.7, 0);
    this._add(makeInstanced(trunkGeo, trunkMat, coniferMats, null, true));

    const tiers = [
      { r: 2.15, h: 4.4, y: 3.6, shadow: true },
      { r: 1.60, h: 3.6, y: 5.8, shadow: false },
      { r: 1.02, h: 2.8, y: 7.9, shadow: false },
    ];
    for (const t of tiers) {
      const g = new THREE.ConeGeometry(t.r, t.h, 7, 1);
      g.translate(0, t.y, 0);
      this._add(makeInstanced(g, conifMat, coniferMats, coniferCols, t.shadow));
    }

    // -------- broadleaf: trunk + canopy --------
    const bTrunkMat = patchWind(
      new THREE.MeshStandardMaterial({ color: 0x50402c, roughness: 1.0, metalness: 0.0 }),
      0, 3.4, 0.06, 1.4
    );
    const canopyMat = patchWind(
      new THREE.MeshStandardMaterial({ color: 0x3c5b22, roughness: 0.95, metalness: 0.0, flatShading: true }),
      1.4, 6.0, 0.34, 1.15
    );

    const bTrunkGeo = new THREE.CylinderGeometry(0.18, 0.32, 3.8, 6);
    bTrunkGeo.translate(0, 1.9, 0);
    this._add(makeInstanced(bTrunkGeo, bTrunkMat, broadMats, null, true));

    const canopyGeo = new THREE.IcosahedronGeometry(2.6, 0);
    canopyGeo.scale(1, 0.82, 1);
    canopyGeo.translate(0, 5.4, 0);
    this._add(makeInstanced(canopyGeo, canopyMat, broadMats, broadCols, true));

    const canopyGeo2 = new THREE.IcosahedronGeometry(1.7, 0);
    canopyGeo2.scale(1, 0.8, 1);
    canopyGeo2.translate(0.9, 6.6, -0.4);
    this._add(makeInstanced(canopyGeo2, canopyMat, broadMats, broadCols, false));
  }

  _add(mesh) {
    this.group.add(mesh);
    this.instanced.push({ mesh, max: mesh.count });
    return mesh;
  }

  _buildScrub() {
    // ---- bushes ----
    const bushPts = scatter(850, { seed: 777, density: 1.7, minNormalY: 0.8, maxHeight: 380 });
    const bushMats = [];
    const bushCols = [];
    for (const p of bushPts) {
      const sc = 0.5 + p.rnd * 0.9;
      _q.setFromEuler(_e.set(0, p.rnd * Math.PI * 2, 0));
      _s.set(sc * 1.15, sc * 0.72, sc * 1.15);
      _p.set(p.x, p.y + 0.15, p.z);
      bushMats.push(new THREE.Matrix4().compose(_p, _q, _s));
      const tint = 0.75 + p.rnd * 0.5;
      bushCols.push(new THREE.Color(0.20 * tint, 0.28 * tint, 0.12 * tint));
    }
    const bushGeo = new THREE.IcosahedronGeometry(1.0, 0);
    const bushMat = patchWind(
      new THREE.MeshStandardMaterial({ color: 0x40551f, roughness: 1.0, flatShading: true }),
      0, 1.0, 0.10, 2.2
    );
    this._add(makeInstanced(bushGeo, bushMat, bushMats, bushCols, false));

    // ---- rocks ----
    const rockPts = scatter(420, { seed: 314, density: 1.4, minNormalY: 0.55, maxHeight: 600 });
    const rockMats = [];
    const rockCols = [];
    for (const p of rockPts) {
      const sc = 0.6 + p.rnd * 2.6;
      _q.setFromEuler(_e.set(p.rnd * 0.6, p.rnd * Math.PI * 2, p.rnd * 0.6));
      _s.set(sc, sc * (0.55 + p.rnd * 0.5), sc * (0.8 + p.rnd * 0.5));
      _p.set(p.x, p.y - sc * 0.18, p.z);
      rockMats.push(new THREE.Matrix4().compose(_p, _q, _s));
      const tint = 0.75 + p.rnd * 0.45;
      rockCols.push(new THREE.Color(0.40 * tint, 0.39 * tint, 0.36 * tint));
    }
    const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x77746c, roughness: 0.95, flatShading: true });
    this._add(makeInstanced(rockGeo, rockMat, rockMats, rockCols, true));
  }
}

// ---------------------------------------------------------------------------
// GRASS — a camera-centred field of instanced blades that regenerates
// one cell at a time as the tank moves.
// ---------------------------------------------------------------------------
export class Grass {
  constructor(scene) {
    this.cell = 6;              // metres per cell
    this.cols = 28;
    this.rows = 28;
    this.perCell = 16;
    this.count = this.cols * this.rows * this.perCell;

    const geo = new THREE.BufferGeometry();
    const w0 = 0.052, w1 = 0.017, h = 0.86;
    const pos = new Float32Array([
      -w0, 0, 0,
      w0, 0, 0,
      -w1, h, 0,
      w1, h, 0,
    ]);
    const nor = new Float32Array([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]);
    const col = new Float32Array([
      0.20, 0.26, 0.10,
      0.20, 0.26, 0.10,
      0.46, 0.56, 0.24,
      0.46, 0.56, 0.24,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);

    const mat = patchWind(
      new THREE.MeshLambertMaterial({
        color: 0xffffff,
        vertexColors: true,
        side: THREE.DoubleSide,
      }),
      0, 0.86, 0.34, 2.4
    );

    // distance fade: blades sink into the ground at the edge of the field
    mat.onBeforeCompile = ((orig) => (shader) => {
      orig(shader);
      shader.vertexShader = shader.vertexShader.replace(
        'mvPosition.xyz += vWindOffset;',
        `mvPosition.xyz += vWindOffset;
         float fadeDist = length(mvPosition.xz - cameraPosition.xz);
         float fade = 1.0 - smoothstep(112.0, 158.0, fadeDist);
         mvPosition.y -= (1.0 - fade) * 2.2;`
      );
    })(mat.onBeforeCompile);

    this.mesh = new THREE.InstancedMesh(geo, mat, this.count);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);

    this.cellX = new Int32Array(this.cols * this.rows).fill(0x7fffffff);
    this.cellZ = new Int32Array(this.cols * this.rows).fill(0x7fffffff);
    this.baseX = 1e9;
    this.baseZ = 1e9;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    // colour the whole field once so unfilled instances aren't white
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < this.count; i++) this.mesh.setColorAt(i, white);
  }

  _regenCell(idx, cx, cz) {
    const rnd = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x9e3779b9);
    const start = idx * this.perCell;
    const cw = this.cell;

    for (let k = 0; k < this.perCell; k++) {
      const i = start + k;
      const x = cx * cw + rnd() * cw;
      const z = cz * cw + rnd() * cw;
      const h = heightAt(x, z);

      if (h < WATER_LEVEL + 1.5) {
        // underwater: collapse the blade
        this._p.set(x, -9999, z);
        this._s.set(0.001, 0.001, 0.001);
        this._q.identity();
        this._m.compose(this._p, this._q, this._s);
        this.mesh.setMatrixAt(i, this._m);
        continue;
      }

      const scale = 0.75 + rnd() * 1.15;
      this._p.set(x, h - 0.03, z);
      this._q.setFromEuler(this._e.set(0, rnd() * Math.PI * 2, 0));
      this._s.set(scale * (0.7 + rnd() * 0.6), scale, 1);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);

      const t = rnd();
      this._c.setRGB(
        0.72 + t * 0.55,
        0.92 + t * 0.25,
        0.55 + t * 0.45
      );
      this.mesh.setColorAt(i, this._c);
    }
  }

  update(playerPos) {
    const halfX = (this.cols * this.cell) * 0.5;
    const halfZ = (this.rows * this.cell) * 0.5;
    const baseX = Math.floor((playerPos.x - halfX) / this.cell);
    const baseZ = Math.floor((playerPos.z - halfZ) / this.cell);
    if (baseX === this.baseX && baseZ === this.baseZ) return;

    this.baseX = baseX;
    this.baseZ = baseZ;

    let dirty = false;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const idx = j * this.cols + i;
        const cx = baseX + i;
        const cz = baseZ + j;
        if (this.cellX[idx] !== cx || this.cellZ[idx] !== cz) {
          this.cellX[idx] = cx;
          this.cellZ[idx] = cz;
          this._regenCell(idx, cx, cz);
          dirty = true;
        }
      }
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Force a full rebuild (used once during loading). */
  rebuild(playerPos) {
    this.baseX = 1e9;
    this.baseZ = 1e9;
    this.update(playerPos);
  }

  /** Draw only the first n blades (quality scaling). */
  setCount(n) {
    this.mesh.count = Math.max(0, Math.min(this.count, Math.floor(n)));
  }
}
