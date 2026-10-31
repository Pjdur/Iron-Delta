import * as THREE from 'three';
import { makeNoise2D, makeFbm, smoothstep } from './noise.js';

// ---------------------------------------------------------------------------
// WORLD CONSTANTS
// ---------------------------------------------------------------------------
// terrain.js
export const CHUNK = 600;                 // size of one terrain chunk (metres)
export const GRID = 8;                    // 8 x 8 chunks
export const WORLD_SIZE = CHUNK * GRID;   // 4800 m across
export const HALF = WORLD_SIZE / 2;
export const WATER_LEVEL = -34;
export const PLAY_RADIUS = 2350;          // Increased to reach the mountains
const FINE_SEGS = 80;
const COARSE_SEGS = 12;

// ---------------------------------------------------------------------------
// HEIGHT FIELD
// ---------------------------------------------------------------------------
const fbmA = makeFbm(makeNoise2D(1337));
const fbmB = makeFbm(makeNoise2D(88221));
const fbmC = makeFbm(makeNoise2D(55123));

/** World height in metres at a given XZ. Cheap enough to call from physics. */
export function heightAt(x, z) {
  let h = fbmA(x * 0.00042, z * 0.00042, 4) * 130;          // landforms
  h += fbmA(x * 0.0019, z * 0.0019, 3) * 26;                // hills
  h += fbmB(x * 0.0072, z * 0.0072, 2) * 4.2;               // dunes / waves
  h += fbmC(x * 0.031, z * 0.031, 1) * 0.8;                 // micro bumps

  const d = Math.sqrt(x * x + z * z);

  // Mountain ring enclosing the playable valley.
  const rim = smoothstep(1350, 2350, d);
  if (rim > 0) {
    const rn = fbmB(x * 0.00085 + 40.5, z * 0.00085 - 19.5, 4) * 0.5 + 0.5;
    h += rim * (100 + rn * rn * 760);
  }

  // Flattened deployment plateau at the centre of the map.
  const flat = 1 - smoothstep(40, 220, d);
  if (flat > 0) h *= 1 - 0.9 * flat;

  return h;
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

/** Analytic surface normal. */
export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 1.0;
  const hl = heightAt(x - e, z);
  const hr = heightAt(x + e, z);
  const hd = heightAt(x, z - e);
  const hu = heightAt(x, z + e);
  return out.set(hl - hr, 2 * e, hd - hu).normalize();
}

/** Forest-density field (0..1) used by the vegetation scatterer. */
export function vegDensity(x, z) {
  return fbmA(x * 0.0015 + 9, z * 0.0015 - 4, 3) * 0.5 + 0.5;
}

// ---------------------------------------------------------------------------
// VERTEX COLOURING
// ---------------------------------------------------------------------------
const C_GRASS_A = new THREE.Color(0x46552a);
const C_GRASS_B = new THREE.Color(0x6d7a3e);
const C_MUD = new THREE.Color(0x3b2f24);
const C_ROCK = new THREE.Color(0x6d6b66);
const C_SNOW = new THREE.Color(0xdde7ef);
const C_SAND = new THREE.Color(0x8a7a5a);

function colorAt(x, z, h, slope, out) {
  const t = fbmB(x * 0.0025, z * 0.0025, 2) * 0.5 + 0.5;
  out.copy(C_GRASS_A).lerp(C_GRASS_B, t);

  // Wet mud patches — the ground the tracks will churn up.
  const mudN = fbmC(x * 0.0055 + 3.1, z * 0.0055 - 7.7, 3);
  out.lerp(C_MUD, smoothstep(0.15, 0.72, mudN) * 0.55);

  // Rock on steep faces.
  out.lerp(C_ROCK, smoothstep(0.38, 0.75, slope));

  // Snow on the peaks.
  const snowLine = 330 + fbmC(x * 0.01, z * 0.01, 1) * 45;
  out.lerp(C_SNOW, smoothstep(snowLine, snowLine + 210, h));

  // Wet sand / silt at the waterline.
  out.lerp(C_SAND, smoothstep(WATER_LEVEL + 16, WATER_LEVEL + 1, h));

  return out;
}

// ---------------------------------------------------------------------------
// DETAIL TEXTURE (ground grain)
// ---------------------------------------------------------------------------
function makeDetailTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  const rnd = () => Math.random();

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // wrap-safe speckle: blend four corners for seamless tiling
      const n =
        Math.sin((x / S) * Math.PI * 2) * 6 +
        Math.sin((y / S) * Math.PI * 2) * 6 +
        (rnd() - 0.5) * 26;
      const v = 214 + n;
      img.data[i] = v * 0.98;
      img.data[i + 1] = v;
      img.data[i + 2] = v * 0.94;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Blotchy darker soil patches
  for (let k = 0; k < 90; k++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 4 + Math.random() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(90,78,60,0.30)');
    g.addColorStop(1, 'rgba(90,78,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------------------
// CHUNK GEOMETRY
// ---------------------------------------------------------------------------
function buildChunkGeometry(cx, cz, size, segs) {
  const n = segs + 1;
  const step = size / segs;
  const ox = cx - size * 0.5;
  const oz = cz - size * 0.5;

  const vcount = n * n + 4 * n;
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);

  const c = new THREE.Color();

  // Sample heights on a padded grid so normals can be derived with central
  // differences instead of four extra heightAt() calls per vertex.
  const en = n + 2;
  const hs = new Float32Array(en * en);
  for (let iz = -1; iz <= n; iz++) {
    for (let ix = -1; ix <= n; ix++) {
      hs[(iz + 1) * en + (ix + 1)] = heightAt(ox + ix * step, oz + iz * step);
    }
  }
  const hAt = (ix, iz) => hs[(iz + 1) * en + (ix + 1)];

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const wx = ox + ix * step;
      const wz = oz + iz * step;
      const h = hAt(ix, iz);

      pos[i * 3] = wx; pos[i * 3 + 1] = h; pos[i * 3 + 2] = wz;

      const hl = hAt(ix - 1, iz);
      const hr = hAt(ix + 1, iz);
      const hd = hAt(ix, iz - 1);
      const hu = hAt(ix, iz + 1);
      let nx = hl - hr;
      let ny = 2 * step;
      let nz = hd - hu;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;

      nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz;

      colorAt(wx, wz, h, 1 - ny, c);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;

      uvs[i * 2] = wx / 46; uvs[i * 2 + 1] = wz / 46;
    }
  }

  const indices = [];
  for (let iz = 0; iz < segs; iz++) {
    for (let ix = 0; ix < segs; ix++) {
      const a = iz * n + ix;
      const b = a + 1;
      const cc = a + n;
      const d = cc + 1;
      indices.push(a, cc, b, b, cc, d);
    }
  }

  // ---- skirts: hide seams between chunks of different resolution ----
  const drop = Math.max(8, size * 0.07);
  const edges = [
    Array.from({ length: n }, (_, ix) => ix),
    Array.from({ length: n }, (_, ix) => segs * n + ix),
    Array.from({ length: n }, (_, iz) => iz * n),
    Array.from({ length: n }, (_, iz) => iz * n + segs),
  ];

  let vptr = n * n;
  for (const edge of edges) {
    const base = vptr;
    for (let k = 0; k < n; k++) {
      const top = edge[k];
      const j = vptr + k;
      pos[j * 3] = pos[top * 3];
      pos[j * 3 + 1] = pos[top * 3 + 1] - drop;
      pos[j * 3 + 2] = pos[top * 3 + 2];
      nor[j * 3] = nor[top * 3];
      nor[j * 3 + 1] = nor[top * 3 + 1];
      nor[j * 3 + 2] = nor[top * 3 + 2];
      col[j * 3] = col[top * 3] * 0.5;
      col[j * 3 + 1] = col[top * 3 + 1] * 0.5;
      col[j * 3 + 2] = col[top * 3 + 2] * 0.5;
      uvs[j * 2] = uvs[top * 2]; uvs[j * 2 + 1] = uvs[top * 2 + 1];
    }
    vptr += n;
    for (let k = 0; k < n - 1; k++) {
      const t0 = edge[k], t1 = edge[k + 1];
      const b0 = base + k, b1 = base + k + 1;
      indices.push(t0, b0, t1, t1, b0, b1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// TERRAIN MANAGER
// ---------------------------------------------------------------------------
export class Terrain {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: makeDetailTexture(),
      roughness: 0.97,
      metalness: 0.0,
      side: THREE.DoubleSide,
      dithering: true,
    });

    this.chunks = [];
    this._queue = [];
    this.fineRadius = 700;
    this._fineRadius2 = this.fineRadius * this.fineRadius;

    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        const cx = (gx + 0.5) * CHUNK - HALF;
        const cz = (gz + 0.5) * CHUNK - HALF;
        const coarse = buildChunkGeometry(cx, cz, CHUNK, COARSE_SEGS);
        const mesh = new THREE.Mesh(coarse, this.material);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.group.add(mesh);
        const ch = { cx, cz, mesh, coarse, fine: null };
        this.chunks.push(ch);
        this._queue.push(ch);
      }
    }
  }

  get total() { return this._queue.length + this.chunks.length; }

  /** Builds up to `count` high-detail chunks. Returns how many remain. */
  stepBuild(count) {
    for (let i = 0; i < count && this._queue.length; i++) {
      const ch = this._queue.shift();
      if (!ch.fine) ch.fine = buildChunkGeometry(ch.cx, ch.cz, CHUNK, FINE_SEGS);
    }
    return this._queue.length;
  }

  get remaining() { return this._queue.length; }

  /** Swap chunk LOD based on camera distance. */
  update(camPos) {
    this._fineRadius2 = this.fineRadius * this.fineRadius;
    for (let i = 0; i < this.chunks.length; i++) {
      const ch = this.chunks[i];
      const dx = camPos.x - ch.cx;
      const dz = camPos.z - ch.cz;
      const near = dx * dx + dz * dz < this._fineRadius2;
      const target = near && ch.fine ? ch.fine : ch.coarse;
      if (ch.mesh.geometry !== target) ch.mesh.geometry = target;
    }
  }
}
