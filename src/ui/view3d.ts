// 3D tank view: the uploaded STL itself, floating at its computed draft and moving with the
// simulated motion. Water is a displaced wireframe grid, as in the original app. Units: mm, z up.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SimResult, elevation } from "../engine/sim";

export interface Rest {
  xG: number;
  yG: number;
  zG: number;
  draft: number;
}
export interface Live {
  rollDeg: number;
  pitchDeg: number;
  heaveMm: number;
  time: number;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class View3D {
  playing = true;
  speed = 0.25;
  onLive: (l: Live) => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 1, 30000);
  private controls: OrbitControls;
  private pivot = new THREE.Group();
  private hull: THREE.Mesh | null = null;
  private hullMat = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.04, side: THREE.DoubleSide });
  private water = new THREE.Group();
  private waterPos!: THREE.BufferAttribute;
  private waterCol!: THREE.BufferAttribute;
  private fillMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
  private lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
  private tank = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }));
  private bow = new THREE.Group();
  private grid = { nx: 0, ny: 0, x0: 0, y0: 0, dx: 0, dy: 0 };
  private length = 220;
  private rest: Rest = { xG: 110, yG: 0, zG: 8, draft: 8 };
  private sim: SimResult | null = null;
  private hs = 1;
  private simTime = 0;
  private last = 0;
  private colLow = new THREE.Color();
  private colHigh = new THREE.Color();
  private tankSize = { lengthM: 2.2, widthM: 1.1, depthM: 0.55 };

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6660, 1.25));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-300, -500, 900);
    this.scene.add(sun);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
    fillLight.position.set(400, 600, 200);
    this.scene.add(fillLight);
    this.pivot.rotation.order = "YXZ";
    this.scene.add(this.pivot, this.water, this.tank, this.bow);
    this.applyTheme();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) this.playing = false;
    this.renderer.setAnimationLoop((ms) => this.frame(ms));
  }

  applyTheme() {
    this.hullMat.color.set(css("--hull") || "#cfcac2");
    this.fillMat.color.set(css("--water-fill") || "#7f8a8c");
    this.colLow.set(css("--water-low") || "#8d8a85");
    this.colHigh.set(css("--water-high") || "#3b3936");
    (this.tank.material as THREE.LineBasicMaterial).color.set(css("--faint") || "#a8a49e");
    this.buildBow();
  }

  /** trisMm: placed triangles (stern at x = 0, centred in y, keel at z = 0). */
  setHull(trisMm: Float32Array, lengthMm: number, refit: boolean) {
    if (this.hull) {
      this.pivot.remove(this.hull);
      this.hull.geometry.dispose();
    }
    let geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(trisMm, 3));
    if (trisMm.length / 9 < 300000) geo = toCreasedNormals(geo, 0.55);
    else geo.computeVertexNormals();
    this.hull = new THREE.Mesh(geo, this.hullMat);
    this.hull.position.set(-this.rest.xG, -this.rest.yG, -this.rest.zG);
    this.pivot.add(this.hull);
    this.length = lengthMm;
    this.buildWater();
    this.buildTank();
    this.buildBow();
    if (refit) this.resetCamera();
  }

  setCase(rest: Rest, sim: SimResult | null, hsMm: number) {
    this.rest = rest;
    const changed = this.sim !== sim;
    this.sim = sim;
    this.hs = Math.max(0.5, hsMm);
    if (changed) this.simTime = sim ? sim.run.ramp : 0;
    this.hull?.position.set(-rest.xG, -rest.yG, -rest.zG);
    this.buildBow();
  }

  setTank(t: { lengthM: number; widthM: number; depthM: number }) {
    this.tankSize = t;
    this.buildTank();
  }

  restart() {
    this.simTime = 0;
  }

  resetCamera() {
    const L = this.length;
    const c = new THREE.Vector3(L / 2 - this.rest.xG, 0, 0);
    this.controls.target.copy(c);
    const k = Math.max(1, 1.35 / this.camera.aspect); // step back on narrow or tall views
    this.camera.position.set(c.x - 1.0 * L * k, -1.65 * L * k, 0.85 * L * k);
    this.controls.minDistance = 0.25 * L;
    this.controls.maxDistance = 14 * L;
    this.controls.update();
  }

  private buildWater() {
    this.water.clear();
    const L = this.length;
    const w = Math.max(3.4 * L, 500), d = Math.max(2.6 * L, 400);
    const nx = 150, ny = 110;
    this.grid = { nx, ny, x0: L / 2 - this.rest.xG - w / 2, y0: -d / 2, dx: w / nx, dy: d / ny };
    const count = (nx + 1) * (ny + 1);
    this.waterPos = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.waterCol = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    const tri: number[] = [], seg: number[] = [];
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const k = j * (nx + 1) + i;
        this.waterPos.setXYZ(k, this.grid.x0 + i * this.grid.dx, this.grid.y0 + j * this.grid.dy, 0);
        if (i < nx && j < ny) tri.push(k, k + 1, k + nx + 2, k, k + nx + 2, k + nx + 1);
        if (i < nx && j % 2 === 0) seg.push(k, k + 1);
        if (j < ny && i % 2 === 0) seg.push(k, k + nx + 1);
      }
    const fill = new THREE.BufferGeometry();
    fill.setAttribute("position", this.waterPos);
    fill.setIndex(tri);
    const lines = new THREE.BufferGeometry();
    lines.setAttribute("position", this.waterPos);
    lines.setAttribute("color", this.waterCol);
    lines.setIndex(seg);
    const fillMesh = new THREE.Mesh(fill, this.fillMat);
    fillMesh.renderOrder = 2;
    const lineMesh = new THREE.LineSegments(lines, this.lineMat);
    lineMesh.renderOrder = 3;
    fillMesh.frustumCulled = lineMesh.frustumCulled = false;
    this.water.add(fillMesh, lineMesh);
  }

  private buildTank() {
    const { lengthM, widthM, depthM } = this.tankSize;
    const cx = this.length / 2 - this.rest.xG;
    const x0 = cx - 0.6 * lengthM * 1000, x1 = cx + 0.4 * lengthM * 1000, y = (widthM * 1000) / 2, zb = -depthM * 1000, zt = 40;
    const p: number[] = [];
    const edge = (a: number[], b: number[]) => p.push(...a, ...b);
    for (const z of [zb, 0, zt]) {
      edge([x0, -y, z], [x1, -y, z]);
      edge([x1, -y, z], [x1, y, z]);
      edge([x1, y, z], [x0, y, z]);
      edge([x0, y, z], [x0, -y, z]);
    }
    for (const [x, yy] of [[x0, -y], [x1, -y], [x1, y], [x0, y]]) edge([x, yy, zb], [x, yy, zt]);
    this.tank.geometry.dispose();
    this.tank.geometry = new THREE.BufferGeometry();
    this.tank.geometry.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  }

  private buildBow() {
    this.bow.clear();
    const L = this.length, s = Math.max(6, L * 0.045);
    const x = L - this.rest.xG + s * 1.4;
    const accent = new THREE.Color(css("--accent") || "#c8611c");
    const shape = new THREE.BufferGeometry();
    shape.setAttribute("position", new THREE.Float32BufferAttribute([x, -s * 0.55, 0.6, x + s, 0, 0.6, x, s * 0.55, 0.6], 3));
    this.bow.add(new THREE.Mesh(shape, new THREE.MeshBasicMaterial({ color: accent, side: THREE.DoubleSide })));
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 96;
    const g = cv.getContext("2d")!;
    g.font = "600 54px Inter, system-ui, sans-serif";
    g.fillStyle = `#${accent.getHexString()}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("BOW", 128, 50);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    sprite.scale.set(s * 3.2, s * 1.2, 1);
    sprite.position.set(x + s * 2.6, 0, s * 0.5);
    this.bow.add(sprite);
  }

  private resize() {
    const el = this.canvas.parentElement!;
    const w = Math.max(50, el.clientWidth), h = Math.max(50, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(ms: number) {
    const dtReal = Math.min(0.1, (ms - this.last) / 1000 || 0);
    this.last = ms;
    const sim = this.sim;
    let roll = 0, pitch = 0, heave = 0;
    if (sim) {
      if (this.playing) this.simTime += dtReal * this.speed;
      const end = sim.steps * sim.dt;
      if (this.simTime >= end) this.simTime = sim.capsized ? 0 : sim.run.ramp;
      const f = this.simTime / sim.dt, i = Math.min(sim.steps - 1, Math.floor(f)), j = Math.min(sim.steps - 1, i + 1), a = f - i;
      roll = sim.roll[i] + (sim.roll[j] - sim.roll[i]) * a;
      pitch = sim.pitch[i] + (sim.pitch[j] - sim.pitch[i]) * a;
      heave = (sim.heave[i] + (sim.heave[j] - sim.heave[i]) * a) * 1000;
    }
    this.pivot.position.set(0, 0, this.rest.zG - this.rest.draft + heave);
    this.pivot.rotation.x = roll;
    this.pivot.rotation.y = pitch;
    this.updateWater();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.onLive({ rollDeg: (roll * 180) / Math.PI, pitchDeg: (pitch * 180) / Math.PI, heaveMm: heave, time: this.simTime });
  }

  private updateWater() {
    if (!this.waterPos) return;
    const { nx, ny, x0, y0, dx, dy } = this.grid;
    const sim = this.sim;
    const beam = sim?.run.beam ?? false;
    const n = beam ? ny : nx;
    const eta = new Float32Array(n + 1);
    if (sim) for (let i = 0; i <= n; i++) eta[i] = 1000 * elevation(sim.run, (beam ? y0 + i * dy : x0 + i * dx) / 1000, this.simTime);
    const pos = this.waterPos.array as Float32Array, col = this.waterCol.array as Float32Array;
    const c = new THREE.Color();
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const k = j * (nx + 1) + i;
        const e = eta[beam ? j : i];
        pos[k * 3 + 2] = e;
        c.copy(this.colLow).lerp(this.colHigh, Math.min(1, Math.max(0, 0.5 + e / this.hs)));
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
      }
    this.waterPos.needsUpdate = true;
    this.waterCol.needsUpdate = true;
  }
}
