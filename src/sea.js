import * as THREE from 'three';
import { WATER_LEVEL } from './terrain.js';

// ---------------------------------------------------------------------------
// Sea — a layered Gerstner-wave ocean tuned for a realistic, "vivid" look:
//   • seven summed Gerstner waves (long ground swell + mid swells + small chop)
//   • modest amplitudes so it reads like a calm sea
//   • analytic surface normals for clean sun glint
//   • fresnel sky reflection mixed with deep / shallow / surface water tints
//   • foam only on the steeper crests
//   • subsurface scattering tint on crests (the "translucent crest" look)
//   • per-pixel ripple detail (value noise) for extra sparkle
//   • a public surfaceHeight() so the rest of the game can ask
//     "how high is the sea at (x,z) right now?" — used for buoyancy
//     and the underwater view.
//
// The mesh follows the camera (snapped to a grid) so waves stay
// world-aligned while the visible area is always covered.
// ---------------------------------------------------------------------------

// dirX, dirZ, amplitude (m), wavelength (m), angularSpeed (rad/s), steepness
const WAVES = [
  // long ground swell
  { dx:  1.00, dz:  0.45, amp: 0.55, len: 80, speed: 0.85, steep: 0.55 },
  // mid swells
  { dx: -0.65, dz:  1.00, amp: 0.40, len: 55, speed: 1.10, steep: 0.55 },
  { dx:  0.85, dz: -0.75, amp: 0.30, len: 38, speed: 1.30, steep: 0.50 },
  // small chop on top
  { dx: -0.50, dz: -0.95, amp: 0.20, len: 26, speed: 1.60, steep: 0.45 },
  { dx:  0.30, dz:  0.95, amp: 0.15, len: 20, speed: 1.90, steep: 0.40 },
  { dx: -0.85, dz:  0.40, amp: 0.12, len: 16, speed: 2.20, steep: 0.40 },
  // tiny ripples
  { dx:  0.45, dz:  0.90, amp: 0.07, len: 11, speed: 2.60, steep: 0.35 },
];

const N = WAVES.length;

// Pre-compute normalized directions and wavenumbers so the CPU side
// (surfaceHeight) and the GPU side (buildWaveSum) stay perfectly in sync.
const WAVE_PREP = WAVES.map((w) => {
  const dl = Math.hypot(w.dx, w.dz);
  return {
    ndx: w.dx / dl,
    ndz: w.dz / dl,
    k: (Math.PI * 2) / w.len,
    amp: w.amp,
    speed: w.speed,
    steep: w.steep,
  };
});

// Unroll the wave summation — keeps the shader simple and fast on the GPU.
function buildWaveSum() {
  let code = '';
  for (let i = 0; i < N; i++) {
    const w = WAVE_PREP[i];
    code += `
      {
        vec2 d${i} = vec2(${w.ndx.toFixed(6)}, ${w.ndz.toFixed(6)});
        float k${i} = ${w.k.toFixed(6)};
        float a${i} = ${w.amp.toFixed(4)};
        float q${i} = ${w.steep.toFixed(3)};
        float phase${i} = k${i} * dot(d${i}, worldXZ) - ${w.speed.toFixed(4)} * uTime;
        float c${i} = cos(phase${i});
        float s${i} = sin(phase${i});
        float WA${i} = k${i} * a${i};
        disp.x += q${i} * d${i}.x * a${i} * c${i};
        disp.z += q${i} * d${i}.y * a${i} * c${i};
        disp.y += a${i} * s${i};
        nrm.x -= d${i}.x * WA${i} * c${i};
        nrm.z -= d${i}.y * WA${i} * c${i};
        nrm.y -= q${i} * WA${i} * s${i};
        foamSteep += q${i} * WA${i} * s${i};
        crestH = max(crestH, a${i} * s${i});
      }
    `;
  }
  return code;
}

const vertexShader = `
  uniform float uTime;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vFoam;
  varying float vCrest;
  varying vec3 vViewDir;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vec2 worldXZ = worldPos.xz;

    vec3 disp = vec3(0.0);
    vec3 nrm = vec3(0.0, 1.0, 0.0);
    float foamSteep = 0.0;
    float crestH = 0.0;

    ${buildWaveSum()}

    worldPos.xyz += disp;

    vWorldPos = worldPos.xyz;
    vNormal = normalize(nrm);
    vFoam = clamp(foamSteep * 0.7, 0.0, 1.0);
    vCrest = crestH;
    vViewDir = cameraPosition - worldPos.xyz;

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = `
  precision highp float;

  uniform float uTime;
  uniform vec3  uSunDir;
  uniform vec3  uAbyssColor;     // deepest layer
  uniform vec3  uDeepColor;      // mid layer
  uniform vec3  uShallowColor;   // surface / facing the camera
  uniform vec3  uSkyColor;
  uniform vec3  uFoamColor;
  uniform float uFoamAmount;
  uniform vec3  uFogColor;
  uniform float uFogDensity;

  varying vec3  vWorldPos;
  varying vec3  vNormal;
  varying float vFoam;
  varying float vCrest;
  varying vec3  vViewDir;

  // ---- tiny hash + value noise for ripple detail ----
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm2(vec2 p) {
    return valueNoise(p) * 0.55 + valueNoise(p * 2.07) * 0.30 + valueNoise(p * 4.13) * 0.15;
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);

    // ---- are we looking at the surface from underneath? (camera below the
    //      sea) — flip the normal; the underside is lit further down ----
    bool fromBelow = dot(N, V) < 0.0;
    if (fromBelow) N = -N;

    // ---- per-pixel ripple perturbation: adds vivid high-frequency chop
    //      without needing more geometry tessellation ----
    float t = uTime * 0.50;
    float nx = valueNoise(vWorldPos.xz * 0.55 + vec2(t, t * 0.7)) - 0.5;
    float nz = valueNoise(vWorldPos.xz * 0.55 - vec2(t * 0.8, t)) - 0.5;
    // slightly stronger horizontal perturbation so ripples "shimmer"
    N = normalize(N + vec3(nx * 0.22, 0.0, nz * 0.22));

    // ---- fresnel: more reflective at grazing angles ----
    float NdotV = max(dot(N, V), 0.0);
    float fresnel = pow(1.0 - NdotV, 5.0);
    fresnel = mix(0.02, 1.0, fresnel);

    // ---- layered water body colour: abyss -> deep -> shallow, blended by
    //      crest height (troughs darker, crests lighter) and by view angle
    //      (steep angles see "deeper" into the water) ----
    float depthFactor = clamp(vCrest * 0.45 + 0.5, 0.0, 1.0);
    vec3 deepMix = mix(uAbyssColor, uDeepColor, depthFactor);
    float facing = pow(1.0 - NdotV, 2.0);
    vec3 waterColor = mix(deepMix, uShallowColor, facing * 0.55);

    // ---- sun specular: sharp glint plus a softer wider glow ----
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);
    float NdotH = max(dot(N, H), 0.0);
    float specSharp = pow(NdotH, 320.0) * 3.5;
    float specWide  = pow(NdotH, 28.0)  * 0.45;
    vec3 sunSpec = vec3(1.0, 0.95, 0.85) * (specSharp + specWide);

    // ---- subsurface scattering: greenish glow when light passes through a
    //      crest (the World of Warships "translucent crest" look) ----
    float sss = smoothstep(0.30, 0.85, vCrest) * (1.0 - fresnel);
    vec3 sssColor = vec3(0.12, 0.42, 0.40) * sss * 0.45;

    // ---- sky reflection ----
    vec3 reflectColor = uSkyColor;

    // ---- combine ----
    vec3 col = mix(waterColor, reflectColor, fresnel);
    col += sunSpec;
    col += sssColor;

    if (fromBelow) {
      // ---- underside: seen from below, the surface is a bright backlit
      //      membrane — light filters through the wave crests and the whole
      //      ceiling shimmers like caustics ----
      float caustic = fbm2(vWorldPos.xz * 1.15 + vec2(uTime * 0.30, uTime * 0.24));
      caustic = smoothstep(0.22, 0.88, caustic);
      vec3 underCol = mix(uDeepColor * 1.6 + vec3(0.02, 0.11, 0.11),
                          vec3(0.58, 0.84, 0.86), caustic * 0.65);
      // extra glow where you look toward the sun through the surface
      float sunThrough = pow(max(dot(-V, normalize(uSunDir)), 0.0), 6.0);
      underCol += vec3(1.0, 0.93, 0.78) * sunThrough * 0.55;
      col = underCol;
    } else {
      // ---- foam: only on steeper crests (calm seas don't foam everywhere) ----
      float foam = smoothstep(0.55, 0.92, vFoam) * uFoamAmount;
      foam += smoothstep(0.55, 0.95, vCrest) * uFoamAmount * 0.40;
      // break the foam up with noise so it doesn't look painted on
      float foamNoise = fbm2(vWorldPos.xz * 0.6 + uTime * 0.18);
      foam *= smoothstep(0.30, 0.78, foamNoise);
      foam = clamp(foam, 0.0, 1.0);
      col = mix(col, uFoamColor, foam);
    }

    // ---- distance fog: fade into the horizon haze ----
    float dist = length(cameraPosition - vWorldPos);
    float fogFactor = 1.0 - exp(-dist * uFogDensity);
    fogFactor = clamp(fogFactor, 0.0, 0.85);
    col = mix(col, uFogColor, fogFactor);

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---------------------------------------------------------------------------
export class Sea {
  constructor(scene, sunDir) {
    this.scene = scene;
    this.sunDir = sunDir.clone();

    // Big enough to cover the fogged visible area, dense enough to
    // resolve the smaller waves cleanly.
    this.size = 2400;
    this.segments = 288;

    const geo = new THREE.PlaneGeometry(
      this.size, this.size, this.segments, this.segments
    );
    geo.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uSunDir:       { value: this.sunDir },
        // Three depth layers — abyss (deep below), deep (mid water column),
        // shallow (lit surface layer you see looking down at the sea).
        uAbyssColor:   { value: new THREE.Color(0x03131c) },
        uDeepColor:    { value: new THREE.Color(0x0c3245) },
        uShallowColor: { value: new THREE.Color(0x1e6e7a) },
        uSkyColor:     { value: new THREE.Color(0x9aaab3) },
        uFoamColor:    { value: new THREE.Color(0xf2f6f8) },
        uFoamAmount:   { value: 0.55 },
        uFogColor:     { value: new THREE.Color(0xa2adb3) },
        // Denser than the scene fog so the sea fades to the horizon haze
        // before the edge of the following-plane is visible.
        uFogDensity:   { value: 0.0018 },
      },
      vertexShader,
      fragmentShader,
      transparent: false,
      // DoubleSide so the surface is also visible from underneath — the
      // "fromBelow" branch in the fragment shader lights the underside.
      side: THREE.DoubleSide,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.position.y = WATER_LEVEL;
    scene.add(this.mesh);

    // Snap to a grid so the wave pattern stays world-aligned as the
    // camera moves. Smaller than the segment size = no swimming.
    this._snapStep = 4.0;
    // last time the shader uniforms were advanced — surfaceHeight uses
    // the same value so the CPU side and the GPU side agree.
    this._currentTime = 0;
  }

  /**
   * Sample the sea-surface height (in metres, world space) at a given XZ.
   * This is the same Gerstner sum that runs on the GPU, evaluated on the
   * CPU. Used for water resistance and the underwater overlay.
   */
  surfaceHeight(x, z, time = this._currentTime) {
    let h = 0;
    for (let i = 0; i < N; i++) {
      const w = WAVE_PREP[i];
      const phase = w.k * (w.ndx * x + w.ndz * z) - w.speed * time;
      h += w.amp * Math.sin(phase);
    }
    return WATER_LEVEL + h;
  }

  update(dt, camera, time) {
    this._currentTime = time;
    this.material.uniforms.uTime.value = time;
    const s = this._snapStep;
    this.mesh.position.x = Math.round(camera.position.x / s) * s;
    this.mesh.position.z = Math.round(camera.position.z / s) * s;
  }
}
