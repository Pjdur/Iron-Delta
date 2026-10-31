import * as THREE from 'three';
import { heightAt } from './terrain.js';

// ---------------------------------------------------------------------------
// Decal texture: soft-edged tread pattern. U = across the track, V = along.
// ---------------------------------------------------------------------------
function makeTrackTexture(dark) {
  const W = 64, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // base imprint
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0.0, 'rgba(48,34,22,0)');
  g.addColorStop(0.18, `rgba(48,34,22,${dark})`);
  g.addColorStop(0.5, `rgba(56,40,26,${Math.min(1, dark * 1.1)})`);
  g.addColorStop(0.82, `rgba(48,34,22,${dark})`);
  g.addColorStop(1.0, 'rgba(48,34,22,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // tread lugs
  ctx.fillStyle = 'rgba(26,18,10,0.55)';
  for (let y = 0; y < H; y += 16) {
    ctx.fillRect(W * 0.22, y + 3, W * 0.56, 7);
  }
  // gritty noise
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const a = Math.random() * 0.30;
    ctx.fillStyle = `rgba(${10 + Math.random() * 30},${8 + Math.random() * 20},${4 + Math.random() * 14},${a})`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// TrackSystem — a ring buffer of ground-conforming quads.
// ---------------------------------------------------------------------------
export class TrackSystem {
  constructor(scene, { maxQuads = 5000, dark = 0.85, footprint = false } = {}) {
    this.max = maxQuads;
    this.cursor = 0;

    const nVerts = this.max * 6;
    this.positions = new Float32Array(nVerts * 3);
    this.uvs = new Float32Array(nVerts * 2);
    this.colors = new Float32Array(nVerts * 3);
    // park unused geometry far below the world
    for (let i = 0; i < nVerts; i++) {
      this.positions[i * 3] = 0;
      this.positions[i * 3 + 1] = -9999;
      this.positions[i * 3 + 2] = 0;
      this.colors[i * 3] = 1;
      this.colors[i * 3 + 1] = 1;
      this.colors[i * 3 + 2] = 1;
    }

    const indices = new Uint32Array(this.max * 6);
    for (let q = 0; q < this.max; q++) {
      const v = q * 6;
      indices[q * 6 + 0] = v + 0;
      indices[q * 6 + 1] = v + 1;
      indices[q * 6 + 2] = v + 2;
      indices[q * 6 + 3] = v + 2;
      indices[q * 6 + 4] = v + 1;
      indices[q * 6 + 5] = v + 3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const mat = new THREE.MeshLambertMaterial({
      map: makeTrackTexture(dark),
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    this.footprint = footprint;
  }

  /** Add one quad. Points are world-space and already ground-projected. */
  addQuad(aL, aR, bL, bR) {
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const base = q * 6;

    const P = this.positions;
    const U = this.uvs;

    const setV = (o, p, u, v) => {
      P[(base + o) * 3 + 0] = p.x;
      P[(base + o) * 3 + 1] = p.y;
      P[(base + o) * 3 + 2] = p.z;
      U[(base + o) * 2 + 0] = u;
      U[(base + o) * 2 + 1] = v;
    };

    setV(0, aL, 0, 0);
    setV(1, aR, 1, 0);
    setV(2, bL, 0, 1);
    setV(3, bR, 1, 1);
    // two degenerate verts keep the index layout stable
    setV(4, bL, 0, 1);
    setV(5, bR, 1, 1);

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
  }

  /** Convenience: emits a strip segment between two world centres. */
  static edges(center, right, width) {
    const hw = width * 0.5;
    const l = new THREE.Vector3(
      center.x - right.x * hw, 0, center.z - right.z * hw
    );
    const r = new THREE.Vector3(
      center.x + right.x * hw, 0, center.z + right.z * hw
    );
    l.y = heightAt(l.x, l.z) + 0.08;
    r.y = heightAt(r.x, r.z) + 0.08;
    return { l, r };
  }
}
