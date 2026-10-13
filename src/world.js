import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Sky } from "three/addons/objects/Sky.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { UrbanLife } from "./urban-life.js";
import { loadPhysicalMaterials } from "./materials.js";
import { createBuildingDetails, splitRoofGeometry } from "./facades.js";
import { createRoofDetails } from "./roof-details.js";
import { passageWallGeometry } from "./passage.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { roofGeometry } from "./roof-geometry.js";
import { createOSMScenery } from "./osm-scenery.js";

const rand = (n) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const palettes = [
  "#d5c29b",
  "#ddccb5",
  "#d2bea1",
  "#cdb18e",
  "#e5dcc8",
  "#c7beab",
  "#cfb3a5",
  "#e0c98d",
  "#c0c9ba",
  "#e0d8bf",
  "#cdb8a4",
  "#d8cbad",
];
function texture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
function facade(color, variant = 0) {
  return texture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 19000; i++) {
      const x = rand(i + variant) * w,
        y = rand(i * 2.1 + 33) * h;
      ctx.fillStyle =
        rand(i) < 0.5 ? "rgba(63,46,28,.035)" : "rgba(255,248,224,.06)";
      ctx.fillRect(x, y, 2, 2);
    }
    for (let floor = 0; floor < 4; floor++) {
      const y = floor * 128;
      ctx.fillStyle = "#f0e5d0";
      ctx.fillRect(0, y, w, 4);
      ctx.fillStyle = "#746b5955";
      ctx.fillRect(0, y + 4, w, 3);
      for (let col = 0; col < 4; col++) {
        const x = col * 128 + 32;
        ctx.fillStyle = "#b4a68a";
        ctx.fillRect(x - 6, y + 21, 64, 83);
        ctx.fillStyle = "#f0e5cf";
        ctx.fillRect(x - 3, y + 17, 58, 82);
        ctx.fillStyle = "#3d4c4c";
        ctx.fillRect(x + 2, y + 23, 48, 72);
        const g = ctx.createLinearGradient(x, y + 22, x + 45, y + 90);
        g.addColorStop(0, "#a6b8bb");
        g.addColorStop(0.45, "#6c8387");
        g.addColorStop(1, "#3d5054");
        ctx.fillStyle = g;
        ctx.fillRect(x + 4, y + 25, 44, 66);
        ctx.fillStyle = "#1e302a5a";
        ctx.fillRect(x + 6, y + 29, 13, 58);
        ctx.fillRect(x + 31, y + 29, 13, 58);
        ctx.fillStyle = "#ece3cf";
        ctx.fillRect(x + 24, y + 24, 3, 69);
        ctx.fillRect(x + 2, y + 55, 48, 3);
        ctx.fillStyle = "#e6d9c3";
        ctx.fillRect(x - 6, y + 95, 65, 5);
        ctx.fillStyle = "#52493b66";
        ctx.fillRect(x - 6, y + 100, 65, 3);
        if (floor === 0) {
          ctx.fillStyle = "#92836c";
          ctx.fillRect(x - 7, y + 106, 66, 3);
        }
      }
    }
  });
}
function cobble() {
  return texture(512, 512, (c, w, h) => {
    c.fillStyle = "#5d5f58";
    c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 32)
      for (let x = -32; x < w; x += 48) {
        const offset = ((y / 32) % 2) * 24,
          rr = rand(x + y * 81);
        c.fillStyle = `hsl(43,${4 + rr * 4}%,${41 + rr * 12}%)`;
        c.fillRect(x + offset + 2, y + 2, 44, 27);
        c.fillStyle = "#d0cbb52a";
        c.fillRect(x + offset + 3, y + 2, 43, 2);
        c.fillStyle = "#111f193d";
        c.fillRect(x + offset + 43, y + 3, 3, 26);
      }
    for (let i = 0; i < 14000; i++) {
      c.fillStyle = i % 2 ? "#101c1520" : "#ffffdf20";
      c.fillRect(rand(i) * w, rand(i + 153) * h, 1, 1);
    }
  });
}
function asphalt() {
  return texture(256, 256, (c, w, h) => {
    c.fillStyle = "#575957";
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 16000; i++) {
      c.fillStyle = i % 3 ? "rgba(214,209,195,.11)" : "rgba(8,22,15,.13)";
      c.fillRect(rand(i) * w, rand(i + 591) * h, 1, 1);
    }
    c.strokeStyle = "#303d345a";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(30, 0);
    c.bezierCurveTo(80, 80, 120, 55, 180, 200);
    c.stroke();
  });
}
function roofs() {
  return texture(256, 256, (c, w, h) => {
    c.fillStyle = "#875043";
    c.fillRect(0, 0, w, h);
    for (let y = 0; y < 256; y += 16)
      for (let x = 0; x < 256; x += 16) {
        c.fillStyle = `hsl(14,${25 + rand(x + y * 3) * 12}%,${28 + rand(x * 31 + y) * 16}%)`;
        c.fillRect(x + 1, y + 1, 15, 14);
        c.fillStyle = "#efbf7930";
        c.fillRect(x + 1, y + 1, 3, 12);
        c.fillStyle = "#382c2366";
        c.fillRect(x + 12, y + 2, 3, 13);
      }
  });
}
function surface(route, s0, s1, width, offset = 0, lift = 0, step = 4) {
  const positions = [],
    uv = [],
    indices = [];
  const n = Math.ceil((s1 - s0) / step);
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    for (let j = 0; j < 2; j++) {
      const lateral = typeof offset === "function" ? offset(s) : offset;
      const p = route.at(s, lateral + (j - 0.5) * width);
      positions.push(p.x, p.y + lift, p.z);
      uv.push((j * width) / 4, s / 4);
    }
    if (i < n) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
function footprintGeometry(points, height, base) {
  const pos = [],
    uv = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1],
      l = Math.hypot(a.x - b.x, a.z - b.z);
    const vs = [
      [a.x, base, a.z],
      [b.x, base, b.z],
      [b.x, base + height, b.z],
      [a.x, base, a.z],
      [b.x, base + height, b.z],
      [a.x, base + height, a.z],
    ];
    vs.forEach((v) => pos.push(...v));
    uv.push(
      0,
      0,
      l / 4,
      0,
      l / 4,
      height / 4,
      0,
      0,
      l / 4,
      height / 4,
      0,
      height / 4,
    );
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
function polygonTop(points, y, holes = []) {
  const shape = new THREE.Shape(
    points.map((p) => new THREE.Vector2(p.x, -p.z)),
  );
  for (const hole of holes)
    shape.holes.push(
      new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, -p.z))),
    );
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}
function label(
  text,
  width = 4,
  height = 0.65,
  {
    background = "#292e27",
    color = "#f5e6ba",
    font = "500 42px sans-serif",
  } = {},
) {
  const map = texture(512, 96, (ctx) => {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 512, 96);
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 256, 48, 488);
  });
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }),
  );
  return mesh;
}
function box(group, size, pos, mat) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.position.set(...pos);
  group.add(mesh);
  return mesh;
}
function line3(points, material) {
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
    ),
    material,
  );
}

export class World {
  constructor(canvas, route, city, onProgress) {
    this.route = route;
    this.city = city;
    this.crossingData = { crossings: city.crossings ?? [] };
    this.progress = onProgress;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.info.autoReset = false;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xaab6bc, 0.00072);
    this.camera = new THREE.PerspectiveCamera(
      65,
      innerWidth / innerHeight,
      0.035,
      2000,
    );
    this.chunks = [];
    this.cameraObstacles = [];
    this.entityGroups = [];
    this.signals = [];
    this.traffic = [];
    this.pedestrians = [];
    this.doorMeshes = [];
    this.cameraMode = 0;
    this.look = 0;
    this.pitch = 0;
    this.weather = "clear";
    this.time = 0;
    this.lastCull = -100;
    this.wipers = false;
    this.assets = {};
    this.quality = "high";
    this.collidedAt = -100;
    this.cameraInitialized = false;
    const env = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = env.fromScene(new RoomEnvironment(), 0.04).texture;
    env.dispose();
    this.sky = new Sky();
    this.sky.scale.setScalar(450000);
    this.scene.add(this.sky);
    this.sky.material.uniforms.turbidity.value = 3.2;
    this.sky.material.uniforms.rayleigh.value = 1.6;
    this.sky.material.uniforms.mieCoefficient.value = 0.003;
    this.sky.material.uniforms.mieDirectionalG.value = 0.8;
    this.ambient = new THREE.HemisphereLight(0xd6ebf4, 0x62594a, 0.35);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffedd5, 3.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.camera.left = -65;
    this.sun.shadow.camera.right = 65;
    this.sun.shadow.camera.top = 65;
    this.sun.shadow.camera.bottom = -65;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 550;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.025;
    this.scene.add(this.sun, this.sun.target);
    this.materials = {
      grass: new THREE.MeshStandardMaterial({ color: 0x78816a, roughness: 1 }),
      sidewalk: new THREE.MeshStandardMaterial({
        color: 0xb7b4a2,
        map: cobble(),
        roughness: 0.95,
      }),
      cobble: new THREE.MeshStandardMaterial({
        map: cobble(),
        roughness: 0.86,
        bumpScale: 0.06,
      }),
      asphalt: new THREE.MeshStandardMaterial({
        map: asphalt(),
        roughness: 0.94,
        bumpScale: 0.03,
      }),
      rail: new THREE.MeshStandardMaterial({
        color: 0xb6b7aa,
        metalness: 0.9,
        roughness: 0.27,
      }),
      groove: new THREE.MeshStandardMaterial({ color: 0x343a34, roughness: 1 }),
      iron: new THREE.MeshStandardMaterial({
        color: 0x3b4844,
        metalness: 0.6,
        roughness: 0.48,
      }),
      cream: new THREE.MeshStandardMaterial({
        color: 0xe3d7b6,
        roughness: 0.7,
      }),
      red: new THREE.MeshStandardMaterial({ color: 0xb9312c, roughness: 0.46 }),
      roof: new THREE.MeshStandardMaterial({
        map: roofs(),
        roughness: 0.82,
        side: THREE.DoubleSide,
      }),
      white: new THREE.MeshStandardMaterial({
        color: 0xddd6ba,
        roughness: 0.9,
      }),
      facades: palettes.map(
        (c, i) =>
          new THREE.MeshStandardMaterial({
            color: c,
            roughness: 0.9,
            side: THREE.DoubleSide,
          }),
      ),
    };
    this.materials.cobble.bumpMap = this.materials.cobble.map;
    this.materials.asphalt.bumpMap = this.materials.asphalt.map;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(50000, 50000),
      this.materials.grass,
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -10;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }
  async init() {
    this.progress("Načítání fotogrammetrických materiálů a HDR světla");
    await loadPhysicalMaterials(this);
    this.progress("Pokládání kolejí a trolejového vedení");
    this.createTrack();
    await new Promise((r) => setTimeout(r, 20));
    this.progress("Stavba pražských ulic");
    this.createCity();
    await new Promise((r) => setTimeout(r, 20));
    this.progress("Načítání modelů z Blenderu");
    const loader = new GLTFLoader();
    const names = [
      "tram",
      "car",
      "van",
      "hatchback",
      "tree",
      "pedestrian",
      "pedestrian_2",
      "pedestrian_3",
      "pedestrian_4",
      "lamp",
      "shelter",
      "landmark_narodni",
      "landmark_mikulas",
    ];
    const results = await Promise.all(
      names.map(async (name) => {
        try {
          const gltf = await loader.loadAsync(
            `${import.meta.env.BASE_URL}models/${name}.glb`,
          );
          this.assets[name] = gltf.scene;
          return { name, ok: true };
        } catch (e) {
          console.warn(`Model ${name}:`, e.message);
          return { name, ok: false };
        }
      }),
    );
    this.modelStatus = results;
    this.tram = this.assets.tram?.clone(true) ?? this.fallbackTram();
    this.doorMeshes = this.prepareTram(this.tram);
    this.scene.add(this.tram);
    this.rearTram = this.assets.tram?.clone(true) ?? this.fallbackTram();
    this.rearDoorMeshes = this.prepareTram(this.rearTram, false);
    this.scene.add(this.rearTram);
    this.createStops();
    this.createStreetLamps();
    this.urban = new UrbanLife(this);
    this.signalConfigs = this.urban.signalConfigs;
    this.createPhotographicTrees();
    this.createLandmarks();
    this.createWipers();
    this.createRain();
    this.createHeadlights();
    this.createPostprocessing();
    this.speedNeedle = this.tram.getObjectByName("speed_needle");
    this.setWeather("clear");
    this.update(
      0,
      { s: this.route.stops[15].s, doorProgress: 0, time: 0, speed: 0 },
      true,
    );
    return this;
  }
  prepareTram(model, cabin = true) {
    const doors = [];
    model.traverse((o) => {
      if (!cabin && /^DetailedCabin(?:_|$)/.test(o.name)) o.visible = false;
      if (/^door_(front|middle|rear)_leaf[0-3]$/.test(o.name)) doors.push(o);
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (/glass|window|glazing/i.test(o.material?.name ?? "")) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.055;
          o.material.roughness = 0.04;
          o.material.envMapIntensity = 0.25;
          o.material.depthWrite = false;
          o.material.side = THREE.DoubleSide;
        }
      }
    });
    return doors;
  }
  fallbackTram() {
    const g = new THREE.Group();
    box(g, [2.5, 1.1, 13.8], [0, 1.45, 0], this.materials.red);
    box(g, [2.45, 1.25, 13.2], [0, 2.62, 0], this.materials.cream);
    return g;
  }
  createTrack() {
    const wireMat = new THREE.LineBasicMaterial({ color: 0x494a40 });
    const allPoles = [],
      crossWires = [];
    for (let s0 = 0; s0 < this.route.length; s0 += 180) {
      const s1 = Math.min(this.route.length, s0 + 180),
        group = new THREE.Group(),
        historic = this.route.isHistoric((s0 + s1) / 2),
        bridge = this.route.isBridge((s0 + s1) / 2),
        w = this.streetProfile((s0 + s1) / 2).width;
      const make = (geo, mat) => {
        const m = new THREE.Mesh(geo, mat);
        m.receiveShadow = true;
        group.add(m);
        return m;
      };
      make(
        surface(this.route, s0, s1, w + 12, -1.65, -0.18, 8),
        this.materials.grass,
      );
      make(
        surface(this.route, s0, s1, w + 4, -1.65, 0.09),
        this.materials.sidewalk,
      );
      make(
        surface(this.route, s0, s1, w, -1.65, 0.12),
        historic ? this.materials.cobble : this.materials.asphalt,
      );
      for (const side of [-1, 1])
        make(
          surface(this.route, s0, s1, 1.8, -1.65 + side * (w / 2 + 0.9), 0.27),
          this.materials.sidewalk,
        );
      for (const track of [0, -3.25])
        for (const side of [-0.7485, 0.7485]) {
          make(
            surface(
              this.route,
              s0,
              s1,
              0.18,
              (s) => (track < 0 ? this.route.opposingOffset(s) : track) + side,
              0.137,
            ),
            this.materials.groove,
          );
          make(
            surface(
              this.route,
              s0,
              s1,
              0.062,
              (s) => (track < 0 ? this.route.opposingOffset(s) : track) + side,
              0.154,
            ),
            this.materials.rail,
          );
        }
      for (const track of [0, -3.25]) {
        const pts = [];
        for (let s = s0; s <= s1; s += 6) {
          const p = this.route.at(
            s,
            track < 0 ? this.route.opposingOffset(s) : track,
          );
          p.y += 5.5;
          pts.push(p);
        }
        if (pts.length > 1) group.add(line3(pts, wireMat));
      }
      for (let s = s0 + 10; s < s1; s += 32) {
        const p = this.route.at(s, bridge ? 6.5 : 8.9),
          p2 = this.route.at(s, bridge ? -9.8 : -12.1);
        allPoles.push(p);
        const a = { ...p, y: p.y + 6.05 },
          b = { ...p2, y: p2.y + 6.05 };
        crossWires.push(a, b);
        const cant = new THREE.Group();
        cant.position.set(p.x, p.y, p.z);
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.065, 0.105, 6.15, 7),
          this.materials.iron,
        );
        pole.position.y = 3.1;
        cant.add(pole);
        group.add(cant);
        group.add(line3([a, b], wireMat));
      }
      if (this.route.isBridge((s0 + s1) / 2)) {
        for (const side of [-10, 7]) {
          const pts = [];
          for (let s = s0; s < s1; s += 3) {
            const p = this.route.at(s, side);
            p.y += 1.05;
            pts.push(p);
          }
          group.add(line3(pts, wireMat));
          for (let s = s0; s < s1; s += 3) {
            const p = this.route.at(s, side);
            const post = new THREE.Mesh(
              new THREE.BoxGeometry(0.14, 1.1, 0.14),
              this.materials.iron,
            );
            post.position.set(p.x, p.y + 0.55, p.z);
            group.add(post);
          }
        }
      }
      const p = this.route.at((s0 + s1) / 2);
      this.addChunk(group, p.x, p.z, 130);
    }
  }
  addChunk(group, x, z, radius = 180) {
    this.scene.add(group);
    this.chunks.push({ group, x, z, radius });
  }
  createCity() {
    this.createTerrain();
    const groups = new Map(),
      route = this.route;
    const add = (key, geo, mat, x, z) => {
      const cell = `${Math.floor(x / 160)}:${Math.floor(z / 160)}`,
        id = `${cell}/${key}`;
      if (!groups.has(id))
        groups.set(id, {
          geos: [],
          mat,
          x: (Math.floor(x / 160) + 0.5) * 160,
          z: (Math.floor(z / 160) + 0.5) * 160,
        });
      groups.get(id).geos.push(geo.index ? geo.toNonIndexed() : geo);
    };
    const buildings = this.city?.buildings ?? [];
    this.buildingCount = buildings.length;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i],
        ps = b.points.map((p) =>
          Array.isArray(p)
            ? route.project(p[0], p[1])
            : route.project(p.lat, p.lon),
        );
      if (ps.length < 3) continue;
      if (ps[0].x !== ps.at(-1).x || ps[0].z !== ps.at(-1).z)
        ps.push({ ...ps[0] });
      const mid = {
          x: ps.reduce((sum, p) => sum + p.x, 0) / ps.length,
          z: ps.reduce((sum, p) => sum + p.z, 0) / ps.length,
        },
        near = route.nearest(mid);
      if (near.distance > 500) continue;
      const h = Math.max(4, Math.min(65, b.height ?? (b.levels ?? 4) * 3.25)),
        base = route.height(near.s) + 0.15,
        matIndex = Math.floor(rand(b.id ?? i) * palettes.length);
      const isLandmark = /Mikuláš|Národní divadlo/.test(b.name ?? "");
      if (isLandmark) continue;
      add(
        `wall${matIndex}`,
        b.osmId === "relation/4681559"
          ? passageWallGeometry(ps, h, base, route)
          : footprintGeometry(ps, h, base),
        this.materials.facades[matIndex],
        mid.x,
        mid.z,
      );
      const pitched =
        h <= 34 && b.roofShape !== "flat" && route.isHistoric(near.s);
      const roofKind =
        !pitched || /grey|gray|black|silver/.test(b.roofColor ?? "")
          ? "flatRoof"
          : /brown|dark/.test(b.roofColor ?? "")
            ? "roof"
            : "roofRed";
      const roofMat = this.materials[roofKind];
      const top = pitched
        ? roofGeometry(ps, base + h, h)
        : polygonTop(ps, base + h);
      const split = splitRoofGeometry(top);
      add(roofKind, split.roof, roofMat, mid.x, mid.z);
      if (split.gables?.getAttribute("position").count)
        add(
          `wall${matIndex}`,
          split.gables,
          this.materials.facades[matIndex],
          mid.x,
          mid.z,
        );
      if (!top.index)
        add(
          roofKind,
          polygonTop(
            ps,
            base + h - 0.02,
            (b.holes ?? []).map((hole) => hole.map((p) => route.project(...p))),
          ),
          roofMat,
          mid.x,
          mid.z,
        );
    }
    // Supporting scenery outside mapped footprints is intentionally procedural.
    for (let s = 35; s < route.length; s += 29) {
      if (route.isBridge(s)) continue;
      const p = route.at(s);
      const existing = buildings.some((b) => {
        const pt = b.points[0];
        if (!pt) return false;
        const q = Array.isArray(pt)
          ? route.project(pt[0], pt[1])
          : route.project(pt.lat, pt.lon);
        return Math.hypot(q.x - p.x, q.z - p.z) < 100;
      });
      if (existing) continue;
      for (const side of [-1, 1]) {
        if (rand(s * side) < 0.25) continue;
        const w = 13 + rand(s + side) * 13,
          d = 12 + rand(s * 2) * 9,
          h = route.isHistoric(s) ? 14 + rand(s) * 13 : 8 + rand(s) * 15,
          c = route.at(s, side * (20 + d / 2)),
          angle = p.yaw,
          cs = Math.cos(angle),
          sn = Math.sin(angle);
        const ps = [
          [-w / 2, -d / 2],
          [w / 2, -d / 2],
          [w / 2, d / 2],
          [-w / 2, d / 2],
          [-w / 2, -d / 2],
        ].map(([x, z]) => ({
          x: c.x + x * cs + z * sn,
          z: c.z - x * sn + z * cs,
        }));
        const ix = Math.floor(rand(s + side * 25) * palettes.length);
        add(
          `wall${ix}`,
          footprintGeometry(ps, h, c.y),
          this.materials.facades[ix],
          c.x,
          c.z,
        );
        add(
          "roof",
          roofGeometry(ps, c.y + h, h),
          this.materials.roof,
          c.x,
          c.z,
        );
      }
    }
    for (const entry of groups.values()) {
      const merged = mergeGeometries(entry.geos, false);
      entry.geos.forEach((g) => g.dispose());
      if (merged) {
        const mesh = new THREE.Mesh(merged, entry.mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.cameraObstacles.push(mesh);
        const g = new THREE.Group();
        g.add(mesh);
        this.addChunk(g, entry.x, entry.z, 120);
      }
    }
    createOSMScenery(this);
    createBuildingDetails(this);
    createRoofDetails(this);
    for (const w of this.city?.waters ?? []) {
      const ps = w.points.map((p) => route.project(p[0], p[1]));
      if (ps.length < 3) continue;
      const holes = (w.holes ?? []).map((h) =>
        h.map((p) => route.project(...p)),
      );
      const near = route.nearest(ps[0]),
        wy = w.name === "Vltava" ? -0.1 : route.height(near.s) - 1.5;
      const mesh = new THREE.Mesh(
        polygonTop(ps, wy, holes),
        new THREE.MeshStandardMaterial({
          color: 0x3b747b,
          metalness: 0.25,
          roughness: 0.24,
        }),
      );
      this.scene.add(mesh);
    }
    // Vltava fallback ensures the bridge remains above an open river.
    if (!this.city?.waters?.length) {
      const ps = [
        [50.096, 14.414],
        [50.09, 14.4122],
        [50.084, 14.408],
        [50.078, 14.4095],
        [50.072, 14.414],
        [50.072, 14.4175],
        [50.079, 14.4148],
        [50.084, 14.414],
        [50.091, 14.4172],
        [50.096, 14.417],
      ].map(([lat, lon]) => route.project(lat, lon));
      const mesh = new THREE.Mesh(
        polygonTop(ps, -0.05),
        new THREE.MeshStandardMaterial({
          color: 0x548084,
          roughness: 0.26,
          metalness: 0.35,
        }),
      );
      this.scene.add(mesh);
    }
  }
  createTerrain() {
    const route = this.route,
      step = 65,
      minX = Math.min(...route.points.map((p) => p.x)) - 700,
      maxX = Math.max(...route.points.map((p) => p.x)) + 700,
      minZ = Math.min(...route.points.map((p) => p.z)) - 700,
      maxZ = Math.max(...route.points.map((p) => p.z)) + 700,
      nx = Math.ceil((maxX - minX) / step),
      nz = Math.ceil((maxZ - minZ) / step),
      pos = [],
      uv = [],
      indices = [];
    const water = (this.city.waters ?? [])
      .filter((w) => w.name === "Vltava")
      .map((w) => ({
        points: w.points.map((p) => route.project(...p)),
        holes: (w.holes ?? []).map((h) => h.map((p) => route.project(...p))),
      }));
    const inside = (p, poly) => {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i],
          b = poly[j];
        if (
          a.z > p.z !== b.z > p.z &&
          p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
        )
          hit = !hit;
      }
      return hit;
    };
    for (let zi = 0; zi <= nz; zi++)
      for (let xi = 0; xi <= nx; xi++) {
        const x = minX + xi * step,
          z = minZ + zi * step,
          near = route.nearest({ x, z });
        let y = route.height(near.s) - 4 - Math.min(12, near.distance * 0.01);
        for (const w of water)
          if (
            inside({ x, z }, w.points) &&
            !w.holes.some((h) => inside({ x, z }, h))
          )
            y = -5;
        pos.push(x, y, z);
        uv.push(x / 8, z / 8);
        if (xi < nx && zi < nz) {
          const a = zi * (nx + 1) + xi;
          indices.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
        }
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.materials.grass);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }
  addInstancesByCell(geo, mat, items, shadow) {
    const buckets = new Map();
    for (const p of items) {
      const key = `${Math.floor(p.x / 180)}:${Math.floor(p.z / 180)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }
    const matrix = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      v = new THREE.Vector3(),
      scale = new THREE.Vector3();
    for (const bucket of buckets.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, bucket.length);
      bucket.forEach((p, i) => {
        v.set(p.x, p.y, p.z);
        scale.setScalar(p.scale ?? 1);
        matrix.compose(v, q, scale);
        mesh.setMatrixAt(i, matrix);
      });
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      const group = new THREE.Group();
      group.add(mesh);
      this.addChunk(group, bucket[0].x, bucket[0].z, 180);
    }
  }
  createStops() {
    this.stopGroups = [];
    for (const stop of this.route.stops) {
      const p = this.route.at(stop.s, 2.9),
        g = new THREE.Group();
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.yaw;
      g.updateMatrix();
      const localFromWorld = g.matrix.clone().invert();
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.075, 3.1, 8),
        this.materials.red,
      );
      pole.position.y = 1.55;
      g.add(pole);
      box(g, [0.75, 0.56, 0.1], [0, 3.04, 0], this.materials.red);
      const sign = label("TRAM", 0.65, 0.25, {
        background: "#bd3634",
        font: "bold 44px sans-serif",
      });
      sign.position.set(0, 3.13, 0.06);
      g.add(sign);
      const name = label(stop.name, 1.45, 0.22, {
        background: "#e6deca",
        color: "#293932",
        font: "600 30px sans-serif",
      });
      name.position.set(0, 2.72, 0.07);
      g.add(name);
      const line = label("22", 0.45, 0.33, {
        background: "#eee7d8",
        color: "#242f29",
        font: "bold 65px sans-serif",
      });
      line.position.set(0, 2.36, 0.07);
      g.add(line);
      // Follow both the rail curve and its gradient instead of floating a flat slab.
      const start = Math.max(0, stop.s - 29),
        end = Math.min(this.route.length, stop.s + 1);
      const platformGeo = surface(this.route, start, end, 2.2, 2.45, 0.3, 2);
      platformGeo.applyMatrix4(localFromWorld);
      const platform = new THREE.Mesh(platformGeo, this.materials.sidewalk);
      platform.receiveShadow = true;
      g.add(platform);
      const edgeGeo = surface(this.route, start, end, 0.14, 1.42, 0.31, 2);
      edgeGeo.applyMatrix4(localFromWorld);
      const edge = new THREE.Mesh(edgeGeo, this.materials.white);
      g.add(edge);
      if (this.assets.shelter) {
        const shelter = this.assets.shelter.clone(true);
        const shelterAt = this.route.at(Math.max(0, stop.s - 13), 3.15);
        shelter.position.copy(
          new THREE.Vector3(
            shelterAt.x,
            shelterAt.y + 0.3,
            shelterAt.z,
          ).applyMatrix4(localFromWorld),
        );
        shelter.rotation.y = shelterAt.yaw - p.yaw + Math.PI / 2;
        g.add(shelter);
      }
      this.scene.add(g);
      this.stopGroups.push({ g, s: stop.s });
    }
  }
  createStreetLamps() {
    if (!this.assets.lamp) return;
    for (let s = 15; s < this.route.length; s += 45) {
      const profile = this.streetProfile(s),
        p = this.route.at(s, profile.sidewalkRight);
      const model = this.assets.lamp.clone(true);
      model.position.set(p.x, p.y + 0.27, p.z);
      model.rotation.y = p.yaw;
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          if (/glass|lamp|light/i.test(o.material?.name ?? "")) {
            o.material = o.material.clone();
            o.material.emissive = new THREE.Color(0xffdc9f);
            o.material.emissiveIntensity = 0.25;
          }
        }
      });
      const g = new THREE.Group();
      g.add(model);
      this.addChunk(g, p.x, p.z, 15);
    }
  }
  streetProfile(s) {
    const bridge = this.route.isBridge(s),
      width = bridge ? 13.5 : s > 7700 && s < 9500 ? 14.8 : 23,
      center = -1.65;
    return {
      width,
      center,
      forwardLane: bridge ? 4.3 : width < 18 ? 0 : 5.8,
      reverseLane: bridge
        ? -6.8
        : width < 18
          ? (this.route.opposingOffset?.(s) ?? -3.25)
          : -8.0,
      sidewalkRight: center + width / 2 + 0.95,
      sidewalkLeft: center - width / 2 - 0.95,
    };
  }
  ringBell() {
    this.urban?.bell();
  }
  resetStreetLife(s) {
    this.urban?.reset(s);
    this.cameraInitialized = false;
    this.lastCull = -100;
  }
  createPhotographicTrees() {
    const model = this.assets.tree;
    if (!model) return;
    model.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(model),
      height = bbox.max.y - bbox.min.y,
      center = bbox.getCenter(new THREE.Vector3()),
      parts = [];
    model.traverse((o) => {
      if (o.isMesh) {
        const geo = o.geometry.clone();
        geo.applyMatrix4(o.matrixWorld);
        geo.translate(-center.x, -bbox.min.y, -center.z);
        if (/leaves/i.test(o.material.name)) {
          // Foliage cards must write depth for instancing, shadows and GTAO.
          o.material.transparent = false;
          o.material.alphaTest = 0.45;
          o.material.depthWrite = true;
          o.material.side = THREE.DoubleSide;
        }
        o.material.envMapIntensity = 0.4;
        parts.push({ geometry: geo, material: o.material });
      }
    });
    const buckets = new Map();
    for (let i = 0; i < this.city.trees.length; i++) {
      const tree = this.city.trees[i],
        p = this.route.project(tree.lat, tree.lon),
        near = this.route.nearest(p);
      if (
        near.distance < 5 ||
        near.distance > 270 ||
        this.route.isBridge(near.s)
      )
        continue;
      const key = `${Math.floor(p.x / 60)}:${Math.floor(p.z / 60)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({
        x: p.x,
        y: this.route.height(near.s) - 0.08,
        z: p.z,
        scale: (Number.parseFloat(tree.height) || 7.5) / height,
        angle: rand(i + 71) * Math.PI * 2,
      });
    }
    const matrix = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      position = new THREE.Vector3(),
      scale = new THREE.Vector3();
    const flat = new THREE.PlaneGeometry(height * 1.04, height * 1.04);
    flat.translate(0, height / 2, 0);
    const crossed = flat.clone().rotateY(Math.PI / 2);
    const impostorGeo = mergeGeometries([flat, crossed], false);
    flat.dispose();
    crossed.dispose();
    const impostorMat = new THREE.MeshStandardMaterial({
      map: this.treeImpostor,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 1,
      envMapIntensity: 0.15,
    });
    for (const [key, items] of buckets) {
      const [ix, iz] = key.split(":").map(Number),
        group = new THREE.Group();
      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(
          part.geometry,
          part.material,
          items.length,
        );
        items.forEach((p, i) => {
          position.set(p.x, p.y, p.z);
          scale.setScalar(p.scale);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.angle);
          matrix.compose(position, q, scale);
          mesh.setMatrixAt(i, matrix);
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
      this.addChunk(group, (ix + 0.5) * 60, (iz + 0.5) * 60, 43);
      this.chunks.at(-1).detail = "tree-near";
      const distant = new THREE.InstancedMesh(
        impostorGeo,
        impostorMat,
        items.length,
      );
      items.forEach((p, i) => {
        position.set(p.x, p.y, p.z);
        scale.setScalar(p.scale);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.angle);
        matrix.compose(position, q, scale);
        distant.setMatrixAt(i, matrix);
      });
      distant.receiveShadow = true;
      distant.computeBoundingSphere();
      const farGroup = new THREE.Group();
      farGroup.add(distant);
      this.addChunk(farGroup, (ix + 0.5) * 60, (iz + 0.5) * 60, 43);
      this.chunks.at(-1).detail = "tree-impostor";
    }
    this.treeCount = [...buckets.values()].reduce(
      (sum, b) => sum + b.length,
      0,
    );
  }
  createHeadlights() {
    this.headlights = [];
    for (const x of [-0.84, 0.84]) {
      const light = new THREE.SpotLight(0xffefc7, 90, 65, 0.43, 0.4, 2),
        target = new THREE.Object3D();
      light.position.set(x, 1.28, -7.07);
      target.position.set(x, 0.3, -27);
      light.target = target;
      this.tram.add(light, target);
      this.headlights.push(light);
    }
  }
  createPostprocessing() {
    const target = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.aoPass = new GTAOPass(
      this.scene,
      this.camera,
      innerWidth,
      innerHeight,
      {},
      { radius: 0.7, thickness: 0.6, samples: 12, distanceFallOff: 1 },
      { samples: 8, radius: 4 },
    );
    this.aoPass.blendIntensity = 0.7;
    const original = this.aoPass.render.bind(this.aoPass);
    this.aoPass.render = (...args) => {
      const hidden = [];
      this.scene.traverse((o) => {
        if (
          o.isMesh &&
          o.visible &&
          o.material?.transparent &&
          o.material.opacity < 0.3
        ) {
          hidden.push(o);
          o.visible = false;
        }
      });
      try {
        original(...args);
      } finally {
        for (const o of hidden) o.visible = true;
      }
    };
    this.composer.addPass(this.aoPass);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      0.085,
      0.35,
      1.8,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.renderFrame = 0;
  }
  createLandmarks() {
    const configs = [
      ["landmark_mikulas", 50.0879868, 14.4030624, -Math.PI / 2],
      ["landmark_narodni", 50.0808, 14.4137, Math.PI],
    ];
    for (const [name, lat, lon, yaw] of configs) {
      if (!this.assets[name]) continue;
      const p = this.route.project(lat, lon),
        nearest = this.route.nearest(p),
        model = this.assets[name].clone(true);
      model.position.set(p.x, this.route.height(nearest.s), p.z);
      model.rotation.y = yaw;
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          this.cameraObstacles.push(o);
        }
      });
      const g = new THREE.Group();
      g.add(model);
      this.addChunk(g, p.x, p.z, 80);
      g.updateMatrixWorld(true);
    }
    // Bridge piers and the Prague Castle skyline, with geographically placed silhouettes.
    for (let s = 9470; s < 9870; s += 75) {
      if (!this.route.isBridge(s)) continue;
      const p = this.route.at(s, -1.6),
        g = new THREE.Group();
      box(
        g,
        [18, 7, 9],
        [p.x, p.y - 3.3, p.z],
        new THREE.MeshStandardMaterial({ color: 0x9a9a89, roughness: 1 }),
      );
      this.addChunk(g, p.x, p.z, 15);
    }
    const castlePos = this.route.project(50.0909, 14.4005),
      y = 57;
    const g = new THREE.Group();
    g.position.set(castlePos.x, y, castlePos.z);
    const stone = new THREE.MeshStandardMaterial({
      color: 0xb3afa1,
      roughness: 0.92,
    });
    box(g, [80, 20, 25], [0, 10, 0], stone);
    for (const x of [-13, 13]) {
      box(g, [9, 52, 9], [x, 36, 0], stone);
      const spire = new THREE.Mesh(
        new THREE.ConeGeometry(7, 22, 4),
        this.materials.iron,
      );
      spire.rotation.y = Math.PI / 4;
      spire.position.set(x, 72, 0);
      g.add(spire);
    }
    this.addChunk(g, castlePos.x, castlePos.z, 100);
  }
  createWipers() {
    this.wiperGroup = new THREE.Group();
    this.wiperGroup.position.set(0, 1.82, -7.04);
    const mat = new THREE.MeshStandardMaterial({ color: 0x222622 });
    for (const x of [-0.58, 0.6]) {
      const g = new THREE.Group();
      g.position.set(x, 0, 0);
      box(g, [0.012, 0.66, 0.018], [0, 0.33, 0], mat);
      this.wiperGroup.add(g);
    }
    this.tram.add(this.wiperGroup);
  }
  createRain() {
    const n = 1400,
      pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rand(i) - 0.5) * 65;
      pos[i * 3 + 1] = rand(i + 50) * 38;
      pos[i * 3 + 2] = (rand(i + 100) - 0.5) * 65;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xc7d9d7,
        size: 0.05,
        transparent: true,
        opacity: 0.58,
      }),
    );
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }
  setQuality(q) {
    this.quality = q;
    this.renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio,
        q === "high" ? 1.5 : q === "medium" ? 1 : 0.8,
      ),
    );
    this.renderer.shadowMap.enabled = q !== "low";
    this.drawDistance = q === "high" ? 680 : q === "medium" ? 480 : 340;
    this.camera.far = q === "high" ? 2000 : 1200;
    this.camera.updateProjectionMatrix();
    this.lastCull = -100;
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(innerWidth, innerHeight);
      this.aoPass.enabled = q === "high";
      this.aoPass.setSize(
        Math.ceil(innerWidth * 0.65 * this.renderer.getPixelRatio()),
        Math.ceil(innerHeight * 0.65 * this.renderer.getPixelRatio()),
      );
    }
    this.renderer.shadowMap.needsUpdate = true;
  }
  setWeather(w) {
    this.weather = w;
    const evening = w === "evening",
      rain = w === "rain";
    this.scene.fog.color.setHex(
      evening ? 0x9a8e80 : rain ? 0xa1b4b8 : 0xc0d2d5,
    );
    this.scene.fog.density = rain ? 0.002 : 0.00065;
    this.ambient.intensity = evening ? 0.19 : rain ? 0.44 : 0.35;
    this.sun.intensity = evening ? 2.6 : rain ? 0.35 : 3.0;
    this.sun.color.setHex(evening ? 0xffb873 : 0xffedd5);
    this.sunOffset = new THREE.Vector3(-110, evening ? 35 : 105, -160);
    this.sky.material.uniforms.sunPosition.value
      .copy(this.sunOffset)
      .normalize();
    this.sky.material.uniforms.turbidity.value = rain ? 14 : evening ? 5 : 3.2;
    // The sunny panorama is photographic; overcast/sunset use the atmospheric sky.
    this.scene.background = rain || evening ? null : this.clearSky;
    this.sky.visible = rain || evening;
    this.renderer.toneMappingExposure = evening ? 0.92 : rain ? 1.05 : 0.9;
    this.materials.asphalt.roughness = rain ? 0.34 : 0.94;
    this.materials.cobble.roughness = rain ? 0.4 : 0.86;
    this.rain.visible = rain;
    for (const lamp of this.headlights ?? [])
      lamp.intensity = evening ? 380 : rain ? 180 : 80;
    this.renderer.shadowMap.needsUpdate = true;
    this.wipers = rain;
  }
  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer?.setSize(innerWidth, innerHeight);
    this.aoPass?.setSize(
      Math.ceil(innerWidth * 0.65 * this.renderer.getPixelRatio()),
      Math.ceil(innerHeight * 0.65 * this.renderer.getPixelRatio()),
    );
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
  setCamera(mode) {
    this.cameraMode = mode;
    this.cameraInitialized = false;
    this.look = 0;
    this.pitch = 0;
  }
  update(dt, sim, menu = false) {
    this.time += dt;
    const snapshot = sim.getSnapshot?.() ?? sim;
    const route = this.route,
      p = route.at(sim.s - 6.6),
      front = route.at(sim.s),
      aft = route.at(sim.s - 12.5);
    this.tram.rotation.order = "YXZ";
    this.tram.position.set(p.x, p.y + 0.16, p.z);
    this.tram.rotation.y = Math.atan2(-(front.x - aft.x), -(front.z - aft.z));
    this.tram.rotation.x =
      Math.atan(route.grade(sim.s - 6.6)) + (snapshot.chassisPitch ?? 0);
    this.tram.rotation.z = snapshot.chassisRoll ?? 0;
    const rear = route.at(sim.s - 21.75);
    this.rearTram.rotation.order = "YXZ";
    this.rearTram.position.set(rear.x, rear.y + 0.16, rear.z);
    this.rearTram.rotation.y = rear.yaw;
    this.rearTram.rotation.x =
      Math.atan(route.grade(sim.s - 21.75)) + (snapshot.chassisPitch ?? 0);
    const rearRadius = route.curveRadius(sim.s - 21.75);
    const rearRoll = Number.isFinite(rearRadius)
      ? THREE.MathUtils.clamp(
          (-(sim.speed ** 2) / rearRadius) * 0.016,
          -0.075,
          0.075,
        )
      : 0;
    this.rearTram.rotation.z = THREE.MathUtils.lerp(
      this.rearTram.rotation.z,
      rearRoll,
      Math.min(1, dt * 4),
    );
    const dp = sim.doorProgress ?? 0;
    for (const door of [...this.doorMeshes, ...this.rearDoorMeshes])
      door.rotation.y =
        door.userData.openingRotation * door.userData.openingAngle * dp;
    this.urban.update(dt, sim, menu);
    if (this.speedNeedle)
      this.speedNeedle.rotation.y = ((sim.speed * 3.6) / 80) * Math.PI * 1.5;
    for (const stop of this.stopGroups)
      stop.g.visible = Math.abs(stop.s - sim.s) < 750;
    let targetPosition, targetLook;
    if (menu) {
      const pos = route.at(sim.s + 14, -9);
      targetPosition = new THREE.Vector3(pos.x, pos.y + 3.8, pos.z);
      targetLook = new THREE.Vector3(p.x, p.y + 2, p.z);
    } else if (this.cameraMode === 0) {
      targetPosition = new THREE.Vector3(-0.3, 2.06, -5.35)
        .applyQuaternion(this.tram.quaternion)
        .add(this.tram.position);
      const direction = new THREE.Vector3(
        Math.sin(this.look),
        this.pitch + 0.035,
        -Math.cos(this.look),
      ).applyQuaternion(this.tram.quaternion);
      targetLook = targetPosition.clone().add(direction.multiplyScalar(40));
      const shake = snapshot.rideShake ?? 0;
      targetPosition.y += shake;
      targetLook.y += shake * 0.45;
    } else if (this.cameraMode === 1) {
      const q = route.at(sim.s - 35, 3);
      targetPosition = new THREE.Vector3(q.x, q.y + 9, q.z);
      targetLook = new THREE.Vector3(front.x, front.y + 2, front.z);
    } else {
      const q = route.at(sim.s - 14, 30);
      targetPosition = new THREE.Vector3(q.x, q.y + 45, q.z);
      targetLook = new THREE.Vector3(p.x, p.y + 1.5, p.z);
    }
    if (!this.cameraInitialized || menu || this.cameraMode === 0)
      this.camera.position.copy(targetPosition);
    else this.camera.position.lerp(targetPosition, Math.min(1, dt * 5));
    this.camera.lookAt(targetLook);
    this.cameraInitialized = true;
    this.wiperGroup.visible = this.cameraMode === 0 && !menu;
    this.wiperGroup.children.forEach(
      (w, i) =>
        (w.rotation.z = this.wipers
          ? Math.sin(this.time * 3.2 + i * 0.1) * 0.68
          : -0.7),
    );
    if (this.weather === "rain") {
      this.rain.position.copy(this.camera.position);
      const attr = this.rain.geometry.attributes.position;
      for (let i = 0; i < attr.count; i++) {
        attr.array[i * 3 + 1] -= dt * 19;
        if (attr.array[i * 3 + 1] < -8) attr.array[i * 3 + 1] = 32;
      }
      attr.needsUpdate = true;
    }
    if (Math.abs(sim.s - this.lastCull) > 24) {
      this.lastCull = sim.s;
      const d = this.drawDistance ?? 680;
      const nearTreeDistance =
        this.quality === "high" ? 90 : this.quality === "medium" ? 60 : 0;
      const farTreeDistance =
        this.quality === "high" ? 400 : this.quality === "medium" ? 300 : 160;
      for (const c of this.chunks) {
        const distance = Math.hypot(c.x - front.x, c.z - front.z);
        if (c.detail === "tree-near")
          c.group.visible =
            this.quality !== "low" && distance < nearTreeDistance + c.radius;
        else if (c.detail === "tree-impostor")
          c.group.visible =
            (this.quality === "low" ||
              distance >= nearTreeDistance + c.radius) &&
            distance < farTreeDistance + c.radius;
        else
          c.group.visible =
            distance <
            (c.detail === "fine"
              ? this.quality === "high"
                ? 260
                : this.quality === "medium"
                  ? 175
                  : 80
              : d) +
              c.radius;
      }
      this.sun.target.position.set(front.x, front.y, front.z);
      this.sun.position
        .copy(this.sun.target.position)
        .add(this.sunOffset ?? new THREE.Vector3(-120, 190, -150));
      this.sun.target.updateMatrixWorld();
    }
    this.renderFrame++;
    if (this.renderFrame % 4 === 0) this.renderer.shadowMap.needsUpdate = true;
    this.renderer.info.reset();
    if (this.quality === "low") this.renderer.render(this.scene, this.camera);
    else this.composer.render(dt);
  }
  stats() {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      buildings: this.buildingCount,
      models: this.modelStatus,
      quality: this.quality,
      streetLife: this.urban.stats,
      facadeDetails: this.facadeStats,
      roofDetails: this.roofDetailStats,
      trees: this.treeCount,
    };
  }
}
