import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { passageContains, PASSAGE_CLEARANCE } from "./passage.js";
import { buildingProfile, facadeBays } from "./building-profiles.js";

const seed = (n) => {
  const v = Math.sin(n * 127.1 + 81.7) * 43758.5453;
  return v - Math.floor(v);
};
function part(size, pos, color = 0xffffff, frameTint = 1) {
  const g = new THREE.BoxGeometry(...size);
  g.translate(...pos);
  const shade = new THREE.Color(color),
    colors = [];
  for (let i = 0; i < g.attributes.position.count; i++)
    colors.push(shade.r, shade.g, shade.b);
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute(
    "frameTint",
    new THREE.Float32BufferAttribute(
      Array(g.attributes.position.count).fill(frameTint),
      1,
    ),
  );
  return g;
}
function assembled(parts) {
  const result = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return result;
}
function windowReveal() {
  // Only the four visible sloping faces are needed: eight triangles per
  // opening, rather than the forty-eight triangles of four closed boxes.
  const w = 0.585,
    h = 0.98,
    bw = 0.5075,
    bh = 0.875,
    front = 0.155,
    back = -0.043;
  const quads = [
    [
      [-w, -h, front],
      [-bw, -bh, back],
      [-bw, bh, back],
      [-w, h, front],
    ],
    [
      [w, -h, front],
      [w, h, front],
      [bw, bh, back],
      [bw, -bh, back],
    ],
    [
      [-w, h, front],
      [-bw, bh, back],
      [bw, bh, back],
      [w, h, front],
    ],
    [
      [-w, -h, front],
      [w, -h, front],
      [bw, -bh, back],
      [-bw, -bh, back],
    ],
  ];
  const geometry = new THREE.BufferGeometry(),
    positions = [],
    uvs = [],
    indices = [],
    colors = [],
    masonry = new THREE.Color(0xc8c3b6);
  quads.forEach((quad, i) => {
    positions.push(...quad.flat());
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    for (let j = 0; j < 4; j++) colors.push(masonry.r, masonry.g, masonry.b);
  });
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute(
    "frameTint",
    new THREE.Float32BufferAttribute(Array(16).fill(0), 1),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
function windowFrame(historic, variant = 0) {
  const pieces = [
    // Four sloping reveals surround an open aperture. The former full backing
    // quad sat in front of the glazing and hid all window textures/reflections.
    windowReveal(),
    part(
      [0.065, 1.84, 0.11],
      [-0.525, 0, 0.055],
      historic ? 0xf1eade : 0xb4b9b5,
    ),
    part(
      [0.065, 1.84, 0.11],
      [0.525, 0, 0.055],
      historic ? 0xf1eade : 0xb4b9b5,
    ),
    part([1.1, 0.07, 0.11], [0, 0.89, 0.055], historic ? 0xf1eade : 0xb4b9b5),
    part([1.1, 0.07, 0.11], [0, -0.89, 0.055], historic ? 0xf1eade : 0xb4b9b5),
    part([0.045, 1.75, 0.065], [0, 0, 0.082], historic ? 0xe9e1d0 : 0xb4b9b5),
    part(
      [1.03, 0.045, 0.065],
      [0, historic ? 0.35 : 0.08, 0.082],
      historic ? 0xe9e1d0 : 0xb4b9b5,
    ),
    part([1.34, 0.1, historic ? 0.34 : 0.19], [0, -1.01, 0.08], 0xd4cfc1, 0),
  ];
  if (historic) {
    const slender = variant === 2;
    pieces.push(
      part(
        [slender ? 0.09 : 0.14, 2.05, slender ? 0.1 : 0.14],
        [-0.69, 0, 0.06],
        0xe6ddcc,
        0,
      ),
      part(
        [slender ? 0.09 : 0.14, 2.05, slender ? 0.1 : 0.14],
        [0.69, 0, 0.06],
        0xe6ddcc,
        0,
      ),
      part(
        [variant === 1 ? 1.61 : 1.51, 0.13, variant === 1 ? 0.24 : 0.19],
        [0, 1.0, 0.075],
        0xe6ddcc,
        0,
      ),
    );
    if (variant === 1)
      pieces.push(
        part([1.72, 0.07, 0.3], [0, 1.1, 0.095], 0xddd6c8, 0),
        part([1.45, 0.055, 0.21], [0, -1.1, 0.045], 0xddd6c8, 0),
      );
    if (variant === 2)
      // Restrained eared stucco surrounds, shared by all bays of this building.
      for (const x of [-0.74, 0.74])
        pieces.push(part([0.24, 0.11, 0.14], [x, 0.95, 0.075], 0xe6ddcc, 0));
  }
  return assembled(pieces);
}

function distantWindowFrame(geometry) {
  // At street-scale distances the rear and thin side faces of the frame are
  // subpixel. Keep the original front faces and all four sloping reveals,
  // sharing their positions, normals, UVs and masonry/paint attributes.
  const distant = new THREE.BufferGeometry(),
    indices = [],
    normal = geometry.getAttribute("normal"),
    source = geometry.getIndex();
  for (const [name, attribute] of Object.entries(geometry.attributes))
    distant.setAttribute(name, attribute);
  for (let i = 0; i < source.count; i += 3) {
    const a = source.getX(i),
      b = source.getX(i + 1),
      c = source.getX(i + 2);
    if (normal.getZ(a) + normal.getZ(b) + normal.getZ(c) > 0)
      indices.push(a, b, c);
  }
  distant.setIndex(indices);
  return distant;
}

function crownCornice(variant) {
  if (variant === 0) return new THREE.BoxGeometry(1, 0.12, 0.28);
  return assembled(
    variant === 1
      ? [
          part([1, 0.045, 0.12], [0, -0.075, -0.025]),
          part([1, 0.055, 0.23], [0, -0.027, 0.025]),
          part([1, 0.04, 0.35], [0, 0.022, 0.065]),
        ]
      : [
          part([1, 0.07, 0.21], [0, -0.048, 0]),
          part([1, 0.045, 0.4], [0, 0.022, 0.06]),
        ],
  );
}

function addressMaterial(houseNumber, streetName) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#9f2927";
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = "#efe4d2";
  ctx.lineWidth = 3;
  ctx.strokeRect(7, 7, 242, 114);
  ctx.fillStyle = "#f5eede";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (houseNumber) {
    ctx.font = `700 ${Math.min(57, (205 / Math.max(1, houseNumber.length)) * 1.65)}px Arial`;
    ctx.fillText(houseNumber, 128, streetName ? 55 : 66, 224);
  }
  if (streetName) {
    ctx.font = `${houseNumber ? 17 : 25}px Arial`;
    ctx.fillText(streetName, 128, houseNumber ? 98 : 66, 224);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.36,
    metalness: 0.14,
  });
  // Keep the original combined value, including letters and slash. The source
  // has no separate CN/ON fields, so it does not justify red/blue reclassification.
  material.userData.sourceAddress = { houseNumber, streetName };
  return material;
}
function doorGeometry() {
  return assembled([
    // Stone reveals and a threshold put the timber leaf behind the portal.
    part([0.13, 2.85, 0.28], [-0.79, 0.015, 0.11], 0xc8c0af, 0),
    part([0.13, 2.85, 0.28], [0.79, 0.015, 0.11], 0xc8c0af, 0),
    part([1.46, 0.13, 0.28], [0, 1.38, 0.11], 0xc8c0af, 0),
    part([1.7, 0.06, 0.4], [0, -1.36, 0.12], 0x9d998e, 0),
    part([1.42, 2.7, 0.08], [0, 0, 0], 0x332a23),
    part([0.095, 2.7, 0.12], [-0.68, 0, 0.065], 0x756751),
    part([0.095, 2.7, 0.12], [0.68, 0, 0.065], 0x756751),
    part([1.44, 0.09, 0.12], [0, 1.31, 0.065], 0x756751),
    part([1.26, 0.36, 0.045], [0, 1.04, 0.065], 0x425453),
    part([1.3, 0.08, 0.12], [0, 0.8, 0.085], 0x6b5440),
    part([0.06, 2.24, 0.085], [0, -0.18, 0.08], 0x786049),
    ...[-0.33, 0.33].flatMap((x) => [
      part([0.45, 0.83, 0.04], [x, 0.23, 0.065], 0x644d37),
      part([0.45, 0.57, 0.04], [x, -0.73, 0.065], 0x644d37),
      part([0.025, 0.23, 0.03], [x * 0.35, -0.04, 0.125], 0xa79966),
    ]),
  ]);
}
function storefrontGeometry() {
  return assembled([
    part([0.07, 2.56, 0.23], [-1.09, 0, -0.015], 0xb6b2a7, 0),
    part([0.07, 2.56, 0.23], [1.09, 0, -0.015], 0xb6b2a7, 0),
    part([2.16, 0.07, 0.23], [0, 1.28, -0.015], 0xb6b2a7, 0),
    part([0.075, 2.5, 0.1], [-1.02, 0, 0.02], 0x3d413b),
    part([0.075, 2.5, 0.1], [1.02, 0, 0.02], 0x3d413b),
    part([2.1, 0.08, 0.1], [0, 1.21, 0.02], 0x3d413b),
    part([2.1, 0.13, 0.13], [0, -1.19, 0.02], 0x656255),
    part([2.03, 0.055, 0.09], [0, 0.62, 0.035], 0x55584d),
    part([0.045, 2.4, 0.08], [-0.42, 0, 0.035], 0x55584d),
  ]);
}
function glazingTexture(variant) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext("2d");
  // This is a room's rear wall, not a photograph of a sky pasted onto glass.
  // Physical environment reflection is added by MeshStandardMaterial.
  const light = ctx.createLinearGradient(0, 0, 0, 256);
  light.addColorStop(0, "#77786d");
  light.addColorStop(0.55, variant === 3 ? "#9a8f76" : "#89887b");
  light.addColorStop(1, "#54584f");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, 128, 256);
  // Restrained room furnishing stays behind the curtain layer.
  ctx.fillStyle = "#51564e";
  ctx.fillRect(38, 182, 52, 57);
  ctx.fillStyle = "#aaa38e";
  ctx.fillRect(37, 181, 54, 3);
  if (variant === 0 || variant === 3) {
    ctx.fillStyle = "#55574e";
    ctx.fillRect(49, 91, 31, 44);
    ctx.fillStyle = "#8c8c7d";
    ctx.fillRect(53, 95, 23, 36);
  }
  if (variant !== 0) {
    const width = variant === 2 ? 39 : 27;
    for (const side of [0, 128 - width]) {
      ctx.fillStyle = variant === 3 ? "#b7ac92" : "#b6b8a9";
      ctx.fillRect(side, 5, width, 244);
      for (let x = side + 2; x < side + width; x += 5) {
        ctx.fillStyle = "rgba(241,234,212,.12)";
        ctx.fillRect(x, 5, 2, 244);
        ctx.fillStyle = "rgba(28,39,35,.09)";
        ctx.fillRect(x + 2, 5, 1, 244);
      }
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

/** Opaque room-box illusion behind a physically reflecting instanced pane. */
function interiorGlazing(map, storefront = false) {
  const rooms = Array.isArray(map) ? map : [map],
    varied = rooms.length > 1;
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: rooms[0],
    metalness: 0.24,
    roughness: storefront ? 0.14 : 0.11,
    envMapIntensity: 1.15,
  });
  const opening = storefront ? [2.02, 2.4] : [1.015, 1.75];
  material.userData.parallaxInterior = true;
  if (varied) material.userData.facadeRoomMaps = rooms;
  material.onBeforeCompile = (shader) => {
    if (varied)
      for (let i = 1; i < rooms.length; i++)
        shader.uniforms[`facadeRoomMap${i}`] = { value: rooms[i] };
    shader.uniforms.facadeOpening = { value: new THREE.Vector2(...opening) };
    shader.uniforms.facadeRoom = {
      value: storefront
        ? new THREE.Vector3(4.8, 3.2, 3.7)
        : new THREE.Vector3(2.9, 2.75, 2.55),
    };
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
      uniform vec2 facadeOpening;
      varying vec3 vFacadeEye;
      varying vec2 vFacadeOpening;
      ${varied ? "attribute float facadeRoomVariant;\nvarying float vFacadeRoomVariant;" : ""}`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      mat4 facadeTransform = modelViewMatrix;
      #ifdef USE_INSTANCING
        facadeTransform = facadeTransform * instanceMatrix;
      #endif
      vec3 facadeTangent = (facadeTransform * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
      vec3 facadeUp = (facadeTransform * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
      vFacadeOpening = facadeOpening * vec2(length(facadeTangent), length(facadeUp));
      ${varied ? "vFacadeRoomVariant = facadeRoomVariant;" : ""}
      facadeTangent = normalize(facadeTangent);
      facadeUp = normalize(facadeUp);
      vec3 facadeNormal = normalize(cross(facadeTangent, facadeUp));
      vFacadeEye = vec3(dot(-mvPosition.xyz, facadeTangent),
        dot(-mvPosition.xyz, facadeUp), dot(-mvPosition.xyz, facadeNormal));`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
      uniform vec3 facadeRoom;
      varying vec3 vFacadeEye;
      varying vec2 vFacadeOpening;
      ${varied ? "varying float vFacadeRoomVariant;\nuniform sampler2D facadeRoomMap1;\nuniform sampler2D facadeRoomMap2;\nuniform sampler2D facadeRoomMap3;" : ""}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `
      // Intersect a ray through the opening with the back, floor, ceiling or
      // side wall. The room stays attached to its building as the camera moves.
      vec3 facadeRay = normalize(vec3(-vFacadeEye.xy, -abs(vFacadeEye.z)));
      vec3 facadeOrigin = vec3((vMapUv - 0.5) * vFacadeOpening, 0.0);
      vec2 facadeDirection = mix(vec2(-1.0), vec2(1.0), step(vec2(0.0), facadeRay.xy));
      vec2 facadeSide = (facadeDirection * facadeRoom.xy * 0.5 - facadeOrigin.xy)
        / (facadeDirection * max(abs(facadeRay.xy), vec2(0.0001)));
      float facadeBack = facadeRoom.z / max(-facadeRay.z, 0.0001);
      float facadeDistance = min(facadeBack, min(facadeSide.x, facadeSide.y));
      vec3 facadeHit = facadeOrigin + facadeRay * facadeDistance;
      vec2 facadeBackUv = facadeHit.xy / facadeRoom.xy + 0.5;
      vec3 facadeInterior;
      if (facadeBack <= min(facadeSide.x, facadeSide.y)) {
        vec2 facadeUv = clamp(facadeBackUv, 0.0, 1.0);
        ${
          varied
            ? `if (vFacadeRoomVariant < 0.5)
          facadeInterior = texture2D(map, facadeUv).rgb;
        else if (vFacadeRoomVariant < 1.5)
          facadeInterior = texture2D(facadeRoomMap1, facadeUv).rgb;
        else if (vFacadeRoomVariant < 2.5)
          facadeInterior = texture2D(facadeRoomMap2, facadeUv).rgb;
        else facadeInterior = texture2D(facadeRoomMap3, facadeUv).rgb;`
            : "facadeInterior = texture2D(map, facadeUv).rgb;"
        }
      } else if (facadeSide.y < facadeSide.x) {
        float facadeBoard = step(0.92, fract(facadeHit.x * 6.0));
        facadeInterior = facadeRay.y < 0.0
          ? vec3(0.23, 0.21, 0.17) * (1.0 - facadeBoard * 0.18)
          : vec3(0.43, 0.43, 0.38);
      } else {
        facadeInterior = vec3(0.34, 0.35, 0.30);
      }
      float facadeRecess = 0.78 + 0.22 * clamp(-facadeHit.z / facadeRoom.z, 0.0, 1.0);
      float facadeFresnel = pow(1.0 - abs(normalize(vFacadeEye).z), 5.0);
      diffuseColor.rgb *= mix(facadeInterior * facadeRecess,
        vec3(0.35, 0.43, 0.45), 0.08 + facadeFresnel * 0.3);
      `,
    );
  };
  material.customProgramCacheKey = () =>
    `facade-room-v2-${storefront}-${varied}`;
  return material;
}

function paintedFrameMaterial(roughness = 0.78) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness,
  });
  // Instance tint changes timber/metal paint, while stone reveals and trim
  // retain their original light masonry color within the same draw call.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      "#include <common>\nattribute float frameTint;",
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <color_vertex>",
      THREE.ShaderChunk.color_vertex.replace(
        "vColor.xyz *= instanceColor.xyz;",
        "vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, frameTint);",
      ),
    );
  };
  material.customProgramCacheKey = () => "painted-facade-frame-v1";
  return material;
}

function plinthTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const base = ctx.createLinearGradient(0, 0, 0, 128);
  base.addColorStop(0, "#e5e3dc");
  base.addColorStop(0.48, "#d8d6cf");
  base.addColorStop(1, "#aaa99f");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 110; i++) {
    const x = seed(i + 6) * 512,
      y = 70 + seed(i + 91) * 58;
    ctx.fillStyle = `rgba(74,77,67,${0.02 + seed(i + 36) * 0.04})`;
    ctx.fillRect(x, y, 1 + seed(i + 67) * 8, 128 - y);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}
function simplifiedRing(points) {
  const ring = points.slice();
  if (
    ring.length > 1 &&
    Math.hypot(ring[0].x - ring.at(-1).x, ring[0].z - ring.at(-1).z) < 0.01
  )
    ring.pop();
  // Merge survey vertices along one wall, preserving actual corners and outlines.
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length],
        b = ring[i],
        d = ring[(i + 1) % ring.length];
      const ux = b.x - a.x,
        uz = b.z - a.z,
        vx = d.x - b.x,
        vz = d.z - b.z;
      if (
        ux * vx + uz * vz > 0 &&
        Math.abs(ux * vz - uz * vx) /
          Math.max(0.01, Math.hypot(d.x - a.x, d.z - a.z)) <
          0.065
      ) {
        ring.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return ring;
}

/** Street-facing facade modules follow one architectural profile per OSM building. */
export function createBuildingDetails(world) {
  const { route, city } = world,
    buckets = new Map();
  const geos = {
    frame: [0, 1, 2].map((variant) => windowFrame(true, variant)),
    simpleFrame: windowFrame(false),
    glass: new THREE.PlaneGeometry(1.015, 1.75),
    cornice: new THREE.BoxGeometry(1, 0.12, 0.28),
    crown: [0, 1, 2].map(crownCornice),
    plinth: new THREE.BoxGeometry(1, 1, 0.09),
    pilaster: new THREE.BoxGeometry(0.28, 1, 0.15),
    door: doorGeometry(),
    storefront: storefrontGeometry(),
    shop: new THREE.PlaneGeometry(2.02, 2.4),
    awning: new THREE.BoxGeometry(2.5, 0.11, 0.7),
    gutter: new THREE.CylinderGeometry(0.037, 0.037, 1, 6),
    address: new THREE.BoxGeometry(0.62, 0.3, 0.018),
    rustication: assembled(
      Array.from({ length: 8 }, (_, i) =>
        part([1, 0.006, 0.007], [0, (i + 0.5) / 8 - 0.5, 0], 0xffffff),
      ),
    ),
    balcony: assembled([
      part([1.6, 0.1, 0.65], [0, 0, 0], 0xafa99b),
      part([1.6, 0.035, 0.035], [0, 0.87, 0.31], 0x303b34),
      part([0.035, 0.035, 0.65], [-0.78, 0.87, 0], 0x303b34),
      part([0.035, 0.035, 0.65], [0.78, 0.87, 0], 0x303b34),
      ...[-0.78, -0.52, -0.26, 0, 0.26, 0.52, 0.78].map((x) =>
        part([0.023, 0.87, 0.023], [x, 0.43, 0.31], 0x303b34),
      ),
    ]),
  };
  const distantFrames = {
    frame: geos.frame.map(distantWindowFrame),
    simpleFrame: distantWindowFrame(geos.simpleFrame),
  };
  const plain = (color, roughness = 0.86) =>
    new THREE.MeshStandardMaterial({ color, roughness });
  const colored = (roughness = 0.78) =>
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness,
    });
  const mats = {
    frame: paintedFrameMaterial(),
    simpleFrame: paintedFrameMaterial(0.55),
    door: paintedFrameMaterial(0.66),
    storefront: paintedFrameMaterial(0.58),
    balcony: colored(0.5),
    cornice: plain(0xffffff),
    crown: plain(0xffffff),
    pilaster: plain(0xffffff),
    plinth: plain(0xffffff, 0.95),
    gutter: new THREE.MeshStandardMaterial({
      color: 0x575c58,
      metalness: 0.6,
      roughness: 0.5,
    }),
    rustication: plain(0xffffff, 0.98),
    glass: interiorGlazing([0, 1, 2, 3].map(glazingTexture)),
    shop: interiorGlazing(glazingTexture(0), true),
    awning: [0x344b3f, 0x63403a, 0xa49576].map((c) => plain(c, 0.97)),
    address: [],
  };
  mats.plinth.map = plinthTexture();
  let palace = false,
    windows = 0,
    faces = 0,
    shopCount = 0,
    entrances = 0,
    addresses = 0;
  const profiles = {};
  const geometryFor = (kind, variant) =>
    Array.isArray(geos[kind]) ? geos[kind][variant] : geos[kind];
  const instance = (
    kind,
    p,
    yaw,
    scale = [1, 1, 1],
    variant = 0,
    detail = "fine",
    tint = 0xffffff,
  ) => {
    if (scale.some((value) => !Number.isFinite(value) || value <= 0)) return;
    if (palace) {
      const geo = geometryFor(kind, variant);
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bounds = geo.boundingBox,
        bottom = p.y + bounds.min.y * scale[1];
      const left = bounds.min.x * scale[0],
        right = bounds.max.x * scale[0];
      const samples = Math.max(2, Math.ceil((right - left) / 1.2));
      for (let i = 0; i <= samples; i++) {
        const x = left + ((right - left) * i) / samples;
        const q = { x: p.x + Math.cos(yaw) * x, z: p.z - Math.sin(yaw) * x };
        if (
          passageContains(q, route) &&
          bottom < route.height(route.nearest(q).s) + PASSAGE_CLEARANCE + 0.08
        )
          return;
      }
    }
    const cx = Math.floor(p.x / 120),
      cz = Math.floor(p.z / 120);
    // The four original room maps share one material and one draw per cell.
    // Their per-window choice remains an instance attribute, not an atlas.
    const batchVariant = kind === "glass" ? 0 : variant,
      key = `${cx}:${cz}:${kind}:${batchVariant}:${detail}`;
    if (!buckets.has(key))
      buckets.set(key, {
        kind,
        variant: batchVariant,
        cx,
        cz,
        items: [],
        detail,
      });
    buckets.get(key).items.push({ p, yaw, scale, tint, variant });
  };
  for (const building of city.buildings) {
    palace = building.osmId === "relation/4681559";
    if (
      world.mappedLandmarkIds?.has(building.osmId) ||
      /Mikuláš|Národní divadlo/.test(building.name ?? "")
    )
      continue;
    const projected = building.points.map((p) =>
      Array.isArray(p) ? route.project(...p) : route.project(p.lat, p.lon),
    );
    if (projected.length < 3) continue;
    // Match the body and roof datum, including the closing survey vertex.
    const mid = {
      x: projected.reduce((s, p) => s + p.x, 0) / projected.length,
      z: projected.reduce((s, p) => s + p.z, 0) / projected.length,
    };
    const near = route.nearest(mid);
    if (near.distance > 110) continue;
    const profile = buildingProfile(building, route, near, mid);
    if (profile.utility || profile.sacred) continue;
    profiles[profile.style] = (profiles[profile.style] ?? 0) + 1;
    const { height, base, historic } = profile,
      points = simplifiedRing(projected);
    const framePaint = historic
      ? [
          0xffffff, 0xf0eade, 0xe4e0d7, 0xd1d4ca, 0x839083, 0xd5c7b2, 0xffffff,
          0xffffff,
        ][profile.identity % 8]
      : [0xffffff, 0xd0d6d4, 0x8f9897, 0xe6e8e3][profile.identity % 4];
    const doorPaint = [0xe1c4a6, 0xa7b5a4, 0xb8b4a5, 0xd0bca8][
      profile.identity % 4
    ];
    // Untagged ornament is a restrained district approximation. One section
    // belongs to the whole building, preserving its coherent window rhythm.
    const surround = historic
      ? /renaissance|classic/.test(profile.architecture)
        ? 1
        : /baroque|rococo/.test(profile.architecture)
          ? 2
          : profile.identity % 3
      : 0;
    const area = points.reduce((s, p, i) => {
      const q = points[(i + 1) % points.length];
      return s + p.x * q.z - q.x * p.z;
    }, 0);
    const orientation = area > 0 ? 1 : -1,
      edges = [];
    for (let ei = 0; ei < points.length; ei++) {
      const a = points[ei],
        b = points[(ei + 1) % points.length],
        dx = b.x - a.x,
        dz = b.z - a.z,
        length = Math.hypot(dx, dz);
      if (length < 3.1) continue;
      const nx = (orientation * dz) / length,
        nz = (-orientation * dx) / length;
      const edgeMid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 },
        edgeNear = route.nearest(edgeMid);
      if (
        edgeNear.distance > 85 ||
        (edgeNear.x - edgeMid.x) * nx + (edgeNear.z - edgeMid.z) * nz < -0.4
      )
        continue;
      edges.push({ a, dx, dz, length, nx, nz, edgeNear });
    }
    const entranceEdge = edges.reduce(
      (best, edge) =>
        !best ||
        edge.edgeNear.distance + 18 / edge.length <
          best.edgeNear.distance + 18 / best.length
          ? edge
          : best,
      null,
    );
    for (const edge of edges) {
      const { a, dx, dz, length, nx, nz, edgeNear } = edge,
        yaw = Math.atan2(nx, nz);
      const position = (t, y, depth = 0.1) => ({
        x: a.x + dx * t + nx * depth,
        y: base + y,
        z: a.z + dz * t + nz * depth,
      });
      const pavementHeight = (t, width = 0) => {
        let highest = -Infinity;
        for (const side of [-1, 0, 1]) {
          const p = position(
            Math.max(0, Math.min(1, t + (side * width) / (2 * length))),
            0,
            0.2,
          );
          const ground =
            route.groundHeight?.(p, route.nearest(p)) ??
            route.height(route.nearest(p).s);
          highest = Math.max(highest, ground + 0.27);
        }
        return highest;
      };
      const groundPosition = (t, y, depth = 0.1, datum = pavementHeight(t)) => {
        const p = position(t, y, depth);
        p.y += datum - base;
        return p;
      };
      const bays = facadeBays(profile, length),
        { columns, spacing, width, centers } = bays;
      const windowScaleX = width / 1.1,
        trim = profile.trimColor;
      const retail =
        profile.retail &&
        edgeNear.distance < 38 &&
        (/^(retail|commercial|mall)$/.test(profile.type) ||
          profile.identity % 5 < 2);
      faces++;
      let plinthBottom = base;
      for (
        let sample = 0, count = Math.max(1, Math.ceil(length / 2));
        sample <= count;
        sample++
      )
        plinthBottom = Math.min(
          plinthBottom,
          pavementHeight(sample / count) - 0.05,
        );
      const plinthTop = base + 0.76;
      instance(
        "plinth",
        position(0.5, (plinthTop + plinthBottom) / 2 - base, 0.047),
        yaw,
        [length, plinthTop - plinthBottom, 1],
        0,
        "fine",
        [0xb9b5a9, 0xaaa69b, 0xbcb7a8, 0xa7aa9f][profile.identity % 4],
      );
      // Banded ground-floor masonry is reserved for explicitly tagged
      // Renaissance/Classicist facades; untagged homes keep plain plaster.
      if (/renaissance|classic/.test(profile.architecture))
        instance(
          "rustication",
          position(0.5, profile.groundHeight / 2, 0.012),
          yaw,
          [length, profile.groundHeight, 1],
          0,
          "fine",
          new THREE.Color(profile.wallColor).multiplyScalar(0.68).getHex(),
        );
      instance(
        "crown",
        position(0.5, height - 0.13, 0.14),
        yaw,
        [length + 0.08, historic ? 2.0 : 0.75, historic ? 1.15 : 0.55],
        surround,
        "fine",
        trim,
      );
      if (historic) {
        instance(
          "cornice",
          position(0.5, height - 0.42, 0.095),
          yaw,
          [length, 0.7, 0.82],
          0,
          "fine",
          trim,
        );
        if (profile.levels > 1)
          instance(
            "cornice",
            position(0.5, profile.groundHeight - 0.08, 0.12),
            yaw,
            [length, 1.2, 0.9],
            0,
            "fine",
            trim,
          );
      }
      for (let floor = 0; floor < profile.levels; floor++) {
        const band = profile.floors[floor];
        // A belt at the piano nobile defines the storeys without striping every floor.
        if (historic && floor === 2 && profile.ornate)
          instance(
            "cornice",
            position(0.5, band.bottom - 0.14, 0.09),
            yaw,
            [length, 0.58, 0.7],
            0,
            "fine",
            trim,
          );
        for (let col = 0; col < columns; col++) {
          const t = centers[col],
            unique = profile.identity + floor * 313 + col * 37;
          if (
            floor === 0 &&
            edge === entranceEdge &&
            col === Math.floor(columns / 2)
          ) {
            const doorScaleX = Math.min(1.15, spacing / 2.3),
              doorGround = pavementHeight(t, 1.71 * doorScaleX),
              doorHeight = Math.min(2.85, base + band.top - doorGround - 0.3);
            if (doorHeight < 1.7) continue;
            instance(
              "door",
              groundPosition(
                t,
                (1.41 * doorHeight) / 2.7 + 0.005,
                0.026,
                doorGround,
              ),
              yaw,
              [doorScaleX, doorHeight / 2.7, 1],
              0,
              "fine",
              doorPaint,
            );
            if (historic) {
              const doorWidth = 1.65 * doorScaleX;
              for (const side of [-1, 1]) {
                const q = groundPosition(
                  t,
                  doorHeight / 2 + 0.075,
                  0.09,
                  doorGround,
                );
                q.x += (Math.cos(yaw) * side * doorWidth) / 2;
                q.z -= (Math.sin(yaw) * side * doorWidth) / 2;
                instance(
                  "pilaster",
                  q,
                  yaw,
                  [0.8, doorHeight + 0.15, 1.1],
                  0,
                  "fine",
                  trim,
                );
              }
              instance(
                "cornice",
                groundPosition(t, doorHeight + 0.22, 0.17, doorGround),
                yaw,
                [doorWidth + 0.25, 1.1, 1.25],
                0,
                "fine",
                trim,
              );
            }
            const houseNumber = String(building.houseNumber ?? "").trim(),
              streetName = String(building.streetName ?? "").trim();
            if (houseNumber || streetName) {
              const variant = mats.address.length;
              mats.address.push(addressMaterial(houseNumber, streetName));
              const plaque = groundPosition(
                  t,
                  Math.min(2.55, doorHeight - 0.1),
                  0.025,
                  doorGround,
                ),
                offset = Math.min(
                  0.9 * Math.min(1.15, spacing / 2.3) + 0.49,
                  length * (1 - t) - 0.33,
                );
              plaque.x += Math.cos(yaw) * offset;
              plaque.z -= Math.sin(yaw) * offset;
              instance("address", plaque, yaw, [1, 1, 1], variant);
              addresses++;
            }
            entrances++;
            continue;
          }
          if (floor === 0 && retail && band.height > 2.65) {
            const shopWidth = Math.min(2.4, spacing * 0.72),
              shopGround = pavementHeight(t, shopWidth),
              shopHeight = Math.min(2.5, base + band.top - shopGround - 0.75);
            if (shopHeight < 1.2) continue;
            const shopScale = [shopWidth / 2.02, shopHeight / 2.4, 1],
              centerY = 0.19 + shopHeight / 2;
            instance(
              "shop",
              groundPosition(t, centerY, 0.03, shopGround),
              yaw,
              shopScale,
              0,
              "glass",
            );
            instance(
              "storefront",
              groundPosition(t, centerY, 0.15, shopGround),
              yaw,
              shopScale,
              0,
              "fine",
              framePaint,
            );
            // The dataset contains no shop tenants. Keep neutral frontages
            // instead of stamping fabricated business names onto every bay.
            if (
              edge === entranceEdge &&
              /^(retail|commercial|mall)$/.test(profile.type) &&
              profile.identity % 7 === 0
            )
              instance(
                "awning",
                groundPosition(t, shopHeight + 0.32, 0.45, shopGround),
                yaw,
                [shopWidth / 2.5, 1, 1],
                profile.identity % 3,
              );
            shopCount++;
            continue;
          }
          // Keep the upper storeys on the building's level floor datum. A
          // steep pavement may instead require a shorter ground-floor bay.
          const windowBottom =
            floor === 0
              ? Math.max(
                  base + band.center - band.windowHeight / 2,
                  pavementHeight(t, width) + 0.45,
                )
              : base + band.center - band.windowHeight / 2;
          const windowTop =
            floor === 0
              ? Math.min(
                  base + band.top - 0.35,
                  windowBottom + band.windowHeight,
                )
              : base + band.center + band.windowHeight / 2;
          if (windowTop - windowBottom < 0.7) continue;
          const windowCenter = (windowBottom + windowTop) / 2 - base,
            windowScale = [windowScaleX, (windowTop - windowBottom) / 1.8, 1];
          // Closely related room treatments keep the building's window rhythm coherent.
          const glazing = seed(unique) < 0.24 ? 0 : 1 + (profile.identity % 3);
          instance(
            "glass",
            position(t, windowCenter, 0.027),
            yaw,
            windowScale,
            glazing,
            "glass",
          );
          instance(
            historic ? "frame" : "simpleFrame",
            position(t, windowCenter, 0.07),
            yaw,
            windowScale,
            surround,
            "fine",
            framePaint,
          );
          if (historic && profile.ornate && floor === 1)
            instance(
              "cornice",
              position(t, band.center + band.windowHeight * 0.65, 0.17),
              yaw,
              [width + 0.52, 0.8, 0.9],
              0,
              "fine",
              trim,
            );
          // A balcony belongs to the central first-floor bay, rather than every third window.
          if (
            historic &&
            profile.levels >= 3 &&
            floor === 1 &&
            col === Math.floor(columns / 2) &&
            edge === entranceEdge &&
            profile.identity % 6 === 0
          )
            instance(
              "balcony",
              position(t, band.center - band.windowHeight * 0.56, 0.42),
              yaw,
              [windowScaleX, 1, 1],
            );
          windows++;
        }
      }
      if (historic && profile.ornate && length < 35)
        for (const t of [0.02, 0.98])
          instance(
            "pilaster",
            position(t, (height + profile.groundHeight) / 2, 0.06),
            yaw,
            [1, height - profile.groundHeight, 1],
            0,
            "fine",
            trim,
          );
      // One rainwater pipe per wall, with an offset from the corner masonry.
      const gutterT = Math.max(0.02, 1 - 0.24 / length),
        gutterBottom = Math.min(base, pavementHeight(gutterT) - 0.03),
        gutterTop = base + height;
      instance(
        "gutter",
        position(gutterT, (gutterBottom + gutterTop) / 2 - base, 0.17),
        0,
        [1, gutterTop - gutterBottom, 1],
      );
    }
  }
  const matrix = new THREE.Matrix4(),
    quaternion = new THREE.Quaternion(),
    position = new THREE.Vector3(),
    scale = new THREE.Vector3(),
    axis = new THREE.Vector3(0, 1, 0),
    color = new THREE.Color();
  for (const bucket of buckets.values()) {
    const material = Array.isArray(mats[bucket.kind])
      ? mats[bucket.kind][bucket.variant]
      : mats[bucket.kind];
    const geometry = geometryFor(bucket.kind, bucket.variant),
      mesh = new THREE.InstancedMesh(
        bucket.kind === "glass" ? geometry.clone() : geometry,
        material,
        bucket.items.length,
      );
    if (bucket.kind === "glass")
      mesh.geometry.setAttribute(
        "facadeRoomVariant",
        new THREE.InstancedBufferAttribute(
          new Float32Array(bucket.items.map((item) => item.variant)),
          1,
        ),
      );
    mesh.name = `facade-${bucket.kind}`;
    mesh.userData.facadeKind = bucket.kind;
    mesh.userData.facadeVariant = bucket.variant;
    if (distantFrames[bucket.kind])
      mesh.userData.facadeLOD = {
        nearGeometry: mesh.geometry,
        farGeometry: Array.isArray(distantFrames[bucket.kind])
          ? distantFrames[bucket.kind][bucket.variant]
          : distantFrames[bucket.kind],
      };
    bucket.items.forEach((item, i) => {
      position.set(item.p.x, item.p.y, item.p.z);
      quaternion.setFromAxisAngle(axis, item.yaw);
      scale.set(...item.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, color.setHex(item.tint));
    });
    mesh.castShadow = bucket.detail === "fine";
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    const group = new THREE.Group();
    group.add(mesh);
    world.addChunk(group, (bucket.cx + 0.5) * 120, (bucket.cz + 0.5) * 120, 90);
    world.chunks.at(-1).detail = bucket.detail;
  }
  world.facadeStats = {
    windows,
    faces,
    shops: shopCount,
    entrances,
    addresses,
    profiles,
    instanceBatches: buckets.size,
  };
}

/** The closed roof's vertical end walls use plaster rather than stretched tiles. */
export function splitRoofGeometry(geometry) {
  const count = geometry.userData.roofSurfaceVertexCount;
  if (!Number.isFinite(count)) return { roof: geometry, gables: null };
  const subset = (start, end, gable = false) => {
    const g = new THREE.BufferGeometry();
    for (const key of ["position", "normal", "uv"]) {
      const attr = geometry.getAttribute(key);
      g.setAttribute(
        key,
        new THREE.Float32BufferAttribute(
          attr.array.slice(start * attr.itemSize, end * attr.itemSize),
          attr.itemSize,
        ),
      );
    }
    if (gable) {
      const p = g.getAttribute("position"),
        n = g.getAttribute("normal"),
        uv = g.getAttribute("uv");
      for (let i = 0; i < p.count; i++)
        uv.setXY(
          i,
          (Math.abs(n.getX(i)) > 0.5 ? p.getZ(i) : p.getX(i)) / 4,
          p.getY(i) / 4,
        );
    }
    return g;
  };
  return {
    roof: subset(0, count),
    gables: subset(count, geometry.getAttribute("position").count, true),
  };
}
