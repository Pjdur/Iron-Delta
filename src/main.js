import * as THREE from 'three';
import {
  Terrain, heightAt, normalAt, WATER_LEVEL, PLAY_RADIUS, WORLD_SIZE, HALF, CHUNK, GRID,
} from './terrain.js';
import { Vegetation, Grass, windUniforms } from './vegetation.js';
import { TrackSystem } from './tracks.js';
import { Effects } from './effects.js';
import { Tank } from './tank.js';
import { Soldiers } from './soldiers.js';
import { EnemyManager } from './enemies.js';
import { clamp, wrapAngle } from './noise.js';

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const FOG_COLOR = 0xa2adb3;
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00052);
renderer.setClearColor(FOG_COLOR, 1);

const camera = new THREE.PerspectiveCamera(
  58, window.innerWidth / window.innerHeight, 0.7, 14000
);

// ---------------------------------------------------------------------------
// Sun & sky
// ---------------------------------------------------------------------------
const SUN_DIR = new THREE.Vector3(0.42, 0.56, 0.34).normalize();

const hemi = new THREE.HemisphereLight(0xbcd3e6, 0x4a4230, 0.62);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff1d6, 2.25);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 900;
sun.shadow.camera.left = -120;
sun.shadow.camera.right = 120;
sun.shadow.camera.top = 120;
sun.shadow.camera.bottom = -120;
sun.shadow.bias = -0.0007;
sun.shadow.normalBias = 0.5;
scene.add(sun);
scene.add(sun.target);

renderer.shadowMap.autoUpdate = false;

const skyMat = new THREE.ShaderMaterial({
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
      vec3 zenith  = vec3(0.22, 0.40, 0.66);
      vec3 horizon = vec3(0.635, 0.678, 0.702);
      vec3 col = mix(horizon, zenith, pow(h, 0.85));

      float sd = max(dot(d, normalize(uSunDir)), 0.0);
      col += vec3(1.0, 0.86, 0.62) * pow(sd, 220.0) * 2.2;
      col += vec3(1.0, 0.82, 0.58) * pow(sd, 9.0) * 0.20;

      // band of haze just above the horizon
      col = mix(vec3(0.72, 0.74, 0.74), col, smoothstep(-0.02, 0.16, d.y));
      // ground haze underneath
      col = mix(vec3(0.42, 0.42, 0.40), col, smoothstep(-0.30, -0.02, d.y));

      // faint procedural clouds
      float c = sin(d.x * 5.0 + d.z * 3.0) * sin(d.z * 7.0 - d.x * 2.0);
      col += vec3(0.05) * smoothstep(0.25, 0.95, c) * smoothstep(0.02, 0.35, d.y);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 32, 20), skyMat);
sky.frustumCulled = false;
sky.renderOrder = -10;
scene.add(sky);

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(WORLD_SIZE * 1.2, WORLD_SIZE * 1.2, 1, 1),
  new THREE.MeshStandardMaterial({
    color: 0x25353c, 
    roughness: 0.12, 
    metalness: 0.65,
    transparent: true, 
    opacity: 0.9, 
    depthWrite: false,
    side: THREE.DoubleSide,
  })
);
water.rotation.x = -Math.PI / 2;
water.position.y = WATER_LEVEL;
water.receiveShadow = false;
scene.add(water);

// ---------------------------------------------------------------------------
// World objects & Scoring
// ---------------------------------------------------------------------------
let terrain, vegetation, grass, tracks, footprints, effects, tank, soldiers;
let enemies = [];
let enemyMgr = null;
let score = 0;
let mapBase = null;

const input = { throttle: 0, steer: 0, brake: false, boost: false };
const cam = { yawOffset: 0, followYaw: 0, pitch: 0.2, dist: 20 };

// ---------------------------------------------------------------------------
// Adaptive quality
// ---------------------------------------------------------------------------
const QUALITY = [
  { name: 'low', grass: 8000, veg: 0.5, shadow: 1024, shadowEvery: 3, pixelRatio: 0.7, fineRadius: 480 },
  { name: 'medium', grass: 18000, veg: 0.78, shadow: 1024, shadowEvery: 2, pixelRatio: 1.0, fineRadius: 600 },
  { name: 'high', grass: 36000, veg: 1.0, shadow: 2048, shadowEvery: 1, pixelRatio: 1.25, fineRadius: 700 },
];
let qualityIdx = 1;
let shadowEvery = 2;

function applyQuality(idx) {
  qualityIdx = clamp(idx, 0, QUALITY.length - 1);
  const q = QUALITY[qualityIdx];

  if (grass) grass.setCount(q.grass);
  if (vegetation) vegetation.setCountScale(q.veg);
  if (terrain) terrain.fineRadius = q.fineRadius;

  shadowEvery = q.shadowEvery;

  if (sun.shadow.mapSize.x !== q.shadow) {
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }

  const pr = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
  renderer.setPixelRatio(pr);
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// Scoring & Hit Feedback
// ---------------------------------------------------------------------------
function addScore(pts, moduleName, isCrit) {
  score += pts;
  const scoreValEl = document.getElementById('scoreVal');
  if (scoreValEl) scoreValEl.textContent = score;

  const msg = isCrit 
    ? `CRITICAL HIT: ${moduleName.toUpperCase()} +${pts}` 
    : `HIT: ${moduleName.toUpperCase()} +${pts}`;
  flashMessage(msg);
}

function spawnEnemies() {
  enemyMgr = new EnemyManager(scene, effects, tank, 6);

  enemyMgr.onHit = (res, killed) => {
    addScore(killed ? res.points + 400 : res.points, res.module, killed || res.critical);
  };
  enemyMgr.onKill = () => {
    flashMessage('ENEMY ARMOR DESTROYED');
  };

  enemies = enemyMgr.tanks;
}

// Player shell -> enemy tank sweep, used by the effects shell tracker.
function hitTestEnemy(a, b) {
  if (!enemyMgr) return null;
  return enemyMgr.hitTest(a, b);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const barEl = document.getElementById('bar');
const loadTxtEl = document.getElementById('loadTxt');
const loadingEl = document.getElementById('loading');
const startEl = document.getElementById('start');
const hudEl = document.getElementById('hud');

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
function progress(p, label) {
  barEl.style.width = `${Math.round(p * 100)}%`;
  if (label) loadTxtEl.textContent = label;
}

async function boot() {
  progress(0.02, 'Carving terrain');

  terrain = new Terrain(scene);
  await nextFrame();

  const totalFine = GRID * GRID;
  let guard = 0;
  while (terrain.remaining > 0 && guard < 500) {
    guard++;
    terrain.stepBuild(2);
    const done = totalFine - terrain.remaining;
    progress(0.05 + (done / totalFine) * 0.5, 'Sculpting valleys & ridges');
    await nextFrame();
  }

  progress(0.58, 'Planting forests');
  await nextFrame();
  vegetation = new Vegetation(scene);

  progress(0.72, 'Seeding grass');
  await nextFrame();
  grass = new Grass(scene);

  progress(0.80, 'Mustering infantry & armor');
  await nextFrame();
  effects = new Effects(scene);
  tracks = new TrackSystem(scene, { maxQuads: 6000, dark: 0.9 });
  footprints = new TrackSystem(scene, { maxQuads: 4000, dark: 0.5, footprint: true });
  tank = new Tank(scene, effects);
  soldiers = new Soldiers(scene, 70);
  spawnEnemies();

  effects.onImpact = (p, radius) => {
    const k = soldiers.killNear(p, radius * 1.3);
    if (k > 0) flashMessage(`${k} INFANTRY DOWN`);
  };

  progress(0.90, 'Surveying the sector');
  await nextFrame();
  grass.rebuild(tank.pos);
  buildMinimap();
  applyQuality(qualityIdx);

  progress(1.0, 'Ready');
  await nextFrame();

  loadingEl.classList.add('hidden');
  if (!deployed) startEl.classList.remove('hidden');

  updateCamera(1, true);

  renderer.setAnimationLoop(loop);
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------
function buildMinimap() {
  const S = 180;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);

  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = (i / (S - 1) - 0.5) * WORLD_SIZE;
      const z = (j / (S - 1) - 0.5) * WORLD_SIZE;
      const h = heightAt(x, z);
      normalAt(x, z, _mn);
      const slope = 1 - _mn.y;

      let r, g, b;
      if (h < WATER_LEVEL) {
        r = 30; g = 52; b = 68;
      } else if (h > 420 + slope * 120) {
        r = 205; g = 215; b = 225;
      } else if (slope > 0.42) {
        r = 96; g = 94; b = 90;
      } else if (h < WATER_LEVEL + 12) {
        r = 118; g = 106; b = 78;
      } else {
        const t = clamp((h + 60) / 400, 0, 1);
        r = 62 + t * 40;
        g = 82 + t * 24;
        b = 42 + t * 26;
      }
      const shade = 0.72 + 0.5 * Math.max(0, _mn.y);
      const o = (j * S + i) * 4;
      img.data[o] = clamp(r * shade, 0, 255);
      img.data[o + 1] = clamp(g * shade, 0, 255);
      img.data[o + 2] = clamp(b * shade, 0, 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  mapBase = cv;
}
const _mn = new THREE.Vector3();

const mapCanvas = document.getElementById('mapCanvas');
const mapCtx = mapCanvas.getContext('2d');
let mapVisible = false;

function drawMinimap() {
  if (!mapBase || !mapVisible) return;
  const S = 180;
  mapCtx.drawImage(mapBase, 0, 0);

  const toMap = (x, z) => [
    ((x + HALF) / WORLD_SIZE) * S,
    ((z + HALF) / WORLD_SIZE) * S,
  ];

  const [cx, cz] = toMap(0, 0);
  mapCtx.strokeStyle = 'rgba(255,181,69,0.30)';
  mapCtx.lineWidth = 1;
  mapCtx.beginPath();
  mapCtx.arc(cx, cz, (PLAY_RADIUS / WORLD_SIZE) * S, 0, Math.PI * 2);
  mapCtx.stroke();

  // Enemy tanks on minimap
  for (const e of enemies) {
    if (e.dead) continue;
    const [ex, ez] = toMap(e.pos.x, e.pos.z);
    mapCtx.fillStyle = 'rgba(255,80,80,0.9)';
    mapCtx.fillRect(ex - 2, ez - 2, 4, 4);
  }

  const [px, pz] = toMap(tank.pos.x, tank.pos.z);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(tank.quat);
  const a = Math.atan2(fwd.x, -fwd.z);
  mapCtx.save();
  mapCtx.translate(px, pz);
  mapCtx.rotate(a);
  mapCtx.fillStyle = '#ffb545';
  mapCtx.beginPath();
  mapCtx.moveTo(0, -6);
  mapCtx.lineTo(4.5, 5);
  mapCtx.lineTo(0, 2.5);
  mapCtx.lineTo(-4.5, 5);
  mapCtx.closePath();
  mapCtx.fill();
  mapCtx.restore();
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
const _camTarget = new THREE.Vector3();
const _camDesired = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

function updateCamera(dt, instant = false) {
  _camFwd.set(0, 0, -1).applyQuaternion(tank.quat);
  const hullYaw = Math.atan2(-_camFwd.x, -_camFwd.z);

  if (instant) {
    cam.followYaw = hullYaw;
  } else {
    const delta = wrapAngle(hullYaw - cam.followYaw);
    cam.followYaw = wrapAngle(cam.followYaw + delta * (1 - Math.exp(-dt * 5.5)));
  }

  const yaw = cam.followYaw;
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);

  _camTarget.set(tank.pos.x, tank.pos.y + 2.0, tank.pos.z);

  _camDesired.set(
    Math.sin(yaw) * cp,
    sp,
    Math.cos(yaw) * cp
  ).multiplyScalar(cam.dist).add(_camTarget);

  const minY = heightAt(_camDesired.x, _camDesired.z) + 2.6;
  if (_camDesired.y < minY) _camDesired.y = minY;

  if (instant) camera.position.copy(_camDesired);
  else camera.position.lerp(_camDesired, 1 - Math.exp(-dt * 14));

  camera.lookAt(_camTarget);
}

// ---------------------------------------------------------------------------
// Ground raycast
// ---------------------------------------------------------------------------
const _rayDir = new THREE.Vector3();
const _rayP = new THREE.Vector3();

function aimRay(out) {
  camera.getWorldDirection(_rayDir);
  const origin = camera.position;
  let t = 6;
  let step = 5;
  const maxT = 2200;

  while (t < maxT) {
    _rayP.copy(origin).addScaledVector(_rayDir, t);
    const h = heightAt(_rayP.x, _rayP.z);
    if (_rayP.y <= h) {
      let lo = t - step;
      let hi = t;
      for (let i = 0; i < 14; i++) {
        const m = (lo + hi) * 0.5;
        _rayP.copy(origin).addScaledVector(_rayDir, m);
        if (_rayP.y <= heightAt(_rayP.x, _rayP.z)) hi = m;
        else lo = m;
      }
      out.copy(origin).addScaledVector(_rayDir, hi);
      return out.distanceTo(origin);
    }
    t += step;
    step = Math.min(step * 1.13, 45);
  }
  out.copy(origin).addScaledVector(_rayDir, maxT);
  return maxT;
}

// ---------------------------------------------------------------------------
// Free-cursor aiming (no pointer lock). The view still follows the hull, but
// the gun points wherever the cursor is — much easier to aim with.
// ---------------------------------------------------------------------------
const pointer = { x: 0, y: 0 };
const _aimDir = new THREE.Vector3();
const _aimP = new THREE.Vector3();

function pointerAim(out) {
  camera.updateMatrixWorld();
  _aimDir.set(pointer.x, pointer.y, 0.5).unproject(camera).sub(camera.position).normalize();

  const origin = camera.position;
  const maxT = 2200;
  let t = 8;
  let step = 6;
  while (t < maxT) {
    _aimP.copy(origin).addScaledVector(_aimDir, t);
    if (_aimP.y <= heightAt(_aimP.x, _aimP.z)) {
      let lo = t - step;
      let hi = t;
      for (let i = 0; i < 12; i++) {
        const m = (lo + hi) * 0.5;
        _aimP.copy(origin).addScaledVector(_aimDir, m);
        if (_aimP.y <= heightAt(_aimP.x, _aimP.z)) hi = m;
        else lo = m;
      }
      out.copy(origin).addScaledVector(_aimDir, hi);
      // Never aim at a point behind/inside the turret — that makes the gun
      // spin around. Push short hits out to a sane engagement distance.
      if (out.distanceTo(camera.position) < 48) {
        out.copy(origin).addScaledVector(_aimDir, 48);
      }
      return out.distanceTo(tank.pos);
    }
    t += step;
    step = Math.min(step * 1.14, 50);
  }
  out.copy(origin).addScaledVector(_aimDir, maxT);
  return maxT;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set();
let running = false;
let deployed = false;
let msgTimer = 0;
let playerDead = false;
let deadTimer = 0;

function flashMessage(text) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.classList.add('on');
  msgTimer = 2.0;
}

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyR' && running) {
    tank.rightSelf();
    flashMessage('Hull righted');
  }
  if (e.code === 'KeyM') {
    mapVisible = !mapVisible;
    document.getElementById('mapPanel').classList.toggle('hidden', !mapVisible);
  }
  if (e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => { if (document.hidden) keys.clear(); });

canvas.addEventListener('mousedown', (e) => {
  if (!running) return;
  if (e.button === 0) tryFire();
});
document.getElementById('deploy').addEventListener('click', () => {
  deployed = true;
  startEl.classList.add('hidden');
  hudEl.classList.add('on');
  running = true;
});

window.addEventListener('mousemove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('wheel', (e) => {
  if (!running) return;
  cam.dist = clamp(cam.dist + Math.sign(e.deltaY) * 2.4, 9, 70);
}, { passive: true });

function readInput() {
  const fwd = keys.has('KeyW') || keys.has('ArrowUp');
  const back = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');

  input.throttle = fwd ? 1 : back ? -0.55 : 0;
  input.steer = left ? 1 : right ? -1 : 0;
  input.brake = keys.has('Space');
  input.boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
}

function tryFire() {
  if (!tank.canFire()) {
    document.getElementById('crosshair').classList.add('reloading');
    return;
  }
  tank.fire();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const el = {
  speed: document.getElementById('speedVal'),
  gear: document.getElementById('gear'),
  ammo: document.getElementById('ammoVal'),
  ammoTot: document.getElementById('ammoTot'),
  reload: document.getElementById('reloadFill'),
  health: document.getElementById('healthFill'),
  range: document.getElementById('range'),
  crosshair: document.getElementById('crosshair'),
  compass: document.getElementById('compassStrip'),
  grid: document.getElementById('gridRef'),
};

function buildCompass() {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  let html = '';
  for (let c = 0; c < 3; c++) {
    for (const n of names) {
      const card = n.length === 1 ? ' card' : '';
      html += `<span class="${card.trim()}">${n}</span>`;
    }
  }
  el.compass.innerHTML = html;
}

let hudAcc = 0;
function updateHud(dt, aimDist) {
  hudAcc += dt;
  if (hudAcc < 0.06) return;
  hudAcc = 0;

  el.speed.textContent = Math.round(tank.speedKmh);
  const s = tank.speed;
  el.gear.textContent = s > 0.4 ? 'D' : s < -0.4 ? 'R' : 'N';
  el.ammo.textContent = tank.ammo;
  el.ammoTot.textContent = `/ ${tank.maxAmmo}`;
  el.reload.style.width = `${(1 - tank.reload / tank.reloadTime) * 100}%`;
  el.health.style.width = `${tank.health}%`;
  el.range.textContent = `${Math.round(aimDist)} m`;

  el.crosshair.classList.toggle('reloading', tank.reload > 0);

  if (msgTimer > 0) {
    msgTimer -= 0.06;
    if (msgTimer <= 0) document.getElementById('msg').classList.remove('on');
  }

  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(tank.quat);
  let heading = (-Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI;
  heading = ((heading % 360) + 360) % 360;
  const perDeg = 272 / 360;
  el.compass.style.transform = `translateX(${170 - 272 - heading * perDeg}px)`;

  const gx = Math.round((tank.pos.x + HALF) / 100);
  const gz = Math.round((HALF - tank.pos.z) / 100);
  el.grid.textContent = `${String.fromCharCode(65 + gx)}${gz}`;
}

// Keep the reticle glued to the real cursor.
function positionCrosshair() {
  const px = (pointer.x * 0.5 + 0.5) * window.innerWidth;
  const py = (-pointer.y * 0.5 + 0.5) * window.innerHeight;
  el.crosshair.style.left = `${px}px`;
  el.crosshair.style.top = `${py}px`;
  el.range.style.left = `${px}px`;
  el.range.style.top = `${py + 52}px`;
  el.crosshair.classList.toggle('onTarget', targetLocked);
  if (targetLocked) el.range.textContent = `TARGET ${Math.round(aimDist)} m`;
}

function onPlayerDeath() {
  playerDead = true;
  deadTimer = 0;
  effects.explosion(tank.pos.clone().add(new THREE.Vector3(0, 1.4, 0)), 1.7);
  flashMessage('VEHICLE DESTROYED — CREW BAILED OUT');
  msgTimer = 9999;
  hudEl.classList.add('wrecked');
}

// Screen-space pick: which live enemy hull is under the reticle? The pick box is
// a little larger than the tank, which makes hitting them forgiving.
const _pickV = new THREE.Vector3();

function pickEnemyUnderCursor(groundDist) {
  if (!enemyMgr) return null;
  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  const aspect = camera.aspect || 1;
  let best = null;
  let bestScore = 1;

  for (const e of enemyMgr.tanks) {
    if (e.dead) continue;
    _pickV.copy(e.pos);
    _pickV.y += 1.1;
    const d = _pickV.distanceTo(camera.position);
    // out of range, or hidden behind the terrain the cursor is resting on
    if (d > 900 || d > groundDist + 90) continue;
    _pickV.project(camera);
    if (_pickV.z > 1) continue;

    const halfH = Math.max(0.001, d * tanHalf);
    const rx = 2.6 / (halfH * aspect);
    const ry = 2.1 / halfH;
    const nx = (_pickV.x - pointer.x) / rx;
    const ny = (_pickV.y - pointer.y) / ry;
    const score = nx * nx + ny * ny;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const aimPoint = new THREE.Vector3();
let aimDist = 0;
let targetLocked = false;
let elapsed = 0;
let frameCount = 0;
let fpsAccum = 0;
let fpsFrames = 0;

function monitorFps(dt) {
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum < 1.6) return;
  const fps = fpsFrames / fpsAccum;
  fpsAccum = 0;
  fpsFrames = 0;
  if (fps < 27 && qualityIdx > 0) applyQuality(qualityIdx - 1);
  else if (fps > 52 && qualityIdx < QUALITY.length - 1) applyQuality(qualityIdx + 1);
}

function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  frameCount++;

  windUniforms.uTime.value = elapsed;

  if (running) {
    readInput();
    tank.step(dt, input, tracks);
    tank.updateReload(dt);
    if (!tank.alive && !playerDead) onPlayerDeath();
  } else {
    tank.aimAt(tank.pos.clone().add(new THREE.Vector3(0, 0, -300)), dt);
  }

  updateCamera(dt);

  // update enemy tanks
  if (enemyMgr) enemyMgr.update(dt);

  aimDist = pointerAim(aimPoint);

  // Reticle lock-on: is the cursor covering an enemy hull? If so the gun snaps
  // onto it and the reticle turns green.
  targetLocked = false;
  if (enemyMgr && running) {
    const groundDist = aimPoint.distanceTo(camera.position);
    const target = pickEnemyUnderCursor(groundDist);
    if (target) {
      targetLocked = true;
      aimPoint.copy(target.pos);
      aimPoint.y += 1.15;
      aimDist = aimPoint.distanceTo(tank.pos);
    }
  }

  tank.aimAt(aimPoint, dt);

  soldiers.update(dt, tank.pos, camera, effects, elapsed);

  grass.update(tank.pos);
  terrain.update(camera.position);
  effects.update(dt, camera);

  sky.position.copy(camera.position);
  sun.position.copy(tank.pos).addScaledVector(SUN_DIR, 320);
  sun.target.position.copy(tank.pos);
  sun.target.updateMatrixWorld();

  renderer.shadowMap.needsUpdate = frameCount % shadowEvery === 0;

  water.position.y = WATER_LEVEL + Math.sin(elapsed * 0.6) * 0.06;

  effects.applyShake(camera, elapsed);

  if (running) updateHud(dt, aimDist);
  positionCrosshair();
  drawMinimap();

  renderer.render(scene, camera);
  monitorFps(dt);
}

// ---------------------------------------------------------------------------
// Events & Debug Handles
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  applyQuality(qualityIdx);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

document.addEventListener('contextmenu', (e) => e.preventDefault());

buildCompass();
boot();

window.__game = {
  get tank() { return tank; },
  get scene() { return scene; },
  get camera() { return camera; },
  get soldiers() { return soldiers; },
  get enemies() { return enemies; },
  get enemyMgr() { return enemyMgr; },
  hitTest: hitTestEnemy,
  get score() { return score; },
  get grass() { return grass; },
  get terrain() { return terrain; },
  get sun() { return sun; },
  get hemi() { return hemi; },
  addScore,
  cam,
  renderer,
  input,
  clearKeys: () => keys.clear(),
};