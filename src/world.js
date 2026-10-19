import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Sky } from "three/addons/objects/Sky.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { UrbanLife } from "./urban-life.js";
import { loadPhysicalMaterials, ROOF_COLORS } from "./materials.js";
import { createBuildingDetails, splitRoofGeometry } from "./facades.js";
import { createRoofDetails } from "./roof-details.js";
import { coniferGeometry, plantWoodland } from "./ipr-trees.js";
import { addStreetFeatures } from "./street-features.js";
import { addMeasuredBridges, measuredBridgeAt } from "./measured-bridges.js";
import {
  measuredRoofGeometries,
  measuredRoofKind,
  measuredWallGeometry,
} from "./measured-buildings.js";
import { passageWallGeometry } from "./passage.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { roofGeometry } from "./roof-geometry.js";
import { createOSMScenery } from "./osm-scenery.js";
import { createSceneryClearance } from "./scenery-spatial.js";
import { createStreetProfiles } from "./street-profile.js";
import { buildingProfile, buildingColor } from "./building-profiles.js";
import { courtyardGroundGeometry } from "./building-ground.js";
import { createPragueSkyline } from "./prague-skyline.js";
import {
  WindshieldRain,
  wiperEndpoints,
  prepareWetSurface,
  createRiverMaterial,
} from "./weather-effects.js";
import { addStreetDetails, deriveRailConditions } from "./street-details.js";
import { createGroundCover } from "./ground-cover.js";
import { createAlignmentSurfaces } from "./alignment-surfaces.js";
import { createMappedLandmarks } from "./mapped-landmarks.js";
import {
  pedestrianBoundsSupported,
  stopHasMappedShelter,
  stopPedestrianPlacement,
} from "./stop-placement.js";
import {
  createMappedSurfaceClipper,
  createGroundMotorPlanPreference,
} from "./surface-gaps.js";
import {
  buildAdaptiveTerrain,
  clipTerrainGeometry,
  lidarSubdivision,
} from "./terrain-geometry.js";
import { constrainCamera } from "./camera-constraints.js";
import { loadBinary } from "./asset-loader.js";
import { applyScenery } from "./prebuilt-scenery.js";
import { WalkingController } from "./walking.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { panoramaSunDirection, streetLightProbe } from "./daylight.js";
import {
  lampStyleAt,
  modernLampGeometry,
  suspendedLampGeometry,
} from "./street-lamps.js";
import { balustradeGeometry } from "./bridge-balustrade.js";
import { solarPosition, sunDirection, directionAzimuth } from "./solar.js";
import { lightingFor, litWindowShare, skyFor } from "./environment.js";
import { pragueNow, pragueToUtc } from "./timetable.js";
import { facadeNight } from "./facades.js";

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
function surface(
  route,
  s0,
  s1,
  width,
  offset = 0,
  lift = 0,
  step = 4,
  visible = null,
  pointAt = null,
  cellVisible = null,
  clipTriangle = null,
  surfacePointAt = null,
  alignmentStations = null,
) {
  const positions = [],
    uv = [],
    indices = [];
  const divisions = Math.ceil((s1 - s0) / step);
  const stations = new Set(
    Array.from(
      { length: divisions + 1 },
      (_, i) => s0 + ((s1 - s0) * i) / divisions,
    ),
  );
  // Rail strips include mapped vertices as well as regular samples, so a
  // recorded curve node cannot be skipped by a long rendered chord.
  if (pointAt && route.trackAlignment) {
    if (alignmentStations) for (const s of alignmentStations) stations.add(s);
    else
      for (const alignment of [
        route.trackAlignment.primary,
        route.trackAlignment.opposing,
      ])
        for (const point of alignment.points)
          if (point.s > s0 && point.s < s1) stations.add(point.s);
  }
  const distances = [...stations].sort((a, b) => a - b),
    n = distances.length - 1;
  const samplePoint =
    pointAt ?? surfacePointAt ?? ((s, lateral) => route.at(s, lateral));
  for (let i = 0; i <= n; i++) {
    const s = distances[i];
    const breadth = typeof width === "function" ? width(s) : width;
    for (let j = 0; j < 2; j++) {
      const lateral = typeof offset === "function" ? offset(s) : offset;
      const p = samplePoint(s, lateral + (j - 0.5) * breadth);
      positions.push(p.x, p.y + lift, p.z);
      uv.push((lateral + (j - 0.5) * breadth) / 4, s / 4);
    }
    if (i < n) {
      const a = i * 2;
      if (
        (!visible ||
          (visible((distances[i] + distances[i + 1]) / 2) &&
            (!pointAt ||
              (visible(distances[i]) && visible(distances[i + 1]))))) &&
        (!cellVisible || cellVisible(distances[i], distances[i + 1]))
      )
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  if (clipTriangle) {
    const clippedPositions = [],
      clippedUV = [];
    for (let i = 0; i < indices.length; i += 3) {
      const triangle = indices.slice(i, i + 3).map((index) => ({
        x: positions[index * 3],
        y: positions[index * 3 + 1],
        z: positions[index * 3 + 2],
        u: uv[index * 2],
        v: uv[index * 2 + 1],
      }));
      for (const piece of clipTriangle(triangle)) {
        const [a, b, c] = piece,
          cross =
            (Math.fround(b.x) - Math.fround(a.x)) *
              (Math.fround(c.z) - Math.fround(a.z)) -
            (Math.fround(b.z) - Math.fround(a.z)) *
              (Math.fround(c.x) - Math.fround(a.x));
        if (Math.abs(cross) < 1e-9) continue;
        const upward = cross > 0 ? [a, c, b] : piece;
        for (const p of upward) {
          clippedPositions.push(p.x, p.y, p.z);
          clippedUV.push(p.u, p.v);
        }
      }
    }
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(clippedPositions, 3),
    );
    g.setAttribute("uv", new THREE.Float32BufferAttribute(clippedUV, 2));
    g.setIndex(
      Array.from({ length: clippedPositions.length / 3 }, (_, i) => i),
    );
  } else {
    const upward = [];
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = indices.slice(i, i + 3),
        ax = Math.fround(positions[a * 3]),
        az = Math.fround(positions[a * 3 + 2]),
        bx = Math.fround(positions[b * 3]),
        bz = Math.fround(positions[b * 3 + 2]),
        cx = Math.fround(positions[c * 3]),
        cz = Math.fround(positions[c * 3 + 2]),
        cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (Math.abs(cross) <= 1e-9) continue;
      upward.push(a, cross > 0 ? c : b, cross > 0 ? b : c);
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(upward);
  }
  g.computeVertexNormals();
  return g;
}
export { surface as alignmentSurfaceGeometry };
export { footprintGeometry as buildingWallGeometry };
function footprintGeometry(points, height, base, groundAt = null) {
  const pos = [],
    uv = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i],
      end = points[i + 1],
      length = Math.hypot(start.x - end.x, start.z - end.z),
      divisions = groundAt ? Math.max(1, Math.ceil(length / 3)) : 1;
    for (let segment = 0; segment < divisions; segment++) {
      const point = (t) => ({
          x: start.x + (end.x - start.x) * t,
          z: start.z + (end.z - start.z) * t,
        }),
        a = point(segment / divisions),
        b = point((segment + 1) / divisions),
        l = length / divisions,
        bottomA = groundAt ? Math.min(base, groundAt(a) - 0.3) : base,
        bottomB = groundAt ? Math.min(base, groundAt(b) - 0.3) : base;
      const vs = [
        [a.x, bottomA, a.z],
        [b.x, bottomB, b.z],
        [b.x, base + height, b.z],
        [a.x, bottomA, a.z],
        [b.x, base + height, b.z],
        [a.x, base + height, a.z],
      ];
      vs.forEach((v) => pos.push(...v));
      uv.push(
        (segment * l) / 4,
        (bottomA - base) / 4,
        ((segment + 1) * l) / 4,
        (bottomB - base) / 4,
        ((segment + 1) * l) / 4,
        height / 4,
        (segment * l) / 4,
        (bottomA - base) / 4,
        ((segment + 1) * l) / 4,
        height / 4,
        (segment * l) / 4,
        height / 4,
      );
    }
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
  const uv = g.getAttribute("uv");
  for (let i = 0; i < uv.count; i++)
    uv.setXY(i, uv.getX(i) / 4, uv.getY(i) / 4);
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
const TREE_CELL = 45;
function line3(points, material) {
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
    ),
    material,
  );
}

export class World {
  constructor(canvas, route, city, onProgress, quality = "medium") {
    this.route = route;
    this.city = city;
    this.mappedLandmarkIds = new Set(
      (city.landmarkParts?.landmarks ?? []).flatMap(
        (landmark) => landmark.outlineIds,
      ),
    );
    this.sceneryClearance = createSceneryClearance(route, city);
    this.mappedStreetProfile = createStreetProfiles(
      route,
      this.sceneryClearance,
    );
    this.alignmentSurface = createAlignmentSurfaces(
      route,
      this.sceneryClearance,
    );
    this.crossingData = { crossings: city.crossings ?? [] };
    this.progress = onProgress;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // The composer owns MSAA. Keep the canvas context identical when a
      // session switches between quality presets (context AA cannot change).
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio,
        quality === "high" ? 1.5 : quality === "medium" ? 1 : 0.8,
      ),
    );
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral keeps plaster, clay and sky hues as photographed;
    // AgX desaturated the city towards beige.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.8;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.info.autoReset = false;
    this.scene = new THREE.Scene();
    // The scene's identity transform never changes. Static geometry can keep
    // its baked matrices while moving tram/actor roots still update normally.
    this.scene.matrixAutoUpdate = false;
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
    this.weatherUniforms = { wetness: { value: 0 }, time: { value: 0 } };
    this.railConditions = deriveRailConditions(route, city);
    this.time = 0;
    this.renderFrame = 0;
    this.lastCull = -100;
    this.wipers = false;
    this.assets = {};
    this.quality = quality;
    this.collidedAt = -100;
    this.cameraInitialized = false;
    this.walker = new WalkingController(this);
    this.skies = new Map();
    this.nightFactor = 0;
    this.lampFactor = 0;
    const now = pragueNow();
    this.clockState = { ymd: now.ymd, seconds: now.seconds };
    this.solar = this.solarAt(now.ymd, now.seconds);
    // Atmospheric fallback when a photographed sky cannot be loaded.
    this.sky = new Sky();
    this.sky.scale.setScalar(450000);
    this.sky.visible = false;
    this.scene.add(this.sky);
    this.sky.material.uniforms.turbidity.value = 3.2;
    this.sky.material.uniforms.rayleigh.value = 1.6;
    this.sky.material.uniforms.mieCoefficient.value = 0.003;
    this.sky.material.uniforms.mieDirectionalG.value = 0.8;
    this.ambient = new THREE.HemisphereLight(0xd6ebf4, 0x62594a, 0.35);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffedd5, 3.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(
      quality === "high" ? 4096 : 2048,
      quality === "high" ? 4096 : 2048,
    );
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
      ballast: new THREE.MeshStandardMaterial({
        color: 0x8c8880,
        roughness: 1,
      }),
      sidewalk: new THREE.MeshStandardMaterial({
        color: 0xb7b4a2,
        roughness: 0.95,
      }),
      cobble: new THREE.MeshStandardMaterial({
        roughness: 0.86,
        bumpScale: 0.06,
      }),
      asphalt: new THREE.MeshStandardMaterial({
        roughness: 0.94,
        bumpScale: 0.03,
      }),
      sidewalkAsphalt: new THREE.MeshStandardMaterial({
        roughness: 0.95,
        bumpScale: 0.02,
      }),
      // Worn white road paint, drawn over the surveyed carriageway.
      roadMarking: new THREE.MeshStandardMaterial({
        color: 0xd8d6cc,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
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
    const timings = (this.startupTimings = {});
    const measure = (name, build) => {
      const started = performance.now();
      const result = build();
      timings[name] = Math.round(performance.now() - started);
      return result;
    };
    const materialStarted = performance.now();
    const modelsReady = this.loadModels();
    this.progress("Načítání fotogrammetrických materiálů a HDR světla");
    await loadPhysicalMaterials(this);
    timings.materials = Math.round(performance.now() - materialStarted);
    for (const material of [
      this.materials.asphalt,
      this.materials.cobble,
      this.materials.sidewalk,
      this.materials.praguePaving,
    ])
      prepareWetSurface(material, this.weatherUniforms);
    this.waterMaterial = createRiverMaterial(this.weatherUniforms);
    this.progress("Pokládání kolejí a trolejového vedení");
    await new Promise((r) => setTimeout(r, 20));
    measure("track", () => this.createTrack());
    this.progress("Stavba pražských ulic");
    await new Promise((r) => setTimeout(r, 20));
    const sceneryWaitStarted = performance.now();
    this.prebuiltScenery = await this.prebuiltSceneryReady;
    timings.sceneryWait = Math.round(performance.now() - sceneryWaitStarted);
    measure("city", () => this.createCity());
    measure("streetDetails", () => addStreetDetails(this));
    this.streetFeatureStats = measure("streetFeatures", () =>
      addStreetFeatures(this),
    );
    this.progress("Načítání modelů z Blenderu");
    const modelWaitStarted = performance.now();
    await modelsReady;
    timings.modelWait = Math.round(performance.now() - modelWaitStarted);
    this.tram = this.assets.tram?.clone(true) ?? this.fallbackTram();
    this.doorMeshes = this.prepareTram(this.tram);
    this.scene.add(this.tram);
    this.rearTram = this.assets.tram?.clone(true) ?? this.fallbackTram();
    this.rearDoorMeshes = this.prepareTram(this.rearTram, false);
    this.scene.add(this.rearTram);
    this.createStops();
    this.createStreetLamps();
    this.urban = measure("traffic", () => new UrbanLife(this));
    this.signalConfigs = this.urban.signalConfigs;
    measure("trees", () => this.createPhotographicTrees());
    measure("landmarks", () => this.createLandmarks());
    this.createWipers();
    this.windshieldRain = new WindshieldRain(this.tram);
    this.createRain();
    this.createHeadlights();
    this.scene.updateMatrixWorld(true);
    for (const { group } of this.chunks)
      group.traverse((object) => {
        object.matrixAutoUpdate = false;
      });
    for (const { g } of this.stopGroups)
      g.traverse((object) => {
        object.matrixAutoUpdate = false;
      });
    this.setQuality(this.quality);
    this.speedNeedle = this.tram.getObjectByName("speed_needle");
    this.setWeather("clear");
    this.update(
      0,
      { s: this.route.stops[15].s, doorProgress: 0, time: 0, speed: 0 },
      true,
    );
    return this;
  }
  async loadModels() {
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
          const bytes = await loadBinary(
            `${import.meta.env.BASE_URL}models/${name}.glb`,
          );
          const gltf = await loader.parseAsync(
            bytes,
            `${import.meta.env.BASE_URL}models/`,
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
    this.streetSurfaceGeometries = [];
    const clipMapped = createMappedSurfaceClipper(
      this.sceneryClearance.streetSurfaces,
      {
        baselineAltitude: this.route.data?.baselineAltitude ?? 190,
        preferPolygonPlan: createGroundMotorPlanPreference(this.route, (p) =>
          this.route.nearest(p),
        ),
      },
    );
    const clipSurface = (triangle) => {
      const center = {
          x: (triangle[0].x + triangle[1].x + triangle[2].x) / 3,
          z: (triangle[0].z + triangle[1].z + triangle[2].z) / 3,
        },
        station = this.route.nearest(center).s,
        level = this.route.streetLevel?.(station) ?? 0;
      return clipMapped(triangle, level).flatMap((piece) =>
        level === 0 && this.sceneryClearance.clipBuildingTriangle
          ? this.sceneryClearance.clipBuildingTriangle(...piece)
          : [piece],
      );
    };
    const runningStreetPoint = (s, lateral) => {
      if (!this.route.trackHeightProfiles || !this.route.inferredRoadHeight)
        return this.route.trackAt(s, 1, lateral);
      const point = this.route.at(s, lateral, false),
        near = this.route.nearest(point),
        level = this.route.streetLevel(s, 1);
      // The complete estimated ribbon follows the same continuous road field
      // as reconstructed native paving, including the real opposing track.
      // Sampling the old lateral field at its outer corners could lift a
      // coarse triangle over steel even with correct railhead profiles.
      return {
        ...point,
        y: this.route.inferredRoadHeight(point, near, level, true),
      };
    };
    // All eight steel/groove strips share these mapped curve stations. Walk
    // the sorted list once instead of rescanning both complete axes per strip.
    const alignmentStations = this.route.trackAlignment
      ? [
          ...new Set(
            [
              this.route.trackAlignment.primary,
              this.route.trackAlignment.opposing,
            ].flatMap((alignment) => alignment.points.map((point) => point.s)),
          ),
        ].sort((a, b) => a - b)
      : [];
    let alignmentStationIndex = 0;
    const wireMat = new THREE.LineBasicMaterial({ color: 0x494a40 });
    const allPoles = [],
      crossWires = [];
    // Surveyed DTM poles beside the line carry the span wires where they
    // exist; synthetic masts only fill longer gaps between them.
    const surveyedPoles = [];
    for (const feature of [
      ...(this.city?.streetFeatures?.points ?? []),
      // OSM catenary masts complement the partial DTM pole survey.
      ...(this.city?.streetLights?.catenaryMasts ?? []).map((mast) => ({
        ...mast,
        kind: "pole",
        level: 0,
      })),
    ]) {
      if (feature.kind !== "pole" || (feature.level ?? 0) !== 0) continue;
      const p = this.route.project(feature.lat, feature.lon),
        near = this.route.nearest(p);
      if (near.distance > 16 || this.route.isBridge(near.s)) continue;
      const tangent = this.route.at(near.s),
        offset = (p.x - near.x) * -tangent.dz + (p.z - near.z) * tangent.dx;
      if (Math.abs(offset) < 1.9) continue;
      if (
        surveyedPoles.some(
          (pole) => Math.hypot(pole.x - p.x, pole.z - p.z) < 1.5,
        )
      )
        continue;
      surveyedPoles.push({ ...p, s: near.s, side: Math.sign(offset), offset });
    }
    surveyedPoles.sort((a, b) => a.s - b.s);
    this.surveyedCatenaryPoles = surveyedPoles;
    for (let s0 = 0; s0 < this.route.length; s0 += 180) {
      const s1 = Math.min(this.route.length, s0 + 180),
        group = new THREE.Group(),
        historic = this.route.isHistoric((s0 + s1) / 2),
        bridge = this.route.isBridge((s0 + s1) / 2),
        sidewalkMaterial = historic
          ? this.materials.praguePaving
          : this.materials.sidewalk,
        w = (s) => this.streetProfile(s).width,
        center = (s) => this.streetProfile(s).center;
      while (alignmentStations[alignmentStationIndex] <= s0)
        alignmentStationIndex++;
      const alignmentStationStart = alignmentStationIndex;
      while (alignmentStations[alignmentStationIndex] < s1)
        alignmentStationIndex++;
      const chunkAlignmentStations = alignmentStations.slice(
        alignmentStationStart,
        alignmentStationIndex,
      );
      // The four paving materials sample the same five ribbons. Cache exact
      // coordinates only within this chunk; material changes retain identical
      // vertices without reconstructing the road-height field four times.
      const runningStreetPoints = new Map();
      const cachedRunningStreetPoint = (s, lateral) => {
        let section = runningStreetPoints.get(s);
        if (!section) runningStreetPoints.set(s, (section = new Map()));
        let point = section.get(lateral);
        if (!point) {
          point = runningStreetPoint(s, lateral);
          section.set(lateral, point);
        }
        return point;
      };
      const make = (geo, mat) => {
        const m = new THREE.Mesh(geo, mat);
        m.receiveShadow = true;
        group.add(m);
        return m;
      };
      // The mapped carriageways are rendered independently in OSM scenery.
      // This surface is only the embedded tram street or reserved track bed;
      // a blanket paved ribbon used to erase medians and separate roads.
      for (const kind of ["cobble", "asphalt", "grass", "ballast"]) {
        const strips = [];
        for (let band = 0; band < 5; band++) {
          const lateral = (s) => center(s) + ((band + 0.5) / 5 - 0.5) * w(s);
          const geometry = surface(
            this.route,
            s0,
            s1,
            (s) => w(s) / 5,
            lateral,
            0.12,
            2,
            (s) => this.alignmentSurface(s, lateral(s)).kind === kind,
            null,
            null,
            clipSurface,
            cachedRunningStreetPoint,
          );
          if (geometry.index.count) strips.push(geometry);
          else geometry.dispose();
        }
        if (strips.length) {
          const mesh = make(
            mergeGeometries(strips, false),
            this.materials[kind] ?? this.materials.cobble,
          );
          this.streetSurfaceGeometries.push(mesh.geometry);
          strips.forEach((geometry) => geometry.dispose());
        }
      }
      for (const side of [-1, 1]) {
        const sidewalkWidth = (s) =>
          side > 0
            ? (this.streetProfile(s).sidewalkRightWidth ?? 1.8)
            : (this.streetProfile(s).sidewalkLeftWidth ?? 1.8);
        const sidewalk = (s) =>
          side > 0
            ? this.streetProfile(s).sidewalkRight
            : this.streetProfile(s).sidewalkLeft;
        const uninterrupted = (s) => {
          const profile = this.streetProfile(s);
          if (
            side > 0 ? profile.sidewalkRightMapped : profile.sidewalkLeftMapped
          )
            return false;
          if (sidewalkWidth(s) < 0.1) return false;
          if (this.route.isBridge(s)) return true;
          if (s > 8316 && s < 8372) return false;
          const p = this.route.at(s, sidewalk(s)),
            tangent = this.route.at(s);
          return !this.sceneryClearance
            .roadSurfacesAt(p, 0.3)
            .some(
              (hit) =>
                !/pedestrian|living_street/.test(hit.road.highway ?? "") &&
                Math.abs(hit.dx * tangent.dx + hit.dz * tangent.dz) < 0.85,
            );
        };
        const mesh = make(
          surface(
            this.route,
            s0,
            s1,
            sidewalkWidth,
            sidewalk,
            0.27,
            2,
            uninterrupted,
            null,
            null,
            clipSurface,
          ),
          sidewalkMaterial,
        );
        this.streetSurfaceGeometries.push(mesh.geometry);
      }
      for (const direction of [1, -1])
        for (const side of [-0.7485, 0.7485]) {
          const visible =
            direction > 0 || !this.route.trackAlignment
              ? null
              : (s) => !!this.route.trackInfo(s, -1);
          const pointAt = (s, lateral) =>
            this.route.trackAt(s, direction, lateral);
          const groove = make(
            surface(
              this.route,
              s0,
              s1,
              0.18,
              side,
              0.137,
              1,
              visible,
              pointAt,
              null,
              null,
              null,
              chunkAlignmentStations,
            ),
            this.materials.groove,
          );
          const rail = make(
            surface(
              this.route,
              s0,
              s1,
              0.062,
              side,
              0.154,
              1,
              visible,
              pointAt,
              null,
              null,
              null,
              chunkAlignmentStations,
            ),
            this.materials.rail,
          );
          rail.geometry.userData.railHead = true;
          this.streetSurfaceGeometries.push(groove.geometry, rail.geometry);
        }
      for (const direction of [1, -1]) {
        let pts = [];
        const finish = () => {
          if (pts.length > 1) group.add(line3(pts, wireMat));
          pts = [];
        };
        for (let s = s0; s <= s1; s += 6) {
          if (
            direction < 0 &&
            this.route.trackAlignment &&
            !this.route.trackInfo(s, -1)
          ) {
            finish();
            continue;
          }
          const p = this.route.trackAt(s, direction);
          p.y += 5.5;
          pts.push(p);
        }
        finish();
      }
      const chunkPoles = surveyedPoles.filter((p) => p.s >= s0 && p.s < s1);
      const paired = new Set();
      for (const pole of chunkPoles) {
        const ground =
          this.route.groundHeight?.(pole) ?? this.route.height(pole.s);
        const mast = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.16, 8.6, 8),
          this.materials.iron,
        );
        mast.position.set(pole.x, ground + 4.1, pole.z);
        group.add(mast);
        if (paired.has(pole)) continue;
        const across = chunkPoles.find(
          (other) =>
            other !== pole &&
            !paired.has(other) &&
            other.side !== pole.side &&
            Math.abs(other.s - pole.s) < 8,
        );
        const a = { x: pole.x, y: ground + 6.05, z: pole.z };
        let b;
        if (across) {
          paired.add(across);
          b = {
            x: across.x,
            y: (this.route.groundHeight?.(across) ?? ground) + 6.05,
            z: across.z,
          };
        } else {
          const profile = this.streetProfile(pole.s),
            far = this.route.at(
              pole.s,
              pole.side > 0 ? profile.sidewalkLeft : profile.sidewalkRight,
            );
          b = { ...far, y: far.y + 6.05 };
        }
        paired.add(pole);
        allPoles.push(pole);
        crossWires.push(a, b);
        group.add(line3([a, b], wireMat));
      }
      for (let s = s0 + 10; s < s1; s += 32) {
        if (surveyedPoles.some((pole) => Math.abs(pole.s - s) < 20)) continue;
        const profile = this.streetProfile(s),
          p = this.route.at(s, bridge ? 6.5 : profile.sidewalkRight),
          p2 = this.route.at(s, bridge ? -9.8 : profile.sidewalkLeft);
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
        // Tight historic streets suspend the wire from facade anchors rather
        // than planting the same roadside mast through every narrow frontage.
        if (
          !(historic && profile.width < 12) &&
          !this.sceneryClearance.buildingAt(p, 0.15)
        )
          group.add(cant);
        group.add(line3([a, b], wireMat));
      }
      const balustrades = this.route.isBridge((s0 + s1) / 2)
        ? this.bridgeBalustrades(s0, s1)
        : [];
      for (const geometry of balustrades) {
        const mesh = new THREE.Mesh(geometry, this.sandstoneMaterial());
        mesh.castShadow = mesh.receiveShadow = true;
        group.add(mesh);
      }
      if (this.route.isBridge((s0 + s1) / 2) && !balustrades.length) {
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
    const groups = new Map(),
      route = this.route,
      clipCourtyard = createMappedSurfaceClipper(
        this.sceneryClearance?.streetSurfaces,
        {
          baselineAltitude: this.route.data?.baselineAltitude ?? 190,
          maximumHeightDifference: Infinity,
        },
      );
    const add = (key, geo, mat, x, z, tint = null) => {
      if (mat.vertexColors) {
        const color = tint?.isColor ? tint : new THREE.Color(tint ?? 0xffffff);
        const count = geo.getAttribute("position").count;
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count * 3; i += 3) {
          colors[i] = color.r;
          colors[i + 1] = color.g;
          colors[i + 2] = color.b;
        }
        geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      }
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
    const buildings = [
      ...(this.city?.buildings ?? []),
      ...(this.city?.context?.buildings ?? []),
    ];
    // Colour is stored on the building's vertices, so differently painted
    // neighbours share one photographic wall material and one draw per cell.
    const wallMat = this.materials.facades[0].clone();
    // Vertex colours are the plaster's real average; the photograph only
    // adds grain. Lime plaster reflects somewhat less than its paint chip.
    wallMat.color
      .copy(this.albedoNormals?.plaster ?? new THREE.Color(1, 1, 1))
      .multiplyScalar(this.albedoNormals ? 0.86 : 1);
    wallMat.vertexColors = true;
    const roofMaterials = new Map();
    const roofNormal = (kind) =>
      kind === "roofRed"
        ? this.albedoNormals?.["roof-red"]
        : kind === "roof" || kind === "roofSlate"
          ? this.albedoNormals?.roof
          : null;
    const roofMaterial = (kind, value, finish = null) => {
      const color = buildingColor(value, null);
      const normal = roofNormal(kind);
      if (!roofMaterials.has(kind)) {
        const mat = this.materials[kind].clone();
        if (normal) mat.color.copy(normal);
        else mat.color.setHex(0xffffff);
        mat.vertexColors = true;
        roofMaterials.set(kind, mat);
      }
      // With a normalised photograph the vertex colour is the covering's
      // actual average: the mapped colour, the district finish or the
      // covering's usual tone.
      const base = normal
        ? new THREE.Color(ROOF_COLORS[kind])
        : this.materials[kind].color.clone();
      const tint =
        color !== null
          ? normal
            ? new THREE.Color(color)
            : new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45)
          : finish !== null
            ? normal
              ? base.multiply(new THREE.Color(finish))
              : new THREE.Color(finish)
            : base;
      return { key: kind, mat: roofMaterials.get(kind), tint };
    };
    this.buildingCount = this.city?.buildings?.length ?? 0;
    this.measuredBuildingCount = 0;
    this.contextBuildingCount = this.city?.context?.buildings?.length ?? 0;
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
      if (near.distance > 850) continue;
      const profile = buildingProfile(b, route, near, mid),
        h = profile.wallHeight,
        base = profile.base,
        wallKey = "wall",
        holes = (b.holes ?? []).map((hole) =>
          hole.map((p) => route.project(...p)),
        );
      const isLandmark = /Mikuláš|Národní divadlo/.test(b.name ?? "");
      if (isLandmark || this.mappedLandmarkIds.has(b.osmId)) continue;
      const measured = b.measured,
        groundAt = (p) => route.groundHeight(p);
      if (measured) this.measuredBuildingCount++;
      add(
        wallKey,
        b.osmId === "relation/4681559"
          ? passageWallGeometry(ps, h, base, route)
          : measured
            ? measuredWallGeometry(ps, h, base, groundAt, measured, 0)
            : footprintGeometry(ps, h, base, groundAt),
        wallMat,
        mid.x,
        mid.z,
        profile.wallColor,
      );
      // Keep the mapped courtyards open, with real inner walls and a floor.
      for (const [holeIndex, hole] of holes.entries()) {
        if (hole[0].x !== hole.at(-1).x || hole[0].z !== hole.at(-1).z)
          hole.push({ ...hole[0] });
        add(
          wallKey,
          measured
            ? measuredWallGeometry(
                hole,
                h,
                base,
                groundAt,
                measured,
                holeIndex + 1,
              )
            : footprintGeometry(hole, h, base, groundAt),
          wallMat,
          mid.x,
          mid.z,
          profile.wallColor,
        );
        const courtyardCenter = {
            x: hole.reduce((sum, p) => sum + p.x, 0) / hole.length,
            z: hole.reduce((sum, p) => sum + p.z, 0) / hole.length,
          },
          courtyardNear = route.nearest(courtyardCenter),
          courtyardDatum = route.groundHeight(
            courtyardCenter,
            courtyardNear,
            0,
          ),
          terrainDatum = route.terrain.height(
            courtyardCenter,
            route,
            courtyardNear,
          );
        // A courtyard has one ground deck. Switching the nearest tram branch
        // independently at each vertex could put a metre-high step inside it.
        // Native paving is rendered separately and clipped out below.
        const courtyardHeight = (p) =>
          route.terrain.height(p, route, {
            ...courtyardNear,
            distance: Math.hypot(p.x - courtyardNear.x, p.z - courtyardNear.z),
          }) +
          courtyardDatum -
          terrainDatum;
        add(
          profile.historic ? "historicCourtyard" : "courtyard",
          courtyardGroundGeometry(hole, courtyardHeight, 0.13, (triangle) =>
            clipCourtyard(triangle, 0),
          ),
          profile.historic
            ? this.materials.praguePaving
            : this.materials.sidewalk,
          mid.x,
          mid.z,
        );
      }
      const pitched = profile.pitched || Boolean(measured);
      const roofKind = !pitched
        ? "flatRoof"
        : /grey|gray|black|silver|copper/.test(b.roofColor ?? "")
          ? "roofSlate"
          : /brown|dark/.test(b.roofColor ?? "")
            ? "roof"
            : b.roofColor
              ? "roofRed"
              : (profile.roofKind ?? "roofRed");
      // Untagged roofs take the district's usual covering and weathering.
      const roof = roofMaterial(
          roofKind,
          b.roofColor,
          !b.roofColor && pitched && profile.roofKind === roofKind
            ? profile.roofTint
            : null,
        ),
        roofMat = roof.mat;
      if (measured) {
        // IPR Praha photogrammetric roof with its chimneys, dormers, towers
        // and the walls that rise from it.
        const parts = measuredRoofGeometries(measured);
        // The orthophoto's measured roof colour chooses the covering and
        // tints it; without it the mapped or district covering remains.
        const sloped = measured.roofColor
          ? roofMaterial(
              measuredRoofKind(measured.roofColor),
              measured.roofColor,
            )
          : roof;
        if (parts.roof)
          add(sloped.key, parts.roof, sloped.mat, mid.x, mid.z, sloped.tint);
        if (parts.flat) {
          const flat = roofMaterial(
            "flatRoof",
            measured.roofColor ?? b.roofColor,
          );
          add(flat.key, parts.flat, flat.mat, mid.x, mid.z, flat.tint);
        }
        if (parts.wall)
          add(wallKey, parts.wall, wallMat, mid.x, mid.z, profile.wallColor);
        continue;
      }
      const top = pitched
        ? roofGeometry(ps, base + h, profile.totalHeight, {
            ...profile.roofOptions,
            holes,
          })
        : polygonTop(ps, base + h, holes);
      const split = splitRoofGeometry(top);
      add(roof.key, split.roof, roofMat, mid.x, mid.z, roof.tint);
      if (split.gables?.getAttribute("position").count)
        add(wallKey, split.gables, wallMat, mid.x, mid.z, profile.wallColor);
      top.dispose();
    }
    this.cityBatchCount = groups.size;
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
        this.chunks.at(-1).detail = "city";
      }
    }
    this.usedPrebuiltScenery = false;
    if (this.prebuiltScenery) {
      try {
        applyScenery(this, this.prebuiltScenery);
        this.usedPrebuiltScenery = true;
      } catch (error) {
        console.warn("Obnova předpočítaných ulic:", error.message);
      }
      this.prebuiltScenery = null;
    }
    if (!this.usedPrebuiltScenery) createOSMScenery(this);
    this.streetSurfaceGeometries ??= [];
    for (const chunk of this.chunks)
      if (chunk.group.name.startsWith("OSM streets and greenery"))
        for (const mesh of chunk.group.children)
          if (mesh.isMesh) this.streetSurfaceGeometries.push(mesh.geometry);
    // Courtyard batches are also paving, and must cover the terrain.
    for (const chunk of this.chunks)
      if (chunk.detail === "city")
        for (const mesh of chunk.group.children)
          if (
            mesh.material === this.materials.praguePaving ||
            mesh.material === this.materials.sidewalk
          )
            this.streetSurfaceGeometries.push(mesh.geometry);
    this.createTerrain();
    createBuildingDetails(this);
    createRoofDetails(this);
    for (const w of this.city?.waters ?? []) {
      const ps = w.points.map((p) => route.project(p[0], p[1]));
      if (ps.length < 3) continue;
      const holes = (w.holes ?? []).map((h) =>
        h.map((p) => route.project(...p)),
      );
      const near = route.nearest(ps[0]),
        wy =
          w.name === "Vltava"
            ? this.riverLevel()
            : (this.pondLevel(ps) ?? route.height(near.s) - 1.5);
      const mesh = new THREE.Mesh(
        polygonTop(ps, wy, holes),
        this.waterMaterial,
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
      const mesh = new THREE.Mesh(polygonTop(ps, -0.05), this.waterMaterial);
      this.scene.add(mesh);
    }
  }
  /**
   * Vltava surface where the line crosses it. The bare-earth lidar records
   * the water between the weirs; without it the former 189.9 m remains.
   */
  riverLevel() {
    if (this.riverLevelCache !== undefined) return this.riverLevelCache;
    const route = this.route,
      lidar = route.terrain?.lidar,
      river = (this.city?.waters ?? []).find((w) => w.name === "Vltava");
    let level = -0.1;
    if (lidar && river) {
      const outline = river.points.map((p) => route.project(...p)),
        holes = (river.holes ?? []).map((h) =>
          h.map((p) => route.project(...p)),
        ),
        within = (p, poly) => {
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
        },
        wet = (p) =>
          within(p, outline) && !holes.some((hole) => within(p, hole));
      const crossing = [];
      for (let s = 0; s < route.length; s += 10) {
        const p = route.at(s, 0);
        if (wet(p)) crossing.push(p);
      }
      const samples = [];
      for (const centre of crossing)
        for (let dx = -150; dx <= 150; dx += 15)
          for (let dz = -150; dz <= 150; dz += 15) {
            const p = { x: centre.x + dx, z: centre.z + dz };
            if (!wet(p)) continue;
            const altitude = lidar.altitude(p.x, p.z);
            if (altitude !== null) samples.push(altitude);
          }
      if (samples.length >= 20) {
        samples.sort((a, b) => a - b);
        level = samples[samples.length >> 1] - route.terrain.baseline;
      }
    }
    return (this.riverLevelCache = level);
  }
  /** Lidar interpolates still water from its measured shoreline. */
  pondLevel(outline) {
    const lidar = this.route.terrain?.lidar;
    if (!lidar) return null;
    const heights = outline
      .map((p) => lidar.altitude(p.x, p.z))
      .filter((value) => value !== null)
      .sort((a, b) => a - b);
    return heights.length >= 3
      ? heights[Math.floor(heights.length * 0.25)] -
          this.route.terrain.baseline -
          0.25
      : null;
  }
  createTerrain() {
    const route = this.route,
      step = 40,
      minX = Math.min(...route.points.map((p) => p.x)) - 700,
      maxX = Math.max(...route.points.map((p) => p.x)) + 700,
      minZ = Math.min(...route.points.map((p) => p.z)) - 700,
      maxZ = Math.max(...route.points.map((p) => p.z)) + 700,
      nx = Math.ceil((maxX - minX) / step),
      nz = Math.ceil((maxZ - minZ) / step);
    const coverAt = createGroundCover(route, this.city);
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
    const riverbed = this.riverLevel() - 1.2;
    const heightAt = (x, z) => {
      let y = route.groundHeight({ x, z }, route.nearest({ x, z })) - 0.22;
      for (const w of water)
        if (
          inside({ x, z }, w.points) &&
          !w.holes.some((h) => inside({ x, z }, h))
        )
          y = riverbed;
      return y;
    };
    // Bare-earth lidar refines cells whose embankments, gardens and slopes
    // a 40 m plane would flatten; distant flat ground stays coarse.
    const lidar = route.terrain.lidar,
      refine = lidar
        ? lidarSubdivision(
            (x, z) => lidar.altitude(x, z),
            (x, z) => route.nearest({ x, z }).distance,
            step,
            (x, z) => Boolean(this.sceneryClearance?.buildingAt?.({ x, z })),
            (x, z) => Boolean(route.streetHeightPlans?.at({ x, z })),
          )
        : null;
    const latticeStart = performance.now();
    const geo = buildAdaptiveTerrain({
      minX,
      minZ,
      nx,
      nz,
      step,
      subdivision: refine
        ? (ci, cj) => refine(minX + ci * step, minZ + cj * step)
        : undefined,
      heightAt,
      attributes: {
        uv: { itemSize: 2, compute: (x, z) => [x / 8, z / 8] },
        urbanCover: { itemSize: 1, compute: (x, z) => coverAt({ x, z }) },
      },
    });
    this.terrainSubdivision = geo.userData.subdivisionCounts;
    geo.computeVertexNormals();
    const clipStart = performance.now();
    const clipped = clipTerrainGeometry(
      geo,
      (this.streetSurfaceGeometries ?? []).filter(
        (geometry) => !geometry.userData.railHead,
      ),
    );
    this.terrainTimings = {
      latticeMilliseconds: Math.round(clipStart - latticeStart),
      subdivisionMilliseconds: geo.userData.subdivisionMilliseconds,
      clippingMilliseconds: Math.round(performance.now() - clipStart),
      latticeTriangles: geo.index.count / 3,
    };
    geo.dispose();
    this.terrainVisualStats = clipped.userData.terrainClippingStats;
    // Street cuts add fine boundary faces. Keep their GPU cost local instead
    // of drawing the complete twenty-kilometre terrain mesh every frame.
    const cellSize = 320,
      position = clipped.getAttribute("position"),
      cells = new Map(),
      attributes = Object.entries(clipped.attributes);
    for (let i = 0; i < position.count; i += 3) {
      const x =
          (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3,
        z =
          (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3,
        key = `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(i);
    }
    for (const [key, triangles] of cells) {
      const [x, z] = key.split(":").map(Number),
        geometry = new THREE.BufferGeometry();
      for (const [name, source] of attributes) {
        const values = new Float32Array(triangles.length * 3 * source.itemSize);
        let offset = 0;
        for (const index of triangles)
          for (let vertex = 0; vertex < 3; vertex++)
            for (let component = 0; component < source.itemSize; component++)
              values[offset++] = source.getComponent(index + vertex, component);
        geometry.setAttribute(
          name,
          new THREE.BufferAttribute(values, source.itemSize, source.normalized),
        );
      }
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.materials.terrain),
        group = new THREE.Group();
      mesh.receiveShadow = true;
      group.add(mesh);
      this.addChunk(
        group,
        (x + 0.5) * cellSize,
        (z + 0.5) * cellSize,
        cellSize * Math.SQRT1_2 + 40,
      );
      this.chunks.at(-1).detail = "terrain";
    }
    clipped.dispose();
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
      const p = stopPedestrianPlacement(
        this.route,
        this.sceneryClearance,
        stop,
      );
      if (!p) continue;
      const g = new THREE.Group();
      g.position.set(p.x, p.y + p.lift, p.z);
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
      // The source sidewalk/platform outline is already rendered with its
      // own curb. A stop must not add a standard slab across the actual road.
      if (this.assets.shelter) {
        const shelterAt = stopPedestrianPlacement(
          this.route,
          this.sceneryClearance,
          stop,
          stop.s - 13,
          0.95,
        );
        if (
          shelterAt &&
          stopHasMappedShelter(
            this.route,
            this.city.publicSpaces?.paths,
            stop,
            shelterAt,
          )
        ) {
          const shelter = this.assets.shelter.clone(true);
          shelter.position.set(
            shelterAt.x,
            shelterAt.y + shelterAt.lift,
            shelterAt.z,
          );
          shelter.rotation.y = shelterAt.yaw + Math.PI / 2;
          shelter.updateMatrixWorld(true);
          if (
            pedestrianBoundsSupported(
              this.route,
              this.sceneryClearance,
              new THREE.Box3().setFromObject(shelter),
            )
          ) {
            shelter.position.applyMatrix4(localFromWorld);
            shelter.rotation.y -= p.yaw;
            g.add(shelter);
          }
        }
      }
      this.scene.add(g);
      this.stopGroups.push({ g, s: stop.s });
    }
  }
  sandstoneMaterial() {
    return (this.sandstone ??= new THREE.MeshStandardMaterial({
      color: 0xb59f78,
      roughness: 0.92,
    }));
  }
  /**
   * Balustrades along the outer edges of the bridge walkways: each station
   * scans outward across the surveyed level-1 sidewalk to its last metre.
   */
  bridgeBalustrades(s0, s1) {
    const plans = this.route.streetHeightPlans;
    if (!plans) return [];
    const runs = { [-1]: [], [1]: [] };
    for (const side of [-1, 1]) {
      let run = [];
      const finish = () => {
        if (run.length > 1) runs[side].push(run);
        run = [];
      };
      for (let s = s0; s <= s1; s += 1.5) {
        if (!this.route.isBridge(s)) {
          finish();
          continue;
        }
        let edge = null;
        for (let offset = 2; offset <= 14; offset += 0.25) {
          const p = this.route.at(s, side * offset);
          if (plans.at(p, ["sidewalk"], 1)) edge = offset;
          else if (edge !== null && offset - edge > 1) break;
        }
        if (edge === null) {
          finish();
          continue;
        }
        const p = this.route.at(s, side * (edge - 0.1));
        run.push({ x: p.x, y: this.route.height(s) + 0.15, z: p.z });
      }
      finish();
    }
    return [...runs[-1], ...runs[1]]
      .map((points) => balustradeGeometry(points))
      .filter(Boolean);
  }
  createStreetLamps() {
    if (!this.assets.lamp) return;
    // One shared lens material: the whole street switches on together.
    let lens = null;
    const lensFrom = (material) =>
      (lens ??= Object.assign(material.clone(), {
        emissive: new THREE.Color(0xffd29a),
        emissiveIntensity: 0.25,
      }));
    this.streetLampPositions = [];
    // Mapped OSM lamps stand at their real positions; the synthetic rhythm
    // only fills stretches where none is mapped. The luminaire type follows
    // the street photographs of each section (street-lamps.js).
    const mapped = [];
    for (const lamp of this.city?.streetLights?.lamps ?? []) {
      const p = this.route.project(lamp.lat, lamp.lon),
        near = this.route.nearest(p);
      if (near.distance < 2.2 || this.route.isBridge(near.s)) continue;
      if (this.sceneryClearance?.buildingAt?.(p, 0.1)) continue;
      if (this.sceneryClearance?.carriagewayAt?.(p, 0.1)) continue;
      if (lampStyleAt(near.s) === "suspended") continue;
      const tangent = this.route.at(near.s),
        side = Math.sign(
          (p.x - near.x) * -tangent.dz + (p.z - near.z) * tangent.dx,
        );
      mapped.push({
        x: p.x,
        y: this.route.groundHeight(p, near),
        z: p.z,
        s: near.s,
        yaw: tangent.yaw + (side < 0 ? Math.PI : 0),
        // A modern lamp's arm reaches over the street towards the track.
        arm: Math.atan2(-(near.z - p.z), near.x - p.x),
        suspended: /suspended|wall/.test(
          `${lamp.lamp_mount ?? ""} ${lamp.support ?? ""}`,
        ),
      });
    }
    const placements = mapped.map((lamp) => ({ ...lamp, mapped: true }));
    for (let s = 15; s < this.route.length; s += 45) {
      if (mapped.some((lamp) => Math.abs(lamp.s - s) < 30)) continue;
      if (lampStyleAt(s) === "suspended") continue;
      const profile = this.streetProfile(s),
        p = this.route.at(s, profile.sidewalkRight),
        centre = this.route.at(s, profile.center);
      placements.push({
        x: p.x,
        y: p.y,
        z: p.z,
        s,
        yaw: p.yaw,
        arm: Math.atan2(-(centre.z - p.z), centre.x - p.x),
      });
    }
    // Cross wires over the old-town streets every 32 m, from sidewalk to
    // sidewalk, with the luminaire above the middle of the carriageway.
    for (let s = 15; s < this.route.length; s += 32) {
      if (lampStyleAt(s) !== "suspended" || this.route.isBridge(s)) continue;
      const profile = this.streetProfile(s);
      const left = profile.sidewalkLeft ?? profile.center - profile.width / 2,
        right = profile.sidewalkRight ?? profile.center + profile.width / 2;
      const middle = (left + right) / 2,
        p = this.route.at(s, middle);
      placements.push({
        x: p.x,
        y: p.y,
        z: p.z,
        s,
        yaw: p.yaw,
        style: "suspended",
        span: Math.max(6, Math.abs(right - left)),
      });
    }
    this.mappedLampCount = mapped.length;
    const modern = modernLampGeometry();
    const steel = new THREE.MeshStandardMaterial({
      color: 0x8d9196,
      metalness: 0.55,
      roughness: 0.45,
    });
    const glass = this.assets.lamp
      .getObjectsByProperty("isMesh", true)
      .find((o) => /glass|lamp|light/i.test(o.material?.name ?? ""))?.material;
    for (const p of placements) {
      const style = p.style ?? lampStyleAt(p.s ?? 0);
      if (p.suspended && style !== "suspended") {
        this.streetLampPositions.push(new THREE.Vector3(p.x, p.y + 6.5, p.z));
        continue;
      }
      if (style === "modern" || style === "suspended") {
        const parts =
          style === "modern" ? modern : suspendedLampGeometry(p.span);
        const g = new THREE.Group();
        const pole = new THREE.Mesh(parts.steel, steel);
        const head = new THREE.Mesh(
          parts.lens,
          glass ? lensFrom(glass) : steel,
        );
        for (const mesh of [pole, head]) {
          mesh.castShadow = style === "modern";
          mesh.receiveShadow = true;
          g.add(mesh);
        }
        g.position.set(p.x, p.y + (style === "modern" ? 0.15 : 0), p.z);
        // Local +X is the arm (modern) or the wire across the street.
        g.rotation.y = style === "modern" ? (p.arm ?? p.yaw) : p.yaw;
        g.updateMatrixWorld(true);
        this.streetLampPositions.push(
          parts.light.clone().applyMatrix4(g.matrixWorld),
        );
        this.addChunk(g, p.x, p.z, 15);
        continue;
      }
      const model = this.assets.lamp.clone(true);
      model.position.set(p.x, p.y + 0.27, p.z);
      model.rotation.y = p.yaw;
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          if (/glass|lamp|light/i.test(o.material?.name ?? ""))
            o.material = lensFrom(o.material);
        }
      });
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      this.streetLampPositions.push(
        new THREE.Vector3(p.x, box.max.y - 0.35, p.z),
      );
      const g = new THREE.Group();
      g.add(model);
      this.addChunk(g, p.x, p.z, 15);
    }
    this.streetLampMaterials = lens ? [lens] : [];
    // Forward rendering cannot afford a light per lamp. A small pool follows
    // the nearest lamps so the pavement under them is actually lit at night.
    this.lampLights = Array.from({ length: 6 }, () => {
      const light = new THREE.PointLight(0xffc98a, 0, 26, 1.6);
      light.castShadow = false;
      this.scene.add(light);
      return light;
    });
  }
  updateLampLights(viewPoint) {
    if (!this.lampLights) return;
    const on = this.lampFactor ?? 0;
    if (on <= 0.01) {
      for (const light of this.lampLights) light.intensity = 0;
      return;
    }
    const nearest = this.streetLampPositions
      .map((p) => ({ p, d: p.distanceToSquared(viewPoint) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.lampLights.length);
    this.lampLights.forEach((light, i) => {
      const item = nearest[i];
      light.intensity = item ? 46 * on : 0;
      if (item) light.position.copy(item.p);
    });
  }
  streetProfile(s) {
    if (this.mappedStreetProfile) return this.mappedStreetProfile(s);
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
    this.walker?.reset();
    this.cameraInitialized = false;
    this.lastCull = -100;
  }
  createPhotographicTrees() {
    const model = this.assets.tree;
    if (!model) return;
    model.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(model),
      height = bbox.max.y - bbox.min.y,
      crownRadius =
        (bbox.max.x - bbox.min.x + bbox.max.z - bbox.min.z) / 4 / height,
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
    // Surveyed woodland receives an estimated stand around its mapped trees.
    const planted = plantWoodland(
        this.route,
        this.city.woodland,
        this.city.trees,
      ),
      trees = [...this.city.trees, ...planted];
    this.woodlandTreeCount = planted.length;
    for (let i = 0; i < trees.length; i++) {
      const tree = trees[i],
        p = this.route.project(tree.lat, tree.lon),
        near = this.route.nearest(p),
        treeHeight = Math.max(
          3,
          Math.min(35, Number.parseFloat(tree.height) || 7.5),
        );
      if (
        near.distance < 5 ||
        near.distance > 270 ||
        this.route.isBridge(near.s) ||
        !this.sceneryClearance.canPlaceTree(
          p,
          treeHeight * 0.24,
          this.streetProfile(near.s),
          near,
        )
      )
        continue;
      const key = `${Math.floor(p.x / TREE_CELL)}:${Math.floor(p.z / TREE_CELL)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      const conifer = tree.kind === "conifer",
        scaleY = conifer ? treeHeight : treeHeight / height;
      // A measured crown widens or narrows the model within natural limits.
      const spread = tree.crown
        ? THREE.MathUtils.clamp(
            tree.crown / ((conifer ? 0.36 : crownRadius) * treeHeight),
            0.7,
            1.4,
          )
        : 1;
      buckets.get(key).push({
        x: p.x,
        y: this.route.groundHeight(p, near) - 0.08,
        z: p.z,
        scale: scaleY,
        spread,
        angle: rand(i + 71) * Math.PI * 2,
        conifer,
      });
    }
    const matrix = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      position = new THREE.Vector3(),
      scale = new THREE.Vector3();
    const flat = new THREE.PlaneGeometry(height * 1.04, height * 1.04);
    flat.translate(0, height / 2, 0);
    // Three crossed renders keep the crown's volume from any direction.
    const planes = [0, 1, 2].map((i) =>
      flat.clone().rotateY((i * Math.PI) / 3),
    );
    const impostorGeo = mergeGeometries(planes, false);
    flat.dispose();
    planes.forEach((plane) => plane.dispose());
    const impostorMat = new THREE.MeshStandardMaterial({
      map: this.treeImpostor,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 1,
      envMapIntensity: 0.15,
    });
    // Surveyed conifers (IPR category) get their own low-poly silhouette in
    // both the near and the distant tree level of detail.
    const coniferGeo = coniferGeometry(),
      coniferMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        side: THREE.DoubleSide,
        envMapIntensity: 0.3,
      });
    const instances = (geometry, material, items, shadow = true) => {
      const mesh = new THREE.InstancedMesh(geometry, material, items.length);
      items.forEach((p, i) => {
        position.set(p.x, p.y, p.z);
        scale.set(p.scale * p.spread, p.scale, p.scale * p.spread);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.angle);
        matrix.compose(position, q, scale);
        mesh.setMatrixAt(i, matrix);
      });
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      return mesh;
    };
    for (const [key, all] of buckets) {
      const [ix, iz] = key.split(":").map(Number),
        group = new THREE.Group(),
        conifers = all.filter((p) => p.conifer),
        items = all.filter((p) => !p.conifer);
      if (conifers.length)
        group.add(instances(coniferGeo, coniferMat, conifers));
      for (const part of parts) {
        if (!items.length) break;
        const mesh = new THREE.InstancedMesh(
          part.geometry,
          part.material,
          items.length,
        );
        items.forEach((p, i) => {
          position.set(p.x, p.y, p.z);
          scale.set(p.scale * p.spread, p.scale, p.scale * p.spread);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.angle);
          matrix.compose(position, q, scale);
          mesh.setMatrixAt(i, matrix);
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
      this.addChunk(
        group,
        (ix + 0.5) * TREE_CELL,
        (iz + 0.5) * TREE_CELL,
        TREE_CELL * Math.SQRT1_2 + 1,
      );
      this.chunks.at(-1).detail = "tree-near";
      const farGroup = new THREE.Group();
      if (items.length)
        farGroup.add(instances(impostorGeo, impostorMat, items, false));
      if (conifers.length)
        farGroup.add(instances(coniferGeo, coniferMat, conifers, false));
      this.addChunk(
        farGroup,
        (ix + 0.5) * TREE_CELL,
        (iz + 0.5) * TREE_CELL,
        TREE_CELL * Math.SQRT1_2 + 1,
      );
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
    // Saloon lighting of both cars, switched on with the street lamps.
    this.cabinLights = [this.tram, this.rearTram].filter(Boolean).map((car) => {
      const light = new THREE.PointLight(0xfff0d8, 0, 9, 1.4);
      light.position.set(0, 2.05, -0.4);
      car.add(light);
      return light;
    });
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
  createAmbientOcclusion() {
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
      this.scene.traverseVisible((o) => {
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
    this.composer.insertPass(this.aoPass, 1);
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
    this.measuredBridgeStats = addMeasuredBridges(this);
    for (let s = 9470; s < 9870; s += 75) {
      if (!this.route.isBridge(s) || measuredBridgeAt(this, s)) continue;
      const p = this.route.at(s, -1.6),
        g = new THREE.Group(),
        top = p.y - 0.3,
        bottom = Math.min(p.y - 7.3, this.riverLevel() - 1.5);
      box(
        g,
        [18, top - bottom, 9],
        [p.x, (top + bottom) / 2, p.z],
        new THREE.MeshStandardMaterial({ color: 0x9a9a89, roughness: 1 }),
      );
      this.addChunk(g, p.x, p.z, 15);
    }
    createPragueSkyline(this);
    createMappedLandmarks(this);
  }
  createWipers() {
    this.wiperGroup = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x222622 });
    for (const side of [0, 1]) {
      const g = new THREE.Group();
      g.userData.side = side;
      box(g, [0.012, 1, 0.018], [0, 0.5, 0], mat);
      this.wiperGroup.add(g);
    }
    this.tram.add(this.wiperGroup);
  }
  createRain() {
    const n = 1000,
      pos = new Float32Array(n * 6);
    this.rainDrops = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.rainDrops[i * 3] = (rand(i) - 0.5) * 65;
      this.rainDrops[i * 3 + 1] = rand(i + 50) * 38 - 8;
      this.rainDrops[i * 3 + 2] = (rand(i + 100) - 0.5) * 65;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: 0xc7d9d7,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
    this.rainCenter = null;
  }
  setQuality(q) {
    if (this.quality === q && this.drawDistance !== undefined) return;
    this.quality = q;
    this.renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio,
        q === "high" ? 1.5 : q === "medium" ? 1 : 0.8,
      ),
    );
    this.renderer.shadowMap.enabled = q !== "low";
    const shadowSize = q === "high" ? 4096 : 2048;
    if (this.sun.shadow.mapSize.x !== shadowSize) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.drawDistance = q === "high" ? 680 : q === "medium" ? 480 : 340;
    this.camera.far = q === "high" ? 2400 : 1600;
    this.camera.updateProjectionMatrix();
    this.lastCull = -100;
    if (q !== "low" && !this.composer) this.createPostprocessing();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(innerWidth, innerHeight);
      if (q === "high" && !this.aoPass) this.createAmbientOcclusion();
      if (this.aoPass) this.aoPass.enabled = q === "high";
      this.aoPass?.setSize(
        Math.ceil(innerWidth * 0.65 * this.renderer.getPixelRatio()),
        Math.ceil(innerHeight * 0.65 * this.renderer.getPixelRatio()),
      );
    }
    this.renderer.shadowMap.needsUpdate = true;
  }
  setWeather(w) {
    // "evening" was a former weather preset; the time of day is now real.
    this.weather = w === "rain" ? "rain" : "clear";
    const rain = this.weather === "rain";
    this.weatherUniforms.wetness.value = rain ? 1 : 0;
    this.windshieldRain?.reset();
    this.rainCenter = null;
    this.rain.visible = rain;
    this.wipers = rain;
    this.applyEnvironment();
  }
  solarAt(ymd, seconds) {
    const origin = this.route.data?.origin ?? { lat: 50.075, lon: 14.42 };
    return solarPosition(pragueToUtc(ymd, seconds), origin.lat, origin.lon);
  }
  /** Prague service day (YYYYMMDD) and seconds since its midnight. */
  setClock(ymd, seconds) {
    if (!ymd || !Number.isFinite(seconds)) return;
    const previous = this.clockState;
    this.clockState = { ymd, seconds };
    if (
      previous?.ymd === ymd &&
      Math.abs(seconds - (this.solarSeconds ?? -1e9)) < 12
    )
      return;
    this.solarSeconds = seconds;
    this.solar = this.solarAt(ymd, seconds);
    this.applyEnvironment();
  }
  currentSky() {
    return skyFor(this.solar?.elevation ?? 18, this.weather);
  }
  loadSky(entry) {
    const cached = this.skies.get(entry.file);
    if (cached) return cached.promise;
    const record = { entry, ready: false };
    record.promise = new HDRLoader()
      .loadAsync(`${import.meta.env.BASE_URL}textures/${entry.file}`)
      .then((sky) => {
        sky.mapping = THREE.EquirectangularReflectionMapping;
        const probe = streetLightProbe(
          sky.image.data,
          sky.image.width,
          sky.image.height,
          THREE.DataUtils.fromHalfFloat,
        );
        // Half floats filter linearly on every WebGL 2 device.
        const halves = new Uint16Array(probe.data.length);
        for (let i = 0; i < halves.length; i++)
          halves[i] = THREE.DataUtils.toHalfFloat(probe.data[i]);
        const probeTexture = new THREE.DataTexture(
          halves,
          probe.width,
          probe.height,
          THREE.RGBAFormat,
          THREE.HalfFloatType,
        );
        probeTexture.mapping = THREE.EquirectangularReflectionMapping;
        probeTexture.colorSpace = sky.colorSpace;
        probeTexture.minFilter = probeTexture.magFilter = THREE.LinearFilter;
        probeTexture.needsUpdate = true;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        record.environment = pmrem.fromEquirectangular(probeTexture).texture;
        pmrem.dispose();
        probeTexture.dispose();
        // The photographed sun (or the brightest glow) is turned to the
        // real solar azimuth; sky, reflections and shadows then agree.
        record.azimuth = directionAzimuth(
          panoramaSunDirection(
            sky.image.data,
            sky.image.width,
            sky.image.height,
            0,
            THREE.DataUtils.fromHalfFloat,
          ),
        );
        record.sky = sky;
        record.ready = true;
        this.applyEnvironment();
        return record;
      })
      .catch((error) => {
        console.warn(`Obloha ${entry.file} není dostupná:`, error.message);
        record.failed = true;
        this.applyEnvironment();
        return record;
      });
    this.skies.set(entry.file, record);
    return record.promise;
  }
  applyEnvironment() {
    if (!this.sun || !this.ambient) return;
    const solar = this.solar ?? { azimuth: 140, elevation: 18 };
    const light = lightingFor(solar.elevation, this.weather);
    const wanted = skyFor(solar.elevation, this.weather);
    const record = this.skies.get(wanted.file);
    if (!record) this.loadSky(wanted);
    if (record?.ready) this.activeSky = record;
    const active = this.activeSky;
    const sunward = sunDirection({
      azimuth: solar.azimuth,
      elevation: Math.max(solar.elevation, 0.8),
    });
    if (active && !record?.failed) {
      this.sky.visible = false;
      this.scene.background = active.sky;
      this.scene.backgroundRotation.set(
        0,
        THREE.MathUtils.degToRad(active.azimuth - solar.azimuth),
        0,
      );
      this.scene.environment = active.environment;
      this.scene.environmentRotation.copy(this.scene.backgroundRotation);
    } else if (record?.failed || !active) {
      this.scene.background = null;
      this.sky.visible = true;
      this.sky.material.uniforms.sunPosition.value.set(
        sunward.x,
        Math.sin(THREE.MathUtils.degToRad(solar.elevation)),
        sunward.z,
      );
      this.sky.material.uniforms.turbidity.value =
        this.weather === "rain" ? 14 : 3.2;
    }
    this.scene.backgroundIntensity = light.backgroundIntensity;
    this.scene.environmentIntensity = light.environmentIntensity;
    const direction = light.moon
      ? sunDirection({ azimuth: solar.azimuth + 180, elevation: 38 })
      : sunward;
    this.sunOffset = new THREE.Vector3(
      direction.x,
      direction.y,
      direction.z,
    ).multiplyScalar(220);
    this.sun.intensity = light.moon ? light.moonIntensity : light.sunIntensity;
    this.sun.color.setHex(light.moon ? 0x9fb2d9 : light.sunColor);
    this.ambient.intensity = light.ambientIntensity;
    this.ambient.color.setHex(light.ambientColor);
    this.ambient.groundColor.setHex(light.groundColor);
    this.scene.fog.color.setHex(light.fogColor);
    this.scene.fog.density = light.fogDensity;
    this.renderer.toneMappingExposure = light.exposure;
    this.nightFactor = light.night;
    this.lampFactor = light.lamps;
    facadeNight.value = light.night;
    facadeNight.share = litWindowShare(this.clockState?.seconds ?? 43200);
    if (this.bloomPass) {
      this.bloomPass.strength = light.bloom;
      this.bloomPass.threshold = 1.8 - 0.9 * light.night;
    }
    for (const lamp of this.streetLampMaterials ?? [])
      lamp.emissiveIntensity = 0.25 + 7 * light.lamps;
    for (const lamp of this.headlights ?? [])
      lamp.intensity =
        80 + 300 * light.night + (this.weather === "rain" ? 100 : 0);
    for (const lamp of this.cabinLights ?? []) lamp.intensity = 9 * light.lamps;
    this.renderer.shadowMap.needsUpdate = true;
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
    this.lastCull = -100;
    this.lastWalkCull = null;
    this.look = 0;
    this.pitch = 0;
  }
  update(dt, sim, menu = false) {
    this.time += dt;
    this.weatherUniforms.time.value = this.time;
    const snapshot = sim.getSnapshot?.() ?? sim;
    this.weatherUniforms.wetness.value = menu
      ? this.weather === "rain"
        ? 1
        : 0
      : (snapshot.railWetness ?? (this.weather === "rain" ? 1 : 0));
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
    // Development-only fixed viewpoint for comparing the scene with geotagged
    // street photographs; never set by the game itself.
    const debugView = this.debugCamera ?? null;
    const viewPoint =
      debugView?.position ??
      (this.walker?.active ? this.walker.position : front);
    for (const stop of this.stopGroups) {
      if (this.walker?.active) {
        const stopPoint = route.at(stop.s);
        stop.g.visible =
          Math.hypot(stopPoint.x - viewPoint.x, stopPoint.z - viewPoint.z) <
          750;
      } else stop.g.visible = Math.abs(stop.s - sim.s) < 750;
    }
    let targetPosition, targetLook;
    if (debugView) {
      targetPosition = debugView.position.clone();
      targetLook = debugView.look.clone();
    } else if (menu) {
      const pos = route.at(sim.s + 14, -9);
      targetPosition = new THREE.Vector3(pos.x, pos.y + 3.8, pos.z);
      targetLook = new THREE.Vector3(p.x, p.y + 2, p.z);
    } else if (this.walker?.active) {
      const pose = this.walker.cameraPose();
      targetPosition = pose.position;
      targetLook = pose.look;
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
    const walking = (this.walker?.active && !menu) || !!debugView;
    if (!walking)
      targetPosition = constrainCamera(this, targetPosition, targetLook, menu);
    if (!this.cameraInitialized || menu || this.cameraMode === 0 || walking)
      this.camera.position.copy(targetPosition);
    else this.camera.position.lerp(targetPosition, Math.min(1, dt * 5));
    if (!walking)
      this.camera.position.copy(
        constrainCamera(this, this.camera.position, targetLook, menu),
      );
    this.camera.lookAt(targetLook);
    this.cameraInitialized = true;
    this.wiperGroup.visible = this.cameraMode === 0 && !menu && !walking;
    for (const w of this.wiperGroup.children) {
      const { pivot, tip } = wiperEndpoints(
        this.time,
        this.wipers,
        w.userData.side,
      );
      const direction = tip.sub(pivot);
      w.position.copy(pivot);
      w.scale.y = direction.length();
      w.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.normalize(),
      );
    }
    this.windshieldRain.update(
      dt,
      this.time,
      this.weather === "rain",
      this.wipers,
      this.cameraMode === 0 && !menu && !walking,
    );
    if (this.weather === "rain") {
      const movement = this.rainCenter
        ? this.camera.position.clone().sub(this.rainCenter)
        : new THREE.Vector3();
      this.rainCenter = this.camera.position.clone();
      this.rain.position.copy(this.camera.position);
      const tramInverse = new THREE.Matrix4()
        .compose(this.tram.position, this.tram.quaternion, this.tram.scale)
        .invert();
      const localDrop = new THREE.Vector3();
      const attr = this.rain.geometry.attributes.position;
      for (let i = 0; i < this.rainDrops.length / 3; i++) {
        const k = i * 3,
          v = i * 6;
        this.rainDrops[k] += dt * 1.3 - movement.x;
        this.rainDrops[k + 1] -= dt * 19 + movement.y;
        this.rainDrops[k + 2] += dt * 0.4 - movement.z;
        for (const axis of [0, 2])
          this.rainDrops[k + axis] =
            THREE.MathUtils.euclideanModulo(
              this.rainDrops[k + axis] + 32.5,
              65,
            ) - 32.5;
        this.rainDrops[k + 1] =
          THREE.MathUtils.euclideanModulo(this.rainDrops[k + 1] + 8, 38) - 8;
        const x = this.rainDrops[k],
          y = this.rainDrops[k + 1],
          z = this.rainDrops[k + 2];
        // No rain in the driver compartment. Geometry still uses scene depth outdoors.
        localDrop
          .set(x, y, z)
          .add(this.camera.position)
          .applyMatrix4(tramInverse);
        const glassZ =
          -7.017 +
          Math.abs(localDrop.x) * 0.139 +
          THREE.MathUtils.clamp(localDrop.y - 1.79, 0, 0.84) * 0.21;
        const inside =
          Math.abs(localDrop.x) < 1.22 &&
          localDrop.y > 0.7 &&
          localDrop.y < 2.82 &&
          localDrop.z > glassZ &&
          localDrop.z < 6.78;
        attr.array.set(
          [
            x,
            y,
            z,
            x - (inside ? 0 : 0.045),
            y + (inside ? 0 : 0.68),
            z - (inside ? 0 : 0.015),
          ],
          v,
        );
      }
      attr.needsUpdate = true;
    }
    if (
      Math.abs(sim.s - this.lastCull) > 24 ||
      (walking &&
        (!this.lastWalkCull ||
          Math.hypot(
            viewPoint.x - this.lastWalkCull.x,
            viewPoint.z - this.lastWalkCull.z,
          ) > 12))
    ) {
      this.lastCull = sim.s;
      this.lastWalkCull = walking ? { ...viewPoint } : null;
      const d = this.drawDistance ?? 680;
      // The full photographic tree is reserved for the nearest crowns; the
      // dense surveyed canopy beyond uses the crossed renders of the same tree.
      const nearTreeDistance =
        this.quality === "high" ? 45 : this.quality === "medium" ? 30 : 0;
      const farTreeDistance =
        this.quality === "high" ? 400 : this.quality === "medium" ? 300 : 160;
      for (const c of this.chunks) {
        const distance = Math.hypot(c.x - viewPoint.x, c.z - viewPoint.z);
        const facadeDistance =
          this.quality === "high" ? 150 : this.quality === "medium" ? 90 : 45;
        for (const mesh of c.group.children) {
          const lod = mesh.userData.facadeLOD;
          if (lod)
            mesh.geometry =
              distance < facadeDistance + c.radius
                ? lod.nearGeometry
                : lod.farGeometry;
        }
        if (c.detail === "tree-near")
          c.group.visible =
            this.quality !== "low" && distance < nearTreeDistance + c.radius;
        else if (c.detail === "tree-impostor")
          c.group.visible =
            (this.quality === "low" ||
              distance >= nearTreeDistance + c.radius) &&
            distance < farTreeDistance + c.radius;
        else if (c.detail === "terrain")
          c.group.visible = distance < this.camera.far + c.radius;
        else if (c.detail === "skyline")
          c.group.visible =
            distance < (this.quality === "high" ? 2200 : 1500) + c.radius;
        else if (c.detail === "city")
          c.group.visible =
            distance <
            (this.quality === "high"
              ? 1100
              : this.quality === "medium"
                ? 750
                : 400) +
              c.radius;
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
      this.sun.target.position.set(viewPoint.x, viewPoint.y, viewPoint.z);
      this.updateLampLights(this.camera.position);
    }
    // The real sun keeps moving while the tram waits at a stop.
    if (this.sun) {
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
      surroundingBuildings: this.contextBuildingCount,
      cityBatches: this.cityBatchCount,
      prebuiltScenery: this.usedPrebuiltScenery ?? false,
      models: this.modelStatus,
      quality: this.quality,
      loadingMs: this.loadingMs,
      startupTimings: this.startupTimings,
      streetLife: this.urban.stats,
      facadeDetails: this.facadeStats,
      roofDetails: this.roofDetailStats,
      trees: this.treeCount,
      scenery: this.osmSceneryStats,
      skyline: this.skylineStats,
      mappedLandmarks: this.mappedLandmarkStats,
      terrainSamples: this.route.terrain.data?.sampleCount ?? 0,
      terrainGeometry: this.terrainVisualStats,
      streetDetails: this.streetDetailStats,
      streetFeatures: this.streetFeatureStats,
      measuredBridges: this.measuredBridgeStats,
      woodlandTrees: this.woodlandTreeCount,
      measuredBuildings: this.measuredBuildingCount,
      terrainSubdivision: this.terrainSubdivision,
      terrainTimings: this.terrainTimings,
    };
  }
}
