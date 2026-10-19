import * as THREE from "three";

const decodeBase64 = (text) => {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(text),
      bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(globalThis.Buffer.from(text, "base64"));
};

/**
 * IPR Praha photogrammetric roofs, eaves profiles and ground of the OSM
 * buildings near the line (scripts/import-ipr-buildings.py). Attaches a
 * `measured` record to every matching building in place.
 */
export function attachMeasuredBuildings(buildings, data) {
  if (!data?.buildings?.length) return 0;
  const store = {
    positions: new Int32Array(decodeBase64(data.positions).buffer),
    indices: new Uint16Array(decodeBase64(data.indices).buffer),
  };
  // Multipolygon parts share one OSM id; the first vertex tells them apart.
  const byId = new Map();
  for (const record of data.buildings) {
    if (!byId.has(record.osmId)) byId.set(record.osmId, []);
    byId.get(record.osmId).push(record);
  }
  let attached = 0;
  for (const building of buildings) {
    const [lat, lon] = building.points?.[0] ?? [];
    const record = byId
      .get(building.osmId)
      ?.find(
        ({ anchor }) =>
          !anchor ||
          (Math.abs(anchor[0] - lat) < 1e-6 &&
            Math.abs(anchor[1] - lon) < 1e-6),
      );
    if (!record) continue;
    building.measured = { ...record, store };
    attached++;
  }
  return attached;
}

/** World-space vertices of one measured building (cm deltas decoded once). */
function measuredVertices(measured) {
  if (measured.vertices) return measured.vertices;
  const { positions } = measured.store,
    start = measured.vertexStart * 3,
    vertices = new Float32Array(measured.vertexCount * 3);
  let x = 0,
    y = 0,
    z = 0;
  for (let i = 0; i < measured.vertexCount; i++) {
    x += positions[start + i * 3];
    y += positions[start + i * 3 + 1];
    z += positions[start + i * 3 + 2];
    vertices[i * 3] = x / 100;
    vertices[i * 3 + 1] = y / 100;
    vertices[i * 3 + 2] = z / 100;
  }
  measured.vertices = vertices;
  return vertices;
}

/**
 * Flat-shaded measured faces split by covering: sloped roof, flat roof and
 * the walls that rise from the roof. UVs follow each face's own plane in
 * metres/4, like the procedural roofs and walls.
 */
export function measuredRoofGeometries(measured) {
  const vertices = measuredVertices(measured),
    { indices } = measured.store;
  // One covering per building: a mostly flat roof keeps its gently sloped
  // parts flat, a pitched roof only its truly level tops.
  let flatArea = 0,
    roofArea = 0;
  for (
    let i = measured.roofIndexStart;
    i < measured.roofIndexStart + measured.roofIndexCount;
    i += 3
  ) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map(
      (index) => [
        vertices[index * 3],
        vertices[index * 3 + 1],
        vertices[index * 3 + 2],
      ],
    );
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      area = Math.hypot(nx, ny, nz) / 2;
    roofArea += area;
    if (Math.abs(ny) / (2 * area || 1) >= 0.985) flatArea += area;
  }
  const flatLimit = flatArea > roofArea * 0.5 ? 0.94 : 0.985;
  const bucket = () => ({ position: [], normal: [], uv: [] }),
    buckets = { roof: bucket(), flat: bucket(), wall: bucket() };
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    normal = new THREE.Vector3(),
    tangent = new THREE.Vector3(),
    bitangent = new THREE.Vector3(),
    up = new THREE.Vector3(0, 1, 0);
  const emit = (start, count, wall) => {
    for (let i = start; i < start + count; i += 3) {
      a.fromArray(vertices, indices[i] * 3);
      b.fromArray(vertices, indices[i + 1] * 3);
      c.fromArray(vertices, indices[i + 2] * 3);
      normal.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (normal.lengthSq() < 1e-10) continue;
      normal.normalize();
      const target = wall
        ? buckets.wall
        : normal.y >= flatLimit
          ? buckets.flat
          : normal.y < 0.25
            ? buckets.wall
            : buckets.roof;
      // Horizontal contour as u, slope line as v.
      tangent.crossVectors(up, normal);
      if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
      tangent.normalize();
      bitangent.crossVectors(normal, tangent).normalize();
      for (const p of [a, b, c]) {
        target.position.push(p.x, p.y, p.z);
        target.normal.push(normal.x, normal.y, normal.z);
        target.uv.push(p.dot(tangent) / 4, p.dot(bitangent) / 4);
      }
    }
  };
  emit(measured.roofIndexStart, measured.roofIndexCount, false);
  emit(measured.wallIndexStart, measured.wallIndexCount, true);
  const geometry = ({ position, normal: normals, uv }) => {
    if (!position.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    return g;
  };
  return {
    roof: geometry(buckets.roof),
    flat: geometry(buckets.flat),
    wall: geometry(buckets.wall),
  };
}

/** Measured wall-top profile [t, y, t, y, …] of one footprint edge. */
export function measuredEdgeProfile(measured, ring, edge) {
  const values = measured?.walls?.[ring]?.[edge];
  return values?.length >= 4 ? values : null;
}

const profileAt = (values, t) => {
  if (t <= values[0]) return values[1];
  for (let i = 2; i < values.length; i += 2)
    if (t <= values[i]) {
      const t0 = values[i - 2],
        y0 = values[i - 1],
        span = values[i] - t0;
      return span > 1e-9
        ? y0 + ((values[i + 1] - y0) * (t - t0)) / span
        : values[i + 1];
    }
  return values.at(-1);
};

/**
 * OSM outline wall whose top follows the measured eaves/gable line. Edges
 * without a measured profile keep the flat top at base + height.
 */
export function measuredWallGeometry(
  points,
  height,
  base,
  groundAt,
  measured,
  ring = 0,
) {
  const pos = [],
    uv = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i],
      end = points[i + 1],
      length = Math.hypot(start.x - end.x, start.z - end.z);
    if (length < 1e-6) continue;
    const profile = measuredEdgeProfile(measured, ring, i),
      stations = new Set();
    const divisions = Math.max(1, Math.ceil(length / 3));
    for (let d = 0; d <= divisions; d++) stations.add(d / divisions);
    if (profile)
      for (let k = 0; k < profile.length; k += 2)
        if (profile[k] > 0 && profile[k] < 1) stations.add(profile[k]);
    const ts = [...stations].sort((p, q) => p - q);
    const top = (t) =>
      profile ? Math.max(base + 0.5, profileAt(profile, t)) : base + height;
    // The foundation follows the ground at the regular 3 m stations once
    // each; the extra profile breakpoints interpolate between them.
    const footing = [];
    for (let d = 0; d <= divisions; d++) {
      const t = d / divisions;
      footing.push(
        groundAt
          ? Math.min(
              base,
              groundAt({
                x: start.x + (end.x - start.x) * t,
                z: start.z + (end.z - start.z) * t,
              }) - 0.3,
            )
          : base,
      );
    }
    const bottom = (t) => {
      const f = t * divisions,
        d = Math.min(divisions - 1, Math.floor(f));
      return footing[d] + (footing[d + 1] - footing[d]) * (f - d);
    };
    for (let k = 0; k < ts.length - 1; k++) {
      const ta = ts[k],
        tb = ts[k + 1];
      if (tb - ta < 1e-6) continue;
      const a = {
          x: start.x + (end.x - start.x) * ta,
          z: start.z + (end.z - start.z) * ta,
        },
        b = {
          x: start.x + (end.x - start.x) * tb,
          z: start.z + (end.z - start.z) * tb,
        },
        bottomA = bottom(ta),
        bottomB = bottom(tb),
        topA = top(ta),
        topB = top(tb),
        ua = (ta * length) / 4,
        ub = (tb * length) / 4;
      pos.push(
        a.x,
        bottomA,
        a.z,
        b.x,
        bottomB,
        b.z,
        b.x,
        topB,
        b.z,
        a.x,
        bottomA,
        a.z,
        b.x,
        topB,
        b.z,
        a.x,
        topA,
        a.z,
      );
      uv.push(
        ua,
        (bottomA - base) / 4,
        ub,
        (bottomB - base) / 4,
        ub,
        (topB - base) / 4,
        ua,
        (bottomA - base) / 4,
        ub,
        (topB - base) / 4,
        ua,
        (topA - base) / 4,
      );
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * Measured wall top (world Y) nearest to a point on the building outline,
 * or null when that part of the outline has no measured roof.
 */
export function measuredWallTop(building, point, project) {
  const measured = building.measured;
  if (!measured) return null;
  measured.rings ??= [building.points, ...(building.holes ?? [])].map(
    (ring) => {
      const projected = ring.map((p) =>
        Array.isArray(p) ? project(p[0], p[1]) : project(p.lat, p.lon),
      );
      if (
        projected[0].x !== projected.at(-1).x ||
        projected[0].z !== projected.at(-1).z
      )
        projected.push({ ...projected[0] });
      return projected;
    },
  );
  let best = null,
    bestDistance = Infinity;
  measured.rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i],
        b = ring[i + 1],
        dx = b.x - a.x,
        dz = b.z - a.z,
        lengthSq = dx * dx + dz * dz;
      if (lengthSq < 1e-12) continue;
      const t = Math.max(
          0,
          Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq),
        ),
        distance = Math.hypot(a.x + dx * t - point.x, a.z + dz * t - point.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        const profile = measuredEdgeProfile(measured, r, i);
        best = profile ? profileAt(profile, t) : null;
      }
    }
  });
  return bestDistance < 2.5 ? best : null;
}

/**
 * Covering of a measured roof from its orthophoto colour: warm saturated
 * tones are fired tiles, green-blue patina is copper, the rest sheet metal,
 * slate or fibre cement.
 */
export function measuredRoofKind(color) {
  const hsl = new THREE.Color(color).getHSL({});
  if (hsl.s > 0.22 && (hsl.h < 0.11 || hsl.h > 0.95)) return "roofRed";
  if (hsl.s > 0.12 && hsl.h > 0.25 && hsl.h < 0.55) return "roof";
  return "roofSlate";
}
