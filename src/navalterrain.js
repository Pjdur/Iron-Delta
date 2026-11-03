import * as THREE from 'three';
import { makeNoise2D, makeFbm, smoothstep, clamp } from './noise.js';
import { WATER_LEVEL } from './terrain.js';

// ---------------------------------------------------------------------------
// Naval battlefield — an open ocean ringed by a soft boundary, dotted with
// volcanic islands. Everything is driven by one analytic height field so the
// physics (grounding), the AI (path probing, line of sight) and the minimap
// all agree with what you see.
//
// The seabed far from any island sits at DEEP (invisible below the opaque
// sea surface); each island is a wobbled radial cone that crosses the
// waterline at ~80% of its radius, so beaches appear where the waves lap.
// ---------------------------------------------------------------------------

const DEEP = -55;
export const NAVAL_PLAY_RADIUS = 4200;
export const NAVAL_HALF = NAVAL_PLAY_RADIUS + 200;

const angShape = makeNoise2D(3311);
const detail = makeFbm(makeNoise2D(4577));
const grain = makeFbm(makeNoise2D(8117));

export const ISLANDS = [
  { x: -1250, z: -1650, r: 430, h: 135 },
  { x: 1680, z: -980, r: 310, h: 92 },
  { x: 980, z: 1520, r: 520, h: 165 },
  { x: -1780, z: 1120, r: 270, h: 78 },
  { x: -360, z: 2480, r: 350, h: 118 },
  { x: -2380, z: -460, r: 240, h: 68 },
  { x: 2600, z: 1380, r: 390, h: 126 },
];

/** Seabed height at a world XZ. DEEP everywhere but on the island shelves. */
export function navalHeightAt(x, z) {
  let h = DEEP;
  for (let i = 0; i < ISLANDS.length; i++) {
    const isl = ISLANDS[i];
    const dx = x - isl.x;
    const dz = z - isl.z;
    const reach = isl.r * 1.95;
    const d2 = dx * dx + dz * dz;
    if (d2 > reach * reach) continue;

    const d = Math.sqrt(d2);
    const ang = Math.atan2(dz, dx);
    // per-bearing wobble of the island outline so it isn't a perfect disc
    const wob = angShape(Math.cos(ang) * 1.7, Math.sin(ang) * 1.7) * 0.42;
    const R = isl.r * (1 + wob);

    if (d <= R) {
      const t = d / R;
      const core = Math.pow(1 - t, 1.5);
      const n = detail(x * 0.004, z * 0.004, 3) * 0.5 + 0.5;
      const hi = -42 + (isl.h + 42) * core * (0.74 + 0.26 * n);
      if (hi > h) h = hi;
    } else {
      // shelf: −42 at the outline fading to DEEP across the remaining reach
      const s = smoothstep(R, reach, d);
      const ho = -42 + (DEEP + 42) * s;
      if (ho > h) h = ho;
    }
  }
  return h;
}

/** True when there is solid ground near the surface at XZ (grounding risk). */
export function navalShallowAt(x, z) {
  return navalHeightAt(x, z) > -14;
}

// ---------------------------------------------------------------------------
// Island meshes — one radial "fan disc" per island, vertex-coloured from
// wet sand at the waterline through grass to sun-bleached rock on the peaks.
// ---------------------------------------------------------------------------
const C_WETSAND = new THREE.Color(0x7c7057);
const C_SAND = new THREE.Color(0xa3946e);
const C_GRASS_A = new THREE.Color(0x4d5c36);
const C_GRASS_B = new THREE.Color(0x5f6c40);
const C_ROCK = new THREE.Color(0x6f6a60);
const C_PEAK = new THREE.Color(0x9a948a);
const C_SEABED = new THREE.Color(0x2c3a38);

export function buildIslands(scene) {
  const group = new THREE.Group();
  const RADIAL = 44;
  const RINGS = 22;

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
    side: THREE.DoubleSide,
    flatShading: false,
  });

  for (const isl of ISLANDS) {
    const reach = isl.r * 1.95;
    const rows = [];
    for (let ri = 0; ri < RINGS; ri++) {
      // denser rings near the waterline, sparser on the peak
      const t = Math.pow(ri / (RINGS - 1), 0.8);
      rows.push(t * reach);
    }
    rows[0] = 0;

    const vcount = 1 + RINGS * RADIAL;
    const pos = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);

    // apex
    pos[0] = isl.x;
    pos[1] = navalHeightAt(isl.x, isl.z);
    pos[2] = isl.z;

    for (let ri = 0; ri < RINGS; ri++) {
      const r = rows[ri];
      for (let a = 0; a < RADIAL; a++) {
        const th = (a / RADIAL) * Math.PI * 2;
        const x = isl.x + Math.cos(th) * r;
        const z = isl.z + Math.sin(th) * r;
        const idx = 1 + ri * RADIAL + a;
        pos[idx * 3] = x;
        pos[idx * 3 + 1] = navalHeightAt(x, z);
        pos[idx * 3 + 2] = z;
      }
    }

    const indices = [];
    for (let a = 0; a < RADIAL; a++) {
      indices.push(0, 1 + a, 1 + ((a + 1) % RADIAL));
    }
    for (let ri = 0; ri < RINGS - 1; ri++) {
      const base = 1 + ri * RADIAL;
      const next = base + RADIAL;
      for (let a = 0; a < RADIAL; a++) {
        const an = (a + 1) % RADIAL;
        indices.push(base + a, next + a, base + an);
        indices.push(base + an, next + a, next + an);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // colour from height + slope now that normals exist
    const nor = geo.getAttribute('normal');
    const c = new THREE.Color();
    for (let i = 0; i < vcount; i++) {
      const y = pos[i * 3 + 1];
      const slope = 1 - nor.getY(i);
      const nz = grain(pos[i * 3] * 0.02, pos[i * 3 + 2] * 0.02, 2) * 0.5 + 0.5;

      if (y < WATER_LEVEL + 1.6) {
        c.copy(C_WETSAND);
      } else if (y < WATER_LEVEL + 7) {
        c.copy(C_SAND);
      } else {
        c.copy(C_GRASS_A).lerp(C_GRASS_B, nz);
        c.lerp(C_ROCK, clamp((slope - 0.30) * 3.2, 0, 1) * 0.85);
        c.lerp(C_PEAK, clamp((y - isl.h * 0.55) / (isl.h * 0.5), 0, 1) * 0.8);
      }
      if (y < WATER_LEVEL - 4) c.lerp(C_SEABED, 0.55);

      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
  }

  scene.add(group);
  return group;
}

/** Paint the naval battlefield onto the minimap base canvas (180x180). */
export function paintNavalMinimap(ctx, S) {
  ctx.fillStyle = '#16303e';
  ctx.fillRect(0, 0, S, S);

  const toMap = (x, z) => [
    ((x + NAVAL_HALF) / (NAVAL_HALF * 2)) * S,
    ((z + NAVAL_HALF) / (NAVAL_HALF * 2)) * S,
  ];

  for (let j = 0; j < S; j += 2) {
    for (let i = 0; i < S; i += 2) {
      const x = (i / S - 0.5) * NAVAL_HALF * 2;
      const z = (j / S - 0.5) * NAVAL_HALF * 2;
      const h = navalHeightAt(x, z);
      if (h < WATER_LEVEL) continue;
      const t = clamp((h - WATER_LEVEL) / 90, 0, 1);
      const g = 110 - t * 40;
      ctx.fillStyle = `rgb(${130 - t * 60},${g},${76 - t * 24})`;
      ctx.fillRect(i, j, 2, 2);
    }
  }
}
