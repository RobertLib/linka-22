// Prague sidewalks are mapped as separate OSM footways: "sett" is the small
// granite mosaic, "asphalt" the cast surface of most residential streets and
// "paving_stones" grey concrete slabs. Untagged sidewalks keep the mosaic in
// the historic centre and slabs elsewhere.
export function sidewalkMaterialAt(world, point, historic) {
  const materials = world.materials;
  const mosaic = materials.praguePaving ?? materials.sidewalk;
  const surface = world.sceneryClearance
    ?.sidewalkSurfacesAt?.(point, 9)
    .filter((hit) => hit.path.surface)
    .sort((a, b) => a.distance - b.distance)[0]?.path.surface;
  if (/sett|cobble|mosaic/.test(surface ?? "")) return mosaic;
  if (surface === "asphalt")
    return materials.sidewalkAsphalt ?? materials.sidewalk;
  if (surface) return materials.sidewalk;
  return historic ? mosaic : materials.sidewalk;
}
