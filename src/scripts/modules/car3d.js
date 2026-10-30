import * as THREE from 'three';
import { $, isMobile, reduceMotion } from '../utils/dom.js';
import { loadCar, makeEnvironment } from './car-model.js';

const MODEL_URL = '/models/car.glb';
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Escena de la portada: carro negro sobre una plataforma, luces rojas y agua en el aire. */
export function initCar3D() {
  const stage = $('#stage'), canvas = $('#car3d');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, alpha: true, powerPreference: 'high-performance' }); }
  catch { stage.classList.add('nogl'); return; }

  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, isMobile ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = 0.55;
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

  // Luces rojas que orbitan y una luz fría de contorno
  const redA = new THREE.PointLight(0xc4161c, 90, 14, 2); scene.add(redA);
  const redB = new THREE.PointLight(0xff2a1a, 70, 14, 2); scene.add(redB);
  const rim = new THREE.DirectionalLight(0xbfd8ff, 1.2); rim.position.set(-3, 4, -4); scene.add(rim);
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 5, 4); scene.add(key);

  // Piso: sombra de contacto suave + aro rojo de luz
  const radial = (stops) => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d'), g = x.createRadialGradient(128, 128, 4, 128, 128, 128);
    stops.forEach(([o, col]) => g.addColorStop(o, col)); x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), new THREE.MeshBasicMaterial({ map: radial([[0, 'rgba(0,0,0,.9)'], [.55, 'rgba(0,0,0,.45)'], [1, 'rgba(0,0,0,0)']]), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; scene.add(shadow);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ map: radial([[0, 'rgba(196,22,28,.0)'], [.45, 'rgba(196,22,28,.22)'], [.7, 'rgba(196,22,28,.08)'], [1, 'rgba(196,22,28,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.005; scene.add(glow);
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.45, 3.48, 128), new THREE.MeshBasicMaterial({ color: 0xc4161c, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; scene.add(ring);

  // Agua en el aire: gotas finas que caen despacio y burbujas que suben
  const nDrop = isMobile ? 45 : 130, dPos = new Float32Array(nDrop * 3), dVel = new Float32Array(nDrop);
  const resetDrop = (i, top = true) => { dPos[i * 3] = (Math.random() - .5) * 6.5; dPos[i * 3 + 1] = top ? 3.4 + Math.random() * 1.2 : Math.random() * 4; dPos[i * 3 + 2] = (Math.random() - .5) * 4; dVel[i] = .008 + Math.random() * .014; };
  for (let i = 0; i < nDrop; i++) resetDrop(i, false);
  const dropGeo = new THREE.BufferGeometry(); dropGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
  scene.add(new THREE.Points(dropGeo, new THREE.PointsMaterial({ color: 0xcfe6ff, size: isMobile ? .035 : .03, transparent: true, opacity: .6, depthWrite: false })));
  const nB = isMobile ? 14 : 36, bPos = new Float32Array(nB * 3);
  for (let i = 0; i < nB; i++) { bPos[i * 3] = (Math.random() - .5) * 6; bPos[i * 3 + 1] = Math.random() * 3.2; bPos[i * 3 + 2] = (Math.random() - .5) * 3.5; }
  const bubGeo = new THREE.BufferGeometry(); bubGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3));
  scene.add(new THREE.Points(bubGeo, new THREE.PointsMaterial({ map: radial([[0, 'rgba(255,255,255,.05)'], [.8, 'rgba(255,255,255,.25)'], [1, 'rgba(255,255,255,.9)']]), size: .12, transparent: true, opacity: .55, depthWrite: false })));

  let holder = null, introStart = 0;
  loadCar(MODEL_URL, { isMobile }).then((car) => {
    holder = car; scene.add(car); introStart = performance.now(); stage.classList.add('ready');
  }).catch(() => stage.classList.add('nogl'));

  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.position.set(0, 2.2, w / h < 1.4 ? 8.4 : 10); camera.updateProjectionMatrix();
  };
  resize(); addEventListener('resize', resize);

  let visible = true; new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(stage);
  let tx = 0, ty = 0;
  if (!isMobile) stage.addEventListener('pointermove', (e) => { const r = stage.getBoundingClientRect(); tx = (e.clientX - r.left) / r.width - .5; ty = (e.clientY - r.top) / r.height - .5; });

  const clock = new THREE.Clock();
  let spin = 0;
  (function frame() {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;
    if (!reduceMotion) {
      spin += dt * 0.32;
      redA.position.set(Math.cos(t * .5) * 4.5, 1.4, Math.sin(t * .5) * 4.5);
      redB.position.set(Math.cos(t * .5 + 3.1) * 4.5, 1.0, Math.sin(t * .5 + 3.1) * 4.5);
      ring.material.opacity = 0.7 + Math.sin(t * 1.6) * 0.15;
      const d = dropGeo.attributes.position.array;
      for (let i = 0; i < nDrop; i++) { d[i * 3 + 1] -= dVel[i]; if (d[i * 3 + 1] < .05) resetDrop(i); }
      dropGeo.attributes.position.needsUpdate = true;
      const b = bubGeo.attributes.position.array;
      for (let i = 0; i < nB; i++) { b[i * 3 + 1] += .004 + (i % 5) * .0008; b[i * 3] += Math.sin(t * .8 + i) * .0015; if (b[i * 3 + 1] > 3.6) b[i * 3 + 1] = 0; }
      bubGeo.attributes.position.needsUpdate = true;
    }
    if (holder) {
      // Entrada suave: el carro gira un poco más rápido al aparecer y se asienta
      const k = reduceMotion ? 1 : Math.min((performance.now() - introStart) / 2600, 1);
      holder.rotation.y = 0.6 + spin + (1 - easeOutCubic(k)) * 1.4 + tx * 0.35 + scrollY * 0.0008;
      holder.position.y = (1 - easeOutCubic(k)) * -0.15;
    }
    camera.position.y = 2.2 + ty * .6; camera.lookAt(0, .55, 0);
    renderer.render(scene, camera);
  })();
}
