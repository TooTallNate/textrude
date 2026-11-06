import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Model } from './protocol';

export type View = 'perspective' | 'top' | 'bottom' | 'front';

const VIEW_DIRECTIONS: Record<View, THREE.Vector3> = {
  perspective: new THREE.Vector3(0.3, -1, 1.1).normalize(),
  front: new THREE.Vector3(0, -1, 0.12).normalize(),
  // (Slightly off-axis: OrbitControls can't orbit from exactly along the up axis.)
  top: new THREE.Vector3(0, -0.0001, 1).normalize(),
  bottom: new THREE.Vector3(0, -0.0001, -1).normalize(),
};

const BACKGROUND = new THREE.Color('#18181b');

/**
 * The three.js scene: the model's parts (Z up, in mm) on a print bed, with orbit controls. The
 * camera follows the model as it changes until the user moves it.
 */
export class PreviewScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
  private controls: OrbitControls;
  private model = new THREE.Group();
  private bed = new THREE.Group();
  private light = new THREE.DirectionalLight(0xffffff, 1.8);
  private dirty = true;
  private view: View = 'perspective';
  private follow = true;
  private bedSize: [number, number] | null = null;
  private resizeObserver: ResizeObserver;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'block h-full w-full touch-none outline-none';

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = BACKGROUND;
    pmrem.dispose();

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -150, 150);

    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0005;
    this.light.shadow.normalBias = 0.05;
    this.light.shadow.radius = 4;
    this.scene.add(this.light, this.light.target, this.bed, this.model);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('start', () => (this.follow = false));
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.buildBed();

    this.renderer.setAnimationLoop(() => {
      const moved = this.controls.update();
      if (moved || this.dirty) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
    });
  }

  setModel(model: Model | null, hidden: Set<string>) {
    for (const child of this.model.children as THREE.Mesh[]) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    this.model.clear();
    for (const part of model?.parts ?? []) {
      const indexed = new THREE.BufferGeometry();
      indexed.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      indexed.setIndex(new THREE.BufferAttribute(part.indices, 1));
      // Smooth normals along curved walls, sharp edges where the walls meet the caps.
      const geometry = toCreasedNormals(indexed, Math.PI / 6);
      indexed.dispose();
      const material = new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.55, metalness: 0 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = part.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = !hidden.has(part.id);
      this.model.add(mesh);
    }
    this.buildBed();
    this.placeLight();
    if (this.follow) this.fit(this.view);
    this.dirty = true;
  }

  setHidden(hidden: Set<string>) {
    for (const child of this.model.children) child.visible = !hidden.has(child.name);
    this.dirty = true;
  }

  /** Show the printer's bed (mm), or a floor sized to the model when null. */
  setBed(size: [number, number] | null) {
    this.bedSize = size;
    this.buildBed();
    this.dirty = true;
  }

  /** Frame the model from a direction; the camera follows the model again until moved. */
  fit(view: View = this.view) {
    this.view = view;
    this.follow = true;
    const box = this.modelBox();
    const center = box.getCenter(new THREE.Vector3());
    const dir = VIEW_DIRECTIONS[view];
    // The camera's axes when looking along -dir.
    const look = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), this.camera.up);
    const right = new THREE.Vector3().setFromMatrixColumn(look, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(look, 1);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 0.85;
    const tanH = tanV * this.camera.aspect;
    // The smallest distance at which every corner of the box is in view.
    let distance = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const depth = p.dot(dir);
      distance = Math.max(distance, depth + Math.abs(p.dot(right)) / tanH, depth + Math.abs(p.dot(up)) / tanV);
    }
    distance = Math.max(distance, 20);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.setModel(null, new Set());
    this.disposeBed();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private modelBox() {
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) box.set(new THREE.Vector3(-20, -10, 0), new THREE.Vector3(20, 10, 2));
    return box;
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private placeLight() {
    const box = this.modelBox();
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 10);
    this.light.position.copy(sphere.center).add(new THREE.Vector3(-0.5, -0.8, 1.6).multiplyScalar(r * 2));
    this.light.target.position.copy(sphere.center);
    const cam = this.light.shadow.camera;
    cam.left = cam.bottom = -r * 1.5;
    cam.right = cam.top = r * 1.5;
    cam.near = r * 0.5;
    cam.far = r * 6;
    cam.updateProjectionMatrix();
  }

  private disposeBed() {
    this.bed.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.bed.clear();
  }

  private buildBed() {
    this.disposeBed();
    let w: number;
    let d: number;
    if (this.bedSize) {
      [w, d] = this.bedSize;
    } else {
      // A floor around the model, in whole centimeters.
      const size = this.modelBox().getSize(new THREE.Vector3());
      const side = Math.max(100, Math.ceil((Math.max(size.x, size.y) * 1.6) / 20) * 20);
      w = d = side;
    }
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: '#2a2a2e', roughness: 0.9, metalness: 0 }),
    );
    // Just below the model's bottom faces, so they don't z-fight.
    plate.position.z = -0.05;
    plate.receiveShadow = true;
    this.bed.add(plate);

    const minor: number[] = [];
    const major: number[] = [];
    const step = 10;
    for (let x = 0; x <= w / 2 + 1e-6; x += step) {
      for (const sx of x ? [x, -x] : [0]) (Math.round(Math.abs(sx)) % 50 === 0 ? major : minor).push(sx, -d / 2, 0, sx, d / 2, 0);
    }
    for (let y = 0; y <= d / 2 + 1e-6; y += step) {
      for (const sy of y ? [y, -y] : [0]) (Math.round(Math.abs(sy)) % 50 === 0 ? major : minor).push(-w / 2, sy, 0, w / 2, sy, 0);
    }
    for (const [points, opacity] of [[minor, 0.08], [major, 0.18]] as const) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity }));
      lines.position.z = -0.04;
      this.bed.add(lines);
    }
    // Bed outline.
    const outline = new THREE.BufferGeometry();
    outline.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, d / 2, 0, w / 2, d / 2, 0, -w / 2, d / 2, 0, -w / 2, d / 2, 0, -w / 2, -d / 2, 0], 3),
    );
    const border = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.3 }));
    border.position.z = -0.04;
    this.bed.add(border);
  }
}
