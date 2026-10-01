import * as THREE from 'three';
import { SURFACE_GLSL } from './shaders.js';

// The procedural clay (pores, grain, scratches, wear) is far too heavy to evaluate per pixel every
// frame, so it is rendered once into an atlas: one tile per brick face (±X, ±Y, ±Z), RGB = albedo,
// A = relief height. Materials then sample it tri-planarly.

const PX_PER_UNIT = 340;
const PAD = 8;

/** GLSL for sampling the atlas: needs uniforms uClayAtlas, uClayTiles[6], uSize. */
export const CLAY_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uClayAtlas;
uniform vec4 uClayTiles[6];
vec2 clayFaceUV(vec3 p, int axis) {
  if (axis == 0) return vec2(p.z / uSize.z + .5, p.y / uSize.y + .5);
  if (axis == 1) return vec2(p.x / uSize.x + .5, p.z / uSize.z + .5);
  return vec2(p.x / uSize.x + .5, p.y / uSize.y + .5);
}
vec4 clayTile(vec3 p, int axis, float sgn) {
  vec4 tile = uClayTiles[axis * 2 + (sgn < 0. ? 1 : 0)];
  return texture2D(uClayAtlas, tile.xy + clamp(clayFaceUV(p, axis), 0., 1.) * tile.zw);
}
vec4 clayTriplanar(vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(6.));
  w /= (w.x + w.y + w.z);
  return clayTile(p, 0, n.x) * w.x + clayTile(p, 1, n.y) * w.y + clayTile(p, 2, n.z) * w.z;
}
`;

export function bakeClay(renderer, size) {
  const px = (v) => Math.round(v * PX_PER_UNIT);
  // tile sizes per axis: X faces show (z, y), Y faces (x, z), Z faces (x, y)
  const dims = [[px(size.z), px(size.y)], [px(size.x), px(size.z)], [px(size.x), px(size.y)]];
  // layout: row 0 = +Z -Z +X -X, row 1 = +Y -Y
  const order = [[2, 1], [2, -1], [0, 1], [0, -1], [1, 1], [1, -1]];
  const rects = {};
  let x = 0, y = 0, rowH = 0, width = 0;
  order.forEach(([axis, sgn], i) => {
    if (i === 4) { y += rowH; x = 0; rowH = 0; }
    const [w, h] = dims[axis];
    rects[axis * 2 + (sgn < 0 ? 1 : 0)] = { axis, sgn, x: x + PAD, y: y + PAD, w, h };
    x += w + PAD * 2;
    rowH = Math.max(rowH, h + PAD * 2);
    width = Math.max(width, x);
  });
  const height = y + rowH;

  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uAxis: { value: 0 },
      uSign: { value: 1 },
      uPad: { value: new THREE.Vector4() },
      uHalf: { value: size.clone().multiplyScalar(0.5) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
    fragmentShader: /* glsl */ `
      uniform int uAxis;
      uniform float uSign;
      uniform vec4 uPad;   // maps the padded quad uv to face uv (may go slightly past 0..1)
      uniform vec3 uHalf;
      varying vec2 vUv;
      ${SURFACE_GLSL}
      void main() {
        vec2 f = (vUv * uPad.xy - uPad.zw) - .5;
        vec3 p, n;
        if (uAxis == 0) { p = vec3(uSign * uHalf.x, f.y * 2. * uHalf.y, f.x * 2. * uHalf.z); n = vec3(uSign, 0., 0.); }
        else if (uAxis == 1) { p = vec3(f.x * 2. * uHalf.x, uSign * uHalf.y, f.y * 2. * uHalf.z); n = vec3(0., uSign, 0.); }
        else { p = vec3(f.x * 2. * uHalf.x, f.y * 2. * uHalf.y, uSign * uHalf.z); n = vec3(0., 0., uSign); }
        gl_FragColor = clayAlbedoHeight(p, n, uHalf);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();

  const tiles = [];
  for (let k = 0; k < 6; k++) {
    const r = rects[k];
    const pw = r.w + PAD * 2, ph = r.h + PAD * 2;
    material.uniforms.uAxis.value = r.axis;
    material.uniforms.uSign.value = r.sgn;
    material.uniforms.uPad.value.set(pw / r.w, ph / r.h, PAD / r.w, PAD / r.h);
    target.viewport.set(r.x - PAD, r.y - PAD, pw, ph);
    renderer.setRenderTarget(target);
    renderer.render(quad, cam);
    tiles.push(new THREE.Vector4(r.x / width, r.y / height, r.w / width, r.h / height));
  }

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  quad.geometry.dispose();
  material.dispose();

  return { texture: target.texture, tiles, target };
}
