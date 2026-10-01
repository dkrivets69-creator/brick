import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { SIZE, CORNER_RADIUS } from './brick.js';
import { noise3 } from './noise.js';
import { PERTURB_GLSL } from './shaders.js';
import { CLAY_SAMPLE_GLSL } from './bake.js';

// Sticker layout. face: front (+Z, "G-TECH" side) | right (+X, holes side) | back | left.
// x/y are face coordinates (x across, y along the brick length), rot in degrees, size = longest side.
export const STICKERS = [
  // krivets and cat hang over the brick edges, like in the reference
  { id: 'krivets', text: 'Krivets', face: 'front', x: -0.24, y: 1.05, rot: 30, size: 0.86 },
  { id: 'heart', svg: 'stickers/heart.svg', face: 'front', x: -0.5, y: -0.02, rot: 14, size: 0.42 },
  { id: 'cat', svg: 'stickers/cat.svg', face: 'front', x: 0.66, y: -0.84, rot: 14, size: 0.54 },
  { id: 'spark-1', svg: 'stickers/sparkle.svg', face: 'front', x: 0.52, y: 0.98, rot: 8, size: 0.24 },
  { id: 'spark-2', svg: 'stickers/sparkle.svg', face: 'front', x: -0.54, y: -0.66, rot: -6, size: 0.22 },
  { id: 'dumpling', svg: 'stickers/dumpling.svg', face: 'right', x: 0.0, y: 1.04, rot: -28, size: 0.4 },
  { id: 'spark-3', svg: 'stickers/sparkle.svg', face: 'right', x: -0.3, y: 0.25, rot: 10, size: 0.2 },
  { id: 'spark-4', svg: 'stickers/sparkle.svg', face: 'right', x: 0.02, y: -1.06, rot: -4, size: 0.18 },
];

// n: outward normal, t: face x axis, off: distance to the face, half: half-extent along t
const FACES = {
  front: { n: [0, 0, 1], t: [1, 0, 0], off: SIZE.z / 2, half: SIZE.x / 2 },
  back: { n: [0, 0, -1], t: [-1, 0, 0], off: SIZE.z / 2, half: SIZE.x / 2 },
  right: { n: [1, 0, 0], t: [0, 0, -1], off: SIZE.x / 2, half: SIZE.z / 2 },
  left: { n: [-1, 0, 0], t: [0, 0, 1], off: SIZE.x / 2, half: SIZE.z / 2 },
};
const GRID = 48;

const ART_PX = 380;
const BORDER_PX = 20;
const MASK_RES = 48;
const GRAVITY = 9;

// Stickers bend over an edge with a wider radius than the brick's own rounding, so they
// stretch across worn/chipped edges like a film instead of following every dent.
const STICKER_BEND = 0.12;

/** Unfolds a face coordinate around a brick edge: position along axis, depth, normal (along axis, along face normal). */
function wrapAxis(val, half) {
  const R = STICKER_BEND;
  const e = half - R;
  const a = Math.abs(val) - e;
  const sg = Math.sign(val) || 1;
  if (a <= 0) return { s: val, ds: 0, na: 0, nn: 1 };
  const arc = (Math.PI * R) / 2;
  if (a < arc) {
    const phi = a / R;
    return { s: sg * (e + R * Math.sin(phi)), ds: -R * (1 - Math.cos(phi)), na: sg * Math.sin(phi), nn: Math.cos(phi) };
  }
  return { s: sg * half, ds: -(R + a - arc), na: sg, nn: 0 };
}

/** Grid filter helpers (the sticker mesh is a (GRID+1)² vertex grid). */
function gridPass(src, side, reduce) {
  const out = new Float32Array(src.length);
  for (let j = 0; j < side; j++)
    for (let i = 0; i < side; i++) {
      const vals = [];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const jj = Math.min(side - 1, Math.max(0, j + dj)), ii = Math.min(side - 1, Math.max(0, i + di));
          vals.push(src[jj * side + ii]);
        }
      out[j * side + i] = reduce(vals);
    }
  return out;
}
const maxOf = (v) => Math.max(...v);
const meanOf = (v) => v.reduce((a, b) => a + b, 0) / v.length;

// ---------- textures ----------

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  return c;
}

async function drawSvg(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const s = ART_PX / Math.max(img.naturalWidth, img.naturalHeight);
  const c = canvas(img.naturalWidth * s, img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function drawText(text) {
  const font = `800 ${ART_PX * 0.36}px "Baloo 2", "Arial Rounded MT Bold", sans-serif`;
  const probe = canvas(1, 1).getContext('2d');
  probe.font = font;
  const m = probe.measureText(text);
  const pad = 6;
  const c = canvas(m.width + pad * 2, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + pad * 2);
  const ctx = c.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = '#6a39c6';
  ctx.fillText(text, pad, pad + m.actualBoundingBoxAscent);
  return c;
}

/** Adds a white die-cut border + a hairline shadow around the artwork. */
function stickerize(art) {
  const pad = BORDER_PX + 6;
  const w = art.width + pad * 2, h = art.height + pad * 2;

  const sil = canvas(w, h);
  const sctx = sil.getContext('2d');
  sctx.drawImage(art, pad, pad);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#fbfaf7';
  sctx.fillRect(0, 0, w, h);

  const outline = canvas(w, h);
  const octx = outline.getContext('2d');
  for (let r = BORDER_PX; r > 0; r -= BORDER_PX / 3) {
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      octx.drawImage(sil, Math.cos(a) * r, Math.sin(a) * r);
    }
  }

  const out = canvas(w, h);
  const ctx = out.getContext('2d');
  ctx.shadowColor = 'rgba(40, 20, 10, 0.35)';
  ctx.shadowBlur = 3;
  ctx.drawImage(outline, 0, 0);
  ctx.shadowColor = 'transparent';
  ctx.drawImage(art, pad, pad);
  return out;
}

/** Soft dark silhouette of the sticker for its contact shadow. */
function shadowCanvas(art) {
  const c = canvas(art.width, art.height);
  const ctx = c.getContext('2d');
  ctx.filter = 'blur(9px)';
  ctx.drawImage(art, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * Contact shadow: the sticker's own mesh, pushed back onto the brick, drawing a blurred,
 * slightly larger and offset silhouette. Shares the peel uniforms, so the shadow fades under
 * the lifted part while peeling and disappears once the sticker is torn off.
 */
function createShadowMaterial(texture, uniforms, size) {
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uShadowMap: { value: texture },
      uStickerSize: { value: size },
      uShadowScale: { value: 0.93 },                            // <1 = shadow a bit larger than the sticker
      uShadowOffset: { value: new THREE.Vector2(0.012, -0.026) }, // down-right, in sticker uv
      uShadowAlpha: { value: 0.55 },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aFlat;
        attribute float aFilm;
        uniform vec2 uAxis, uStickerSize;
        uniform float uSMin, uPeel;
        varying vec2 vSUv;
        varying float vFree;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = position - normal * aFilm;   // down onto the brick, under the sticker
        vSUv = aFlat / uStickerSize + 0.5;
        float tt = uSMin + uPeel - dot(aFlat, uAxis);
        vFree = uPeel > 0.0 ? smoothstep(0.0, 0.05, tt) : 0.0;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uShadowMap;
        uniform float uShadowScale, uShadowAlpha, uDetach;
        uniform vec2 uShadowOffset;
        varying vec2 vSUv;
        varying float vFree;`)
      .replace('#include <alphamap_fragment>', `
        vec2 suv = (vSUv - 0.5) * uShadowScale + 0.5 - uShadowOffset;
        float inside = step(0., suv.x) * step(suv.x, 1.) * step(0., suv.y) * step(suv.y, 1.);
        float a = texture2D(uShadowMap, suv).a * inside * uShadowAlpha * (1. - vFree) * (1. - uDetach);
        diffuseColor = vec4(0.13, 0.04, 0.015, a);`);
  };
  return mat;
}

function alphaMask(c) {
  const small = canvas(MASK_RES, MASK_RES);
  const ctx = small.getContext('2d');
  ctx.drawImage(c, 0, 0, MASK_RES, MASK_RES);
  const d = ctx.getImageData(0, 0, MASK_RES, MASK_RES).data;
  const mask = new Uint8Array(MASK_RES * MASK_RES);
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] > 110 ? 1 : 0;
  return mask;
}

// ---------- material with peel/curl deformation ----------

function createStickerMaterial(texture, clay) {
  const uniforms = {
    uAxis: { value: new THREE.Vector2(1, 0) },
    uSMin: { value: 0 },
    uPeel: { value: 0 },
    uR: { value: 0.05 },
    uThetaMax: { value: 2.2 },
    uDetach: { value: 0 },
    uBend: { value: 0 },
    uRest: { value: new THREE.Matrix4() },
    uBump: { value: 0.012 },
    uClayAtlas: { value: clay.texture },
    uClayTiles: { value: clay.tiles },
    uSize: { value: SIZE },
  };
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    // a little self-light so the white paper stays white on the shaded face
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 0.16,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    roughness: 0.38,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aFlat;
        uniform vec2 uAxis;
        uniform float uSMin, uPeel, uR, uThetaMax, uDetach, uBend;
        uniform mat4 uRest;
        varying vec3 vRest;
        varying vec3 vRestN;
        varying float vLift;
        void peelVertex(vec3 restPos, vec3 restNrm, vec2 p, out vec3 pos, out vec3 nrm, out float lift) {
          vec2 perp = vec2(-uAxis.y, uAxis.x);
          float s = dot(p, uAxis);
          float q = dot(p, perp);
          float base = 0.008;
          float sf = uSMin + uPeel;
          float t = sf - s;
          pos = restPos; nrm = restNrm; lift = 0.;
          if (uPeel > 0.0 && t > 0.0) {
            float th = t / uR;
            float sN, zN, ang;
            if (th < uThetaMax) {
              sN = sf - uR * sin(th); zN = uR * (1. - cos(th)); ang = th;
            } else {
              float e = t - uR * uThetaMax;
              sN = sf - uR * sin(uThetaMax) - cos(uThetaMax) * e;
              zN = uR * (1. - cos(uThetaMax)) + sin(uThetaMax) * e;
              ang = uThetaMax;
            }
            // blend out of the (possibly edge-wrapped) rest shape into the curl
            float k = smoothstep(0.0, 0.06, t);
            pos = mix(restPos, vec3(uAxis * sN + perp * q, zN + base), k);
            nrm = normalize(mix(restNrm, vec3(uAxis * sin(ang), cos(ang)), k));
            lift = clamp(t / 0.04, 0., 1.);
          }
          // free-flying: gentle flutter bend
          float sr = s;
          vec3 fPos = vec3(p, uBend * sr * sr);
          vec3 fNrm = normalize(vec3(-2. * uBend * sr * uAxis, 1.));
          pos = mix(pos, fPos, uDetach);
          nrm = normalize(mix(nrm, fNrm, uDetach));
        }`)
      .replace('#include <beginnormal_vertex>', `
        vec3 pPos; vec3 pNrm; float pLift;
        peelVertex(position, normal, aFlat, pPos, pNrm, pLift);
        vec3 objectNormal = pNrm;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = pPos;
        vRest = (uRest * vec4(position, 1.)).xyz;
        vRestN = normalize(mat3(uRest) * normal);
        vLift = max(pLift, uDetach);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRest;
        varying vec3 vRestN;
        varying float vLift;
        uniform float uBump;
        uniform vec3 uSize;
        ${CLAY_SAMPLE_GLSL}
        ${PERTURB_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.93, 0.92, 0.89);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float sh = clayTriplanar(vRest, normalize(vRestN)).a;
          normal = perturbNormalH(-vViewPosition, normal, vec2(dFdx(sh), dFdy(sh)) * uBump * 0.55 * (1. - vLift), faceDirection);
        }`);
  };
  mat.userData.uniforms = uniforms;
  return mat;
}

// ---------- sticker ----------

class Sticker {
  constructor(cfg, art, bvh, clay) {
    this.cfg = cfg;
    this.bvh = bvh;
    const tex = new THREE.CanvasTexture(art);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const aspect = art.width / art.height;
    this.w = aspect >= 1 ? cfg.size : cfg.size * aspect;
    this.h = aspect >= 1 ? cfg.size / aspect : cfg.size;
    this.mask = alphaMask(art);

    // opaque sample points in local space (for picking the peel edge)
    this.points = [];
    for (let j = 0; j < MASK_RES; j++)
      for (let i = 0; i < MASK_RES; i++)
        if (this.mask[j * MASK_RES + i])
          this.points.push(new THREE.Vector2(((i + 0.5) / MASK_RES - 0.5) * this.w, (0.5 - (j + 0.5) / MASK_RES) * this.h));

    this.geometry = new THREE.PlaneGeometry(this.w, this.h, GRID, GRID);
    const flatPos = this.geometry.attributes.position;
    const flat = new Float32Array(flatPos.count * 2);
    for (let i = 0; i < flatPos.count; i++) { flat[i * 2] = flatPos.getX(i); flat[i * 2 + 1] = flatPos.getY(i); }
    this.geometry.setAttribute('aFlat', new THREE.BufferAttribute(flat, 2));
    this.material = createStickerMaterial(tex, clay);
    this.u = this.material.userData.uniforms;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.userData.sticker = this;
    this.mesh.frustumCulled = false;

    const shadowTex = new THREE.CanvasTexture(shadowCanvas(art));
    this.shadow = new THREE.Mesh(this.geometry, createShadowMaterial(shadowTex, this.u, new THREE.Vector2(this.w, this.h)));
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = -1;
    this.seed = [...cfg.id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) % 1000;

    this.layout();
    this.state = 'attached';
  }

  /** Places the sticker on its brick face, wraps it over rounded edges and bakes the surface relief. */
  layout() {
    const bvh = this.bvh;
    const f = FACES[this.cfg.face];
    const n = new THREE.Vector3(...f.n);
    const t = new THREE.Vector3(...f.t);
    const b = new THREE.Vector3().crossVectors(n, t);
    const rot = THREE.MathUtils.degToRad(this.cfg.rot);
    const basis = new THREE.Matrix4().makeBasis(t, b, n);
    const q = new THREE.Quaternion().setFromRotationMatrix(basis)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rot));
    const origin = n.clone().multiplyScalar(f.off).addScaledVector(t, this.cfg.x).addScaledVector(b, this.cfg.y);

    this.mesh.position.copy(origin);
    this.mesh.quaternion.copy(q);
    this.mesh.scale.setScalar(1);
    this.mesh.updateMatrix();
    this.u.uRest.value.copy(this.mesh.matrix);
    const toLocal = this.mesh.matrix.clone().invert();

    const flat = this.geometry.attributes.aFlat;
    const count = flat.count;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const ray = new THREE.Ray();
    const PROBE = 0.35;
    const P = [], N = [];
    const raw = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = flat.getX(i), y = flat.getY(i);
      const U = wrapAxis(this.cfg.x + x * cos - y * sin, f.half);
      const V = wrapAxis(this.cfg.y + x * sin + y * cos, SIZE.y / 2);
      const nn = n.clone().multiplyScalar(U.nn * V.nn).addScaledVector(t, U.na).addScaledVector(b, V.na).normalize();
      const pS = n.clone().multiplyScalar(f.off + U.ds + V.ds).addScaledVector(t, U.s).addScaledVector(b, V.s);
      P.push(pS); N.push(nn);
      // distance from the sticker's arc to the real brick surface along the normal
      ray.origin.copy(pS).addScaledVector(nn, PROBE);
      ray.direction.copy(nn).negate();
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, PROBE * 2);
      raw[i] = hit ? PROBE - hit.distance : -1;
    }
    // rays that found nothing (sticker hanging past a chip) borrow from their neighbours
    const floor = Math.min(...raw.filter((v) => v > -1));
    for (let i = 0; i < count; i++) if (raw[i] === -1) raw[i] = floor;

    // Rest on the high points (dilate) and stay smooth (blur): bridges pits and chips.
    const side = GRID + 1;
    let h = gridPass(gridPass(raw, side, maxOf), side, maxOf);
    for (let pass = 0; pass < 6; pass++) h = gridPass(h, side, meanOf);

    // Film waves: soft bumps plus a gentle ripple, lifted off the surface only (never into it).
    const film = new Float32Array(count);
    const sd = this.seed;
    const ang = (sd % 180) * (Math.PI / 180);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const pos = this.geometry.attributes.position;
    for (let i = 0; i < count; i++) {
      const x = flat.getX(i), y = flat.getY(i);
      const bumps = noise3(x * 11 + sd, y * 11, sd * 0.37);
      const ripple = 0.5 + 0.5 * Math.sin((x * ca + y * sa) * 46 + sd + 2.2 * noise3(x * 5, y * 5, sd));
      const wave = 0.0042 * bumps * bumps + 0.0022 * ripple * noise3(x * 4 + 9, y * 4, sd);
      film[i] = wave + 0.0045;
      const p = P[i].addScaledVector(N[i], h[i] + 0.0015 + film[i]).applyMatrix4(toLocal);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    this.geometry.setAttribute('aFilm', new THREE.BufferAttribute(film, 1));
    this.shadow.position.copy(this.mesh.position);
    this.shadow.quaternion.copy(this.mesh.quaternion);
    this.shadow.scale.setScalar(1);
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();

    Object.assign(this, { axis: null, peel: 0, peelTarget: 0, theta: 2.2, thetaTarget: 2.2 });
    this.u.uPeel.value = 0;
    this.u.uDetach.value = 0;
    this.u.uBend.value = 0;
  }

  opaqueAtUV(uv) {
    const i = Math.min(MASK_RES - 1, Math.floor(uv.x * MASK_RES));
    const j = Math.min(MASK_RES - 1, Math.floor((1 - uv.y) * MASK_RES));
    return this.mask[j * MASK_RES + i] === 1;
  }

  extent(axis) {
    let lo = Infinity, hi = -Infinity;
    for (const p of this.points) {
      const s = p.dot(axis);
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    return [lo, hi];
  }
}

// ---------- system ----------

export class StickerSystem {
  constructor({ scene, camera, parent, brick, clay }) {
    this.clay = clay;
    this.scene = scene;
    this.camera = camera;
    this.parent = parent;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', brick.geometry.attributes.position);
    if (brick.geometry.index) g.setIndex(brick.geometry.index.clone()); // BVH reorders the index
    this.bvh = new MeshBVH(g);
    this.list = [];
    this.active = null;
    this.time = 0;
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane();
    this._v = new THREE.Vector3();
  }

  async load(configs = STICKERS) {
    const arts = await Promise.all(configs.map(async (c) => stickerize(c.text ? drawText(c.text) : await drawSvg(c.svg))));
    configs.forEach((cfg, i) => {
      const s = new Sticker(cfg, arts[i], this.bvh, this.clay);
      this.parent.add(s.shadow, s.mesh);
      this.list.push(s);
    });
  }

  get removedCount() {
    return this.list.filter((s) => s.state === 'gone' || s.state === 'detached').length;
  }

  /** Returns the sticker under the ray (only stickers on the visible surface). */
  pick(raycaster, proxy) {
    const proxyHit = raycaster.intersectObject(proxy, false)[0];
    const limit = proxyHit ? proxyHit.distance + 0.06 : Infinity;
    const meshes = this.list.filter((s) => s.state === 'attached' || s.state === 'returning').map((s) => s.mesh);
    for (const hit of raycaster.intersectObjects(meshes, false)) {
      if (hit.distance > limit) break;
      const s = hit.object.userData.sticker;
      if (hit.uv && s.opaqueAtUV(hit.uv)) return { sticker: s, uv: hit.uv };
    }
    return null;
  }

  beginPeel({ sticker, uv }) {
    this.active = sticker;
    sticker.state = 'peeling';
    sticker.grab = new THREE.Vector2((uv.x - 0.5) * sticker.w, (uv.y - 0.5) * sticker.h);
    sticker.axis = null;
    sticker.pointerVel = new THREE.Vector3();
    sticker.lastPointer = null;
  }

  _pointerOnStickerPlane(ndc, sticker) {
    this._ray.setFromCamera(ndc, this.camera);
    const m = sticker.mesh.matrixWorld;
    const normal = new THREE.Vector3().setFromMatrixColumn(m, 2).normalize();
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    if (Math.abs(this._ray.ray.direction.dot(normal)) < 0.12) return null;
    this._plane.setFromNormalAndCoplanarPoint(normal, origin);
    const hit = this._ray.ray.intersectPlane(this._plane, new THREE.Vector3());
    return hit ? sticker.mesh.worldToLocal(hit) : null;
  }

  drag(ndc) {
    const s = this.active;
    if (!s) return;
    if (s.state === 'peeling') {
      const local = this._pointerOnStickerPlane(ndc, s);
      if (!local) return;
      const world = s.mesh.localToWorld(local.clone());
      const now = performance.now();
      if (s.lastPointer) {
        const dt = Math.max(0.008, (now - s.lastTime) / 1000);
        s.pointerVel.lerp(world.clone().sub(s.lastPointer).divideScalar(dt), 0.4);
      }
      s.lastPointer = world;
      s.lastTime = now;
      const D = new THREE.Vector2(local.x - s.grab.x, local.y - s.grab.y);
      const len = D.length();
      if (!s.axis && len > 0.015) {
        const g = new THREE.Vector2(s.grab.x, s.grab.y);
        const nearEdge = g.length() > 0.22 * Math.max(s.w, s.h);
        s.axis = nearEdge ? g.clone().negate().normalize() : D.clone().normalize();
        [s.sMin, s.sMax] = s.extent(s.axis);
        s.u.uAxis.value.copy(s.axis);
        s.u.uSMin.value = s.sMin;
      }
      if (s.axis) {
        const along = D.clone().normalize().dot(s.axis);
        s.thetaTarget = Math.acos(THREE.MathUtils.clamp(-along * 0.85, -1, 1));
        s.peelTarget = len * 0.9;
        if (s.peelTarget > 0.62 * (s.sMax - s.sMin)) this._detach(s);
      }
    }
  }

  /** Fully peeled: the sticker lets go of the cursor and falls by itself. */
  _detach(s) {
    this.active = null;
    dispatchEvent(new Event('brick:peeled'));
    s.state = 'detached';
    s.detachT = 0;
    s.phase = Math.random() * 10;
    this.scene.attach(s.mesh);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(s.mesh.quaternion);
    s.velocity = s.pointerVel.clone().clampLength(0, 5).multiplyScalar(0.6)
      .addScaledVector(normal, 1.4)
      .add(new THREE.Vector3(0, 1.3, 0));
    const side = Math.sign(s.velocity.x) || (Math.random() < 0.5 ? -1 : 1);
    s.spin = new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, -side * (2 + Math.random() * 4));
  }

  release() {
    const s = this.active;
    this.active = null;
    if (s && s.state === 'peeling') {
      s.state = 'returning';
      s.peelTarget = 0;
    }
  }

  get busy() {
    return !!this.active;
  }

  update(dt) {
    this.time += dt;
    const k = 1 - Math.exp(-dt * 16);
    for (const s of this.list) {
      if (s.state === 'peeling' || s.state === 'returning') {
        s.peel += (s.peelTarget - s.peel) * k;
        s.theta += (s.thetaTarget - s.theta) * k;
        s.u.uPeel.value = s.peel;
        s.u.uThetaMax.value = s.theta;
        s.u.uR.value = 0.025 + s.peel * 0.14;
        if (s.state === 'returning' && s.peel < 0.002) {
          s.state = 'attached';
          s.peel = 0;
          s.u.uPeel.value = 0;
        }
      } else if (s.state === 'detached') {
        this._fly(s, dt);
      } else if (s.state === 'appearing') {
        s.appearT += dt;
        const t = Math.min(1, s.appearT / 0.55);
        const e = 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2); // back-out
        s.mesh.scale.setScalar(Math.max(0.001, e));
        s.shadow.scale.copy(s.mesh.scale);
        if (t >= 1) { s.state = 'attached'; s.mesh.scale.setScalar(1); s.shadow.scale.setScalar(1); }
      }
    }
  }

  _fly(s, dt) {
    const m = s.mesh;
    s.detachT += dt;
    s.u.uDetach.value = Math.min(1, s.detachT / 0.3);
    s.u.uBend.value = Math.sin(this.time * 7 + s.phase) * 0.28 * s.u.uDetach.value;

    s.velocity.y -= GRAVITY * dt;
    s.velocity.multiplyScalar(Math.exp(-0.35 * dt));
    m.position.addScaledVector(s.velocity, dt);
    const w = s.spin.length();
    if (w > 0) m.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(s.spin.clone().normalize(), w * dt));

    const ndc = m.getWorldPosition(this._v).project(this.camera);
    if (ndc.y < -1.35 || Math.abs(ndc.x) > 1.4) {
      s.state = 'gone';
      m.removeFromParent();
    }
  }

  /** Puts every removed sticker back with a little pop. */
  restore() {
    for (const s of this.list) {
      if (s.state !== 'gone' && s.state !== 'detached') continue;
      if (s === this.active) this.active = null;
      s.mesh.removeFromParent();
      this.parent.add(s.mesh);
      s.layout();
      s.mesh.scale.setScalar(0.001);
      s.shadow.scale.setScalar(0.001);
      s.appearT = 0;
      s.state = 'appearing';
    }
  }
}
