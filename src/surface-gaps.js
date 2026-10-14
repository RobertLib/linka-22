// Estimated ribbons fill source gaps only. Test the exact four planar mesh
// vertices against every measured outline before allowing a fallback cell.
export function mappedSurfaceCellFree(
  route,
  lookup,
  start,
  end,
  width,
  offset,
) {
  if (!lookup) return true;
  const edge = (s, side) => {
    const breadth = typeof width === "function" ? width(s) : width;
    const lateral = typeof offset === "function" ? offset(s) : offset;
    return route.at(s, lateral + (side * breadth) / 2);
  };
  return !lookup.overlapsPolygon(
    [edge(start, -1), edge(start, 1), edge(end, 1), edge(end, -1)],
    null,
    route.streetLevel?.((start + end) / 2) ?? 0,
  );
}
