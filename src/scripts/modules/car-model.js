import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Reflejos de estudio realistas para la pintura y los cristales. */
export function makeEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return env;
}

const PAINT_MAIN = new THREE.Color(0x050505);
const PAINT_TRIM = new THREE.Color(0x0b0b0b);

/**
 * Carga el modelo (Car Concept, CC BY 4.0 — ver public/models/LICENSE.md),
 * lo pinta de negro brillante y lo centra a una escala fija.
 */
export async function loadCar(url, { isMobile }) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;

  model.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const name = m.name || '';
      if (name.startsWith('Paint')) {
        m.color.copy(name.startsWith('Paint 1') ? PAINT_MAIN : PAINT_TRIM);
        m.metalness = 0.9; m.roughness = 0.2;
        m.clearcoat = 1; m.clearcoatRoughness = 0.03;
        m.envMapIntensity = 1.2;
      } else if (name === 'Glass') {
        // El vidrio con transmisión es caro en celular: lo cambiamos por uno translúcido simple
        m.transmission = 0; m.transparent = true; m.opacity = isMobile ? 0.8 : 0.55;
        m.color.set(0x070b10); m.roughness = 0.05; m.depthWrite = false;
      } else if (name === 'License') {
        o.visible = false;
      }
    }
  });
  const plate = model.getObjectByName('License Plate'); if (plate) plate.visible = false;

  // Centrar y escalar: largo ≈ 4.6 unidades, apoyado en el piso
  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
  const scale = 4.6 / Math.max(size.x, size.z);
  model.scale.setScalar(scale);
  const box2 = new THREE.Box3().setFromObject(model), c = box2.getCenter(new THREE.Vector3());
  model.position.set(-c.x, -box2.min.y, -c.z);

  const pivot = new THREE.Group();
  pivot.add(model);
  // Si el modelo está más largo en Z, lo giramos para que "mire" a +X como el resto de la escena
  if (size.z > size.x) pivot.rotation.y = Math.PI / 2;
  const holder = new THREE.Group();
  holder.add(pivot);
  return holder;
}
