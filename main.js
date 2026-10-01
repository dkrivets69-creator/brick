import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createBrick } from './brick.js';
import { StickerSystem } from './stickers.js';
import { setupHints } from './hints.js';

// Reference pose: G-TECH face towards the viewer, holes side visible on the right,
// top leaning right and slightly towards the camera.
const POSE = new THREE.Euler(0.26, 0, -0.4, 'XYZ');
const START_ANGLE = -0.6;
const params = new URLSearchParams(location.search);
const STILL = params.has('still');
const ZOOM = Number(params.get('zoom')) || 1;
const BASE_SPEED = STILL ? 0 : matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.08 : 0.3; // rad/s
const params0 = new URLSearchParams(location.search);
// world units that must fit vertically; embedded in a card the brick gets more air around it
const EMBED = params0.has('embed') || document.body.classList.contains('embed');
const FIT_HEIGHT = EMBED ? 3.7 : 3.55;

const stage = document.getElementById('stage');
const resetBtn = document.getElementById('reset');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
// Pixel ratio: capped, and lowered automatically if frames get slow (see the loop).
const MAX_DPR = Math.min(devicePixelRatio, 1.75);
let dpr = MAX_DPR;
renderer.setPixelRatio(dpr);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.16;

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
const CAMERA_ELEVATION = THREE.MathUtils.degToRad(-14); // looking slightly up at the brick

// Side key (lights the holes side + top), back rims for the contour, weak raking front fill:
// the face turned to the viewer stays darker, like in the reference.
const key = new THREE.DirectionalLight(0xfff0e2, 5.2);
key.position.set(5, -0.4, 1.6);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = key.shadow.camera.bottom = -2.2;
key.shadow.camera.right = key.shadow.camera.top = 2.2;
key.shadow.camera.near = 1;
key.shadow.camera.far = 15;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);

const rimLeft = new THREE.DirectionalLight(0xffe6d6, 3.2);
rimLeft.position.set(-4.5, 2.2, -3.5);
scene.add(rimLeft);
const rimTop = new THREE.DirectionalLight(0xfff4ec, 1.6);
rimTop.position.set(0.5, 5, -2.5);
scene.add(rimTop);
const fill = new THREE.DirectionalLight(0xffe2d0, 0.3);
fill.position.set(-3, 3.5, 4);
scene.add(fill);

// root (bob + drag tilt) → pose (reference angle) → spin (around the brick's long axis)
const root = new THREE.Group();
const pose = new THREE.Group();
const spin = new THREE.Group();
pose.rotation.copy(POSE);
spin.rotation.y = START_ANGLE;
root.add(pose);
pose.add(spin);
scene.add(root);

const { mesh: brick, proxy, clay } = await createBrick(renderer);
spin.add(brick, proxy);

const stickers = new StickerSystem({ scene, camera, parent: spin, brick, clay });
await stickers.load();

// ---------- sizing ----------

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const byHeight = FIT_HEIGHT / (2 * Math.tan(fov / 2));
  const byWidth = (FIT_HEIGHT * 0.78) / (2 * Math.tan(fov / 2) * camera.aspect);
  const dist = Math.max(byHeight, byWidth) / ZOOM;
  const cx = Number(params.get('cx')) || 0, cy = Number(params.get('cy')) || 0;
  camera.position.set(cx, cy + Math.sin(CAMERA_ELEVATION) * dist, Math.cos(CAMERA_ELEVATION) * dist);
  camera.lookAt(cx, cy, 0);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

// ---------- interaction ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let mode = null;          // 'spin' | 'peel' | null
let angle = START_ANGLE;
let omega = BASE_SPEED;   // current angular velocity
let direction = 1;        // remembered spin direction
let tilt = 0, tiltVel = 0;
let lastX = 0, lastY = 0, lastT = 0, dragVel = 0, dragDist = 0;
const canvas = renderer.domElement;

function setNdc(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
}

function hitBrick() {
  return raycaster.intersectObject(proxy, false).length > 0;
}

canvas.addEventListener('pointerdown', (e) => {
  setNdc(e);
  const hit = stickers.pick(raycaster, proxy);
  if (hit) {
    mode = 'peel';
    stickers.beginPeel(hit);
  } else if (hitBrick() || e.pointerType === 'mouse') {
    mode = 'spin';
    dragVel = 0;
    dragDist = 0;
  } else return;
  lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
  setNdc(e);
  if (mode === 'peel') {
    stickers.drag(ndc);
  } else if (mode === 'spin') {
    const now = performance.now();
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    const dt = Math.max(1, now - lastT) / 1000;
    dragDist += Math.abs(dx);
    const dAngle = dx * 0.009;
    angle += dAngle;
    dragVel = THREE.MathUtils.lerp(dragVel, dAngle / dt, 0.5);
    tilt = THREE.MathUtils.clamp(tilt + dy * 0.003, -0.45, 0.45);
    lastX = e.clientX; lastY = e.clientY; lastT = now;
  } else if (e.pointerType === 'mouse') {
    canvas.style.cursor = stickers.pick(raycaster, proxy) || hitBrick() ? 'grab' : '';
  }
});

function endDrag(e) {
  if (!mode) return;
  if (mode === 'spin') {
    if (performance.now() - lastT > 80) dragVel *= 0.2; // held still before release
    omega = THREE.MathUtils.clamp(dragVel, -14, 14);
    if (Math.abs(omega) > 0.05) direction = Math.sign(omega);
    if (dragDist > 40) dispatchEvent(new Event('brick:spun'));
  } else {
    stickers.release();
  }
  mode = null;
  canvas.style.cursor = '';
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Block page scroll on touch only when the gesture starts on the brick.
canvas.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  setNdc(t);
  if (hitBrick()) e.preventDefault();
}, { passive: false });

resetBtn.addEventListener('click', () => stickers.restore());

// ---------- loop ----------

const clock = new THREE.Clock();
let elapsed = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  elapsed += dt;

  if (mode !== 'spin') {
    // peeling holds the brick still; otherwise ease back to cruising speed in the last direction
    const target = stickers.busy ? 0 : direction * BASE_SPEED;
    const rate = stickers.busy ? 8 : 1.1;
    omega += (target - omega) * (1 - Math.exp(-dt * rate));
    angle += omega * dt;
    tiltVel += (-tilt * 40 - tiltVel * 7) * dt;
    tilt += tiltVel * dt;
  }
  spin.rotation.y = angle;
  root.rotation.x = tilt;
  root.position.y = Math.sin(elapsed * 1.1) * 0.04;
  root.rotation.z = Math.sin(elapsed * 0.7) * 0.015;

  stickers.update(dt);
  resetBtn.classList.toggle('show', stickers.removedCount > 0);

  renderer.render(scene, camera);
  adaptResolution(dt);
}

// Adaptive resolution: if the average frame is slower than ~45 fps, render fewer pixels.
let slowTime = 0, fastTime = 0;
function adaptResolution(dt) {
  if (dt > 1 / 45) { slowTime += dt; fastTime = 0; } else { fastTime += dt; slowTime = 0; }
  if (slowTime > 1 && dpr > 1) {
    dpr = Math.max(1, dpr - 0.25);
    renderer.setPixelRatio(dpr);
    slowTime = 0;
  } else if (fastTime > 4 && dpr < MAX_DPR) {
    dpr = Math.min(MAX_DPR, dpr + 0.25);
    renderer.setPixelRatio(dpr);
    fastTime = 0;
  }
}

// Only animate while the brick is on screen and the tab is visible.
let onScreen = true;
function updateLoop() {
  const run = onScreen && !document.hidden;
  renderer.setAnimationLoop(run ? frame : null);
  if (run) clock.getDelta(); // don't jump after a pause
}
new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; updateLoop(); }).observe(stage);
document.addEventListener('visibilitychange', updateLoop);
updateLoop();



if (params.has('debug')) window.__brick = { stickers, camera, proxy, raycaster, ndc, setNdc };
stage.classList.add('ready');
setupHints();
