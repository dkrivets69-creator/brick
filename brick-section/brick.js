import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { noise3, fbm3, smoothstep } from './noise.js';
import { PERTURB_GLSL } from './shaders.js';
import { bakeClay, CLAY_SAMPLE_GLSL } from './bake.js';

// Brick-local axes: X = width (text face is ±Z), Y = length, Z = thickness (holes run along X).
export const SIZE = new THREE.Vector3(1.55, 2.5, 0.95);
const HALF = SIZE.clone().multiplyScalar(0.5);
export const CORNER_RADIUS = 0.04;
const TEXT_DEPTH = 0.042;
const DISPLACE_FOCUS = 0.2; // displacement directions converge this deep, so insets must stay below it
const MAX_INSET = 0.15;

export const HOLES = [
  { y: 0.55, z: 0.0, r: 0.245 },
  { y: -0.05, z: 0.0, r: 0.245 },
  { y: -0.65, z: 0.0, r: 0.245 },
];

// Chips: flat, slightly concave fractures cut into the edges (like knocked-off clay),
// generated from a fixed seed so the brick always looks the same.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeChips() {
  const rnd = mulberry32(7);
  const H = [SIZE.x / 2, SIZE.y / 2, SIZE.z / 2];
  const chips = [];
  const add = (c, m, r, depth) => {
    const mv = new THREE.Vector3(...m).add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.35)).normalize();
    chips.push({ c: new THREE.Vector3(...c), m: mv, r, depth });
  };
  // 12 edges: two fixed axes, running along the third
  for (let along = 0; along < 3; along++) {
    const [a, b] = [0, 1, 2].filter((k) => k !== along);
    const count = along === 1 ? 3 : 1;
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        if (rnd() < 0.3) continue;
        const c = [0, 0, 0], m = [0, 0, 0];
        c[a] = sa * H[a]; c[b] = sb * H[b];
        c[along] = (rnd() * 2 - 1) * (H[along] - 0.15);
        m[a] = sa; m[b] = sb;
        add(c, m, 0.05 + rnd() * 0.08, 0.025 + rnd() * 0.03);
      }
    }
  }
  return chips;
}
const CHIPS = makeChips();


// ---------- "G-TECH" height map (drawn on a canvas, sampled on CPU and in the shader) ----------

const TEXT_PX_PER_UNIT = 640;

function createTextMap() {
  const w = Math.round(SIZE.x * TEXT_PX_PER_UNIT);
  const h = Math.round(SIZE.y * TEXT_PX_PER_UNIT);
  const sharp = document.createElement('canvas');
  sharp.width = w; sharp.height = h;
  const ctx = sharp.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  const label = 'G-TECH';
  ctx.font = '100px "Russo One", "Arial Black", sans-serif';
  const m = ctx.measureText(label);
  const targetLen = 1.56 * TEXT_PX_PER_UNIT;   // along the brick length
  const targetCap = 0.52 * TEXT_PX_PER_UNIT;   // across the width
  const capAt100 = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || 72;
  const fontSize = Math.min(100 * targetLen / m.width, 100 * targetCap / capAt100);

  ctx.save();
  ctx.translate(w * 0.5, h * 0.5 + 0.1 * TEXT_PX_PER_UNIT);
  ctx.rotate(-Math.PI / 2); // reads bottom → top
  ctx.font = `${fontSize}px "Russo One", "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  const mm = ctx.measureText(label);
  ctx.fillText(label, 0, (mm.actualBoundingBoxAscent - mm.actualBoundingBoxDescent) / 2);
  ctx.restore();

  // Soft bevel on the letter walls.
  const soft = document.createElement('canvas');
  soft.width = w; soft.height = h;
  const sctx = soft.getContext('2d');
  sctx.filter = 'blur(1.5px)';
  sctx.drawImage(sharp, 0, 0);

  const data = sctx.getImageData(0, 0, w, h).data;
  const sample = (x, y) => {
    // brick-local x,y on the +Z face → [0,1]
    const u = (x / SIZE.x + 0.5) * (w - 1);
    const v = (0.5 - y / SIZE.y) * (h - 1);
    if (u < 0 || v < 0 || u > w - 1 || v > h - 1) return 0;
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = u - x0, fy = v - y0;
    const at = (xx, yy) => data[(yy * w + xx) * 4] / 255;
    return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
  };

  const texture = new THREE.CanvasTexture(soft);
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 8;
  return { texture, sample };
}

// ---------- displacement shared by brick + stickers ----------

let textSample = () => 0;

/** Offset along normal `n` for a point `p` on the (rounded, undisplaced) brick surface. */
export function surfaceOffset(p, n, withText = true) {
  let d = (fbm3(p.x * 3.2, p.y * 3.2, p.z * 3.2, 3) - 0.5) * 0.014
        + (noise3(p.x * 19 + 3, p.y * 19, p.z * 19) - 0.5) * 0.004;

  // slightly softened, irregular edges: distance to the nearest edge = second-smallest face distance
  const ex = HALF.x - Math.abs(p.x), ey = HALF.y - Math.abs(p.y), ez = HALF.z - Math.abs(p.z);
  let a = ex, b = ey, c = ez, t;
  if (a > b) { t = a; a = b; b = t; }
  if (b > c) { t = b; b = c; c = t; }
  if (a > b) { t = a; a = b; b = t; }
  const edge = 1 - smoothstep(0, 0.14, b);
  if (edge > 0) {
    const wv = fbm3(p.x * 7 + 11, p.y * 7, p.z * 7, 3);
    d -= edge * edge * Math.pow(Math.max(0, wv - 0.3) / 0.7, 1.2) * 0.055;
  }

  for (const ch of CHIPS) {
    const dx = p.x - ch.c.x, dy = p.y - ch.c.y, dz = p.z - ch.c.z;
    const h = dx * ch.m.x + dy * ch.m.y + dz * ch.m.z;          // height above the chip centre
    const lat2 = dx * dx + dy * dy + dz * dz - h * h;
    const rr = ch.r * (0.8 + 0.4 * noise3(p.x * 7 + ch.r * 50, p.y * 7, p.z * 7));
    if (lat2 > rr * rr) continue;
    // fracture surface: plane at -depth, a little concave towards the middle
    const cut = h + ch.depth + ch.depth * 0.35 * (1 - lat2 / (rr * rr));
    if (cut <= 0) continue;
    const cosA = Math.max(0.6, n.x * ch.m.x + n.y * ch.m.y + n.z * ch.m.z);
    const rim = 1 - smoothstep(0.88, 1, Math.sqrt(lat2) / rr);
    d = Math.min(d, -(cut / cosA) * rim);
  }

  if (withText && n.z > 0.9) d -= textSample(p.x, p.y) * TEXT_DEPTH;
  return d;
}

function buildBodyGeometry() {
  // a bit denser across the lettered face (x, y); crisp letter walls come from the text normal in the shader
  let g = new THREE.BoxGeometry(
    SIZE.x, SIZE.y, SIZE.z,
    Math.round(SIZE.x / 0.0095), Math.round(SIZE.y / 0.0105), Math.round(SIZE.z / 0.016)
  );
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g, 1e-5);

  const inner = HALF.clone().subScalar(CORNER_RADIUS);
  // Displacement directions fan out from a much smaller inner box: on the tight corner rounding the
  // true normals converge only CORNER_RADIUS deep, so pushing inward along them would fold the
  // surface inside out (and break the CSG inside/outside test for the holes).
  const dirInner = HALF.clone().subScalar(DISPLACE_FOCUS);
  const pos = g.attributes.position;
  const p = new THREE.Vector3(), q = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    q.copy(p).clamp(inner.clone().negate(), inner);
    n.subVectors(p, q).normalize();
    p.copy(q).addScaledVector(n, CORNER_RADIUS);
    m.copy(p).sub(q.copy(p).clamp(dirInner.clone().negate(), dirInner)).normalize();
    p.addScaledVector(m, Math.max(-MAX_INSET, surfaceOffset(p, m, true)));
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

function buildHolesGeometry() {
  const parts = HOLES.map((h) => {
    const c = new THREE.CylinderGeometry(h.r, h.r, SIZE.x + 0.6, 64, 48, false);
    c.rotateZ(Math.PI / 2);
    const pos = c.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const k = 1 + (fbm3(x * 5, y * 5 + h.y * 10, z * 5, 3) - 0.5) * 0.14;
      pos.setXYZ(i, x, y * k + h.y, z * k + h.z);
    }
    c.deleteAttribute('uv');
    c.computeVertexNormals();
    return c;
  });
  return mergeGeometries(parts);
}

// ---------- material ----------

function createClayMaterial(textTexture, clay, { hole = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  if (hole) mat.envMapIntensity = 0.35;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTextMap = { value: textTexture };
    shader.uniforms.uTextTexel = { value: new THREE.Vector2(1 / textTexture.image.width, 1 / textTexture.image.height) };
    shader.uniforms.uClayAtlas = { value: clay.texture };
    shader.uniforms.uClayTiles = { value: clay.tiles };
    shader.uniforms.uSize = { value: SIZE };
    shader.uniforms.uBump = { value: 0.034 };
    shader.uniforms.uHole = { value: hole ? 1 : 0 };
    shader.uniforms.uRimColor = { value: new THREE.Color(1.0, 0.55, 0.32).multiplyScalar(hole ? 0 : 0.75) };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;\nvarying vec3 vAxisX;\nvarying vec3 vAxisY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjNormal = normal;\nvAxisX = normalMatrix * vec3(1., 0., 0.);\nvAxisY = normalMatrix * vec3(0., 1., 0.);');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vObjPos;
        varying vec3 vObjNormal;
        varying vec3 vAxisX;
        varying vec3 vAxisY;
        uniform sampler2D uTextMap;
        uniform vec3 uSize;
        uniform float uBump;
        uniform float uHole;
        uniform vec2 uTextTexel;
        float gH; vec2 gTextGrad;
        uniform vec3 uRimColor;
        ${CLAY_SAMPLE_GLSL}
        ${PERTURB_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 p = vObjPos;
          vec4 clay = clayTriplanar(p, normalize(vObjNormal));
          vec3 col = clay.rgb;
          float t = 0.;
          gTextGrad = vec2(0.);
          if (p.z > uSize.z * 0.5 - 0.14 && uHole < 0.5) {
            vec2 tuv = vec2(p.x / uSize.x + 0.5, p.y / uSize.y + 0.5);
            t = texture2D(uTextMap, tuv).r;
            // letter walls from the text map itself: crisp regardless of mesh density
            gTextGrad = vec2(
              texture2D(uTextMap, tuv + vec2(uTextTexel.x, 0.)).r - texture2D(uTextMap, tuv - vec2(uTextTexel.x, 0.)).r,
              texture2D(uTextMap, tuv + vec2(0., uTextTexel.y)).r - texture2D(uTextMap, tuv - vec2(0., uTextTexel.y)).r);
            col *= mix(1.0, 0.66, t);
          }
          if (uHole > 0.5) {
            float depth = abs(p.x) / (uSize.x * 0.5);
            col *= mix(0.18, 0.95, pow(clamp(depth, 0., 1.), 2.2));
          }
          gH = clay.a;
          diffuseColor.rgb = col;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = 0.9;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = perturbNormalH(-vViewPosition, normal, vec2(dFdx(gH), dFdy(gH)) * uBump, faceDirection);
        {
          // letter walls: text-map gradient on the +Z face (object x/y), tilted into the view-space normal
          normal = normalize(normal + (vAxisX * gTextGrad.x + vAxisY * gTextGrad.y) * 0.9);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // contour light: warm fresnel glow on the silhouette
          float fres = pow(1. - clamp(dot(normal, normalize(vViewPosition)), 0., 1.), 3.);
          totalEmissiveRadiance += uRimColor * fres * diffuseColor.rgb * 2.2;
        }`);
  };
  return mat;
}

// ---------- public ----------

export async function createBrick(renderer) {
  try {
    await Promise.all([
      document.fonts.load('100px "Russo One"'),
      document.fonts.load('800 100px "Baloo 2"'),
    ]);
  } catch (_) { /* fall back to system fonts */ }

  const text = createTextMap();
  textSample = text.sample;

  const clay = bakeClay(renderer, SIZE);
  const brickMat = createClayMaterial(text.texture, clay);
  const holeMat = createClayMaterial(text.texture, clay, { hole: true });

  const body = new Brush(buildBodyGeometry(), brickMat);
  const holes = new Brush(buildHolesGeometry(), holeMat);
  body.updateMatrixWorld();
  holes.updateMatrixWorld();

  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];
  evaluator.useGroups = true;
  const mesh = evaluator.evaluate(body, holes, SUBTRACTION);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Cheap proxy for pointer picking.
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(SIZE.x, SIZE.y, SIZE.z), new THREE.MeshBasicMaterial());
  proxy.visible = false;

  return { mesh, proxy, clay };
}
