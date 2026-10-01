// GLSL shared by the brick and the stickers: procedural porous clay surface + bump helper.

export const PERTURB_GLSL = /* glsl */ `
vec3 perturbNormalH(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

export const SURFACE_GLSL = /* glsl */ `
float bh13(vec3 p3) {
  p3 = fract(p3 * .1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 bh33(vec3 p3) {
  p3 = fract(p3 * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float bnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * (3. - 2. * f);
  return mix(
    mix(mix(bh13(i), bh13(i + vec3(1,0,0)), u.x), mix(bh13(i + vec3(0,1,0)), bh13(i + vec3(1,1,0)), u.x), u.y),
    mix(mix(bh13(i + vec3(0,0,1)), bh13(i + vec3(1,0,1)), u.x), mix(bh13(i + vec3(0,1,1)), bh13(i + vec3(1,1,1)), u.x), u.y),
    u.z);
}
float bfbm(vec3 p) {
  float s = 0., a = .5;
  for (int i = 0; i < 4; i++) { s += a * bnoise(p); p = p * 2.03 + 17.1; a *= .5; }
  return s / .9375;
}
// x: F1, y: F2, z: id of nearest cell
vec3 bworley(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 8., d2 = 8., id = 0.;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 g = vec3(x, y, z);
    vec3 r = g + bh33(i + g) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = bh13(i + g + 7.7); }
    else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}

// Porous clay: x height, y pit mask, z groove/cell mask, w speckle
vec4 brickSurface(vec3 p) {
  vec3 w = bworley(p * 30.);
  float cell = smoothstep(0.0, 0.3, w.y - w.x) * (1. - smoothstep(0.1, 0.75, w.x) * 0.6);
  float clump = bfbm(p * 48. + 1.7);
  float pit = smoothstep(0.34, 0.1, w.x) * step(0.45, w.z);
  vec3 w2 = bworley(p * 9. + 5.3);
  float bigPit = smoothstep(0.22, 0.04, w2.x) * step(0.8, w2.z);
  float grain = bnoise(p * 150.);
  float lf = bfbm(p * 4.);
  float h = cell * 0.45 + (clump - .5) * 1.3 - pit * 1.5 - bigPit * 1.8 + grain * 0.25 + (lf - .5) * 1.0;
  float speck = smoothstep(0.78, 0.95, bnoise(p * 70. + 3.1));
  return vec4(h, max(pit, bigPit), cell, speck);
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return length(pa - ba * h);
}

// Straight, tapered scratches scattered on a 2D plane (one or two per cell).
float scratches2D(vec2 uv, float seed, float cellSize, float angle) {
  vec2 id = floor(uv / cellSize);
  float aa = fwidth(uv.x) + fwidth(uv.y);
  float acc = 0.;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++)
  for (int k = 0; k < 2; k++) {
    vec2 c = id + vec2(i, j);
    vec3 r = bh33(vec3(c, seed + float(k) * 13.1));
    vec3 r2 = bh33(vec3(c + 7.3, seed + float(k) * 5.7 + 2.9));
    if (r2.z < 0.45) continue;
    vec2 ctr = (c + r.xy) * cellSize;
    float ang = angle + (r.z - 0.5) * 0.7 + (r2.x > 0.8 ? 1.5 : 0.);
    vec2 dir = vec2(cos(ang), sin(ang));
    float len = mix(0.05, 0.32, r2.y * r2.y);
    vec2 a = ctr - dir * len * 0.5, b = ctr + dir * len * 0.5;
    float w = mix(0.0012, 0.0035, r2.x) + aa * 0.6;
    float along = clamp(dot(uv - a, dir) / len, 0., 1.);
    float line = smoothstep(w, 0., segDist(uv, a, b)) * sin(along * 3.14159);
    acc = max(acc, line * mix(0.45, 1., r.z));
  }
  return acc;
}

// x: scratches, y: wear/abrasion (stronger on edges), z: dust
vec3 brickWear(vec3 p, vec3 n, vec3 halfSize) {
  vec3 an = abs(n);
  vec2 uv = an.z > max(an.x, an.y) ? p.xy : (an.x > an.y ? p.zy : p.xz);
  float sc = max(scratches2D(uv, 3.1, 0.2, 0.9), scratches2D(uv * 1.3 + 5., 11.7, 0.14, -0.5) * 0.7);
  vec3 ad = halfSize - abs(p);
  float lo = min(ad.x, min(ad.y, ad.z)), hi = max(ad.x, max(ad.y, ad.z));
  float edgeDist = ad.x + ad.y + ad.z - lo - hi;
  float edge = 1. - smoothstep(0.0, 0.1, edgeDist);
  float scuff = smoothstep(0.5, 0.78, bfbm(p * 3.2 + 21.));
  float wear = clamp(edge * (0.35 + 0.65 * bfbm(p * 9. + 4.)) + scuff * 0.45, 0., 1.);
  float dust = smoothstep(0.55, 0.85, bfbm(p * 1.7 + 40.));
  return vec3(sc, wear, dust);
}

// Full clay look (albedo + relief) at a point on the brick surface. Expensive: only used to bake the atlas.
vec4 clayAlbedoHeight(vec3 p, vec3 n, vec3 halfSize) {
  vec4 s = brickSurface(p);
  float tone = bfbm(p * 2.2 + 3.7);
  vec3 col = mix(vec3(0.36, 0.075, 0.028), vec3(0.58, 0.15, 0.05), tone);
  col = mix(col, vec3(0.26, 0.07, 0.03), smoothstep(0.55, 0.8, bfbm(p * 1.3 + 9.1)) * 0.5);
  col *= mix(0.8, 1.04, s.z);
  col *= mix(1.0, 0.28, s.y);
  col = mix(col, vec3(0.72, 0.36, 0.2), s.w * 0.3);
  vec3 wr = brickWear(p, n, halfSize);
  col = mix(col, vec3(0.62, 0.3, 0.17), wr.y * 0.4);   // abraded, paler clay
  col = mix(col, vec3(0.6, 0.47, 0.4), wr.z * 0.16);   // mortar dust
  col = mix(col, vec3(0.8, 0.47, 0.3), wr.x * 0.35);   // fresh scratches
  float h = s.x * (1. - wr.y * 0.3) - wr.x * 0.6;
  return vec4(col, h);
}
`;
