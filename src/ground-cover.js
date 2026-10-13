// Mapped green areas take precedence over urban land use. Unmapped ground
// remains green; only the immediate apron of a mapped building is mineral.
const CELL = 160;

function contains(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
}

export function createGroundCover(route, city) {
  const cells = new Map();
  const add = (feature, kind, padding = 0) => {
    const points = feature.points.map((p) => route.project(...p));
    if (points.length < 3) return;
    const holes = (feature.holes ?? []).map((r) =>
      r.map((p) => route.project(...p)),
    );
    const entry = { points, holes, kind };
    const x0 = Math.floor(
        (Math.min(...points.map((p) => p.x)) - padding) / CELL,
      ),
      x1 = Math.floor((Math.max(...points.map((p) => p.x)) + padding) / CELL),
      z0 = Math.floor((Math.min(...points.map((p) => p.z)) - padding) / CELL),
      z1 = Math.floor((Math.max(...points.map((p) => p.z)) + padding) / CELL);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const key = `${x}:${z}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(entry);
      }
  };
  for (const p of city.context?.landCover ?? []) add(p, p.kind);
  for (const p of city.parks ?? []) add(p, "green");
  for (const b of [
    ...(city.buildings ?? []),
    ...(city.context?.buildings ?? []),
  ])
    add(b, "building", 12);
  return (p) => {
    const features =
      cells.get(`${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`) ?? [];
    let urban = 0;
    for (const f of features) {
      const inHole = f.holes.some((h) => contains(p, h));
      if (contains(p, f.points) && !inHole) {
        if (f.kind === "green") return 0;
        urban = 1;
      }
      if (f.kind !== "building") continue;
      // Include courtyards and the twelve metre apron, without filling parks
      // merely because they happen to sit beside a residential block.
      for (const ring of [f.points, ...f.holes]) {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i],
            b = ring[i + 1],
            dx = b.x - a.x,
            dz = b.z - a.z;
          const t = Math.max(
            0,
            Math.min(
              1,
              ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1),
            ),
          );
          const d = Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
          urban = Math.max(urban, Math.max(0, 1 - d / 12));
        }
      }
    }
    return urban;
  };
}

export function createGroundMaterial(grass, asphaltMap) {
  const material = grass.clone();
  material.color.setHex(0xc5c9b0);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.urbanGroundMap = { value: asphaltMap };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float urbanCover;\nvarying float vUrbanCover;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvUrbanCover = urbanCover;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform sampler2D urbanGroundMap;\nvarying float vUrbanCover;",
      )
      .replace(
        "#include <map_fragment>",
        `
        #ifdef USE_MAP
          vec3 vegetation = texture2D(map, vMapUv).rgb;
          vec3 mineral = texture2D(urbanGroundMap, vMapUv * 2.0).rgb * vec3(1.25, 1.20, 1.12);
          diffuseColor.rgb *= mix(vegetation, mineral, clamp(vUrbanCover, 0.0, 1.0));
        #endif
      `,
      )
      .replace(
        "mapN.xy *= normalScale;",
        "mapN.xy *= normalScale * mix(1.0, 0.15, vUrbanCover);",
      );
  };
  material.customProgramCacheKey = () => "mapped-prague-ground-v1";
  return material;
}
