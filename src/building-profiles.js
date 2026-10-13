// OSM describes the building, while untagged detail is a district-level
// approximation. Keep the distinction here so walls, roofs and details agree.
import { roofProfile } from "./roof-geometry.js";

const PALETTE = [
  0xd5c29b, 0xddccb5, 0xd2bea1, 0xcdb18e, 0xe5dcc8, 0xc7beab, 0xcfb3a5,
  0xe0c98d, 0xc0c9ba, 0xe0d8bf, 0xcdb8a4, 0xd8cbad,
];
const NAMED_COLORS = {
  sand: 0xd8c49e,
  azure: 0xf0ffff,
  yellow: 0xfff0ac,
  bisque: 0xffe4c4,
  gray: 0x808080,
  grey: 0x808080,
  white: 0xf1eee6,
  pink: 0xe9bdc0,
  firebrick: 0xb22222,
  beige: 0xf5f5dc,
  brown: 0xa52a2a,
};
export function buildingSeed(building) {
  const identity =
    building.osmId ??
    building.id ??
    `${building.name ?? ""}/${JSON.stringify(building.points?.[0] ?? [])}`;
  let hash = 2166136261;
  for (const c of String(identity)) {
    hash ^= c.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
export function buildingColor(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (/^#?[0-9a-f]{6}$/.test(text))
    return Number.parseInt(text.replace("#", ""), 16);
  if (/^#[0-9a-f]{3}$/.test(text))
    return Number.parseInt(
      text
        .slice(1)
        .split("")
        .map((v) => v + v)
        .join(""),
      16,
    );
  return NAMED_COLORS[text] ?? fallback;
}
function lighten(color, amount) {
  const channel = (shift) =>
    Math.round(((color >> shift) & 255) * (1 - amount) + 243 * amount);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function positiveNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// An enriched outline is still one coarse volume. Inherit a part's roof only
// when that part covers most of the outline; do not spread a small tower or a
// side wing's roof over the complete building.
function primaryRoofPart(building) {
  return (building.buildingParts?.parts ?? [])
    .filter((part) => part.footprintCoverage >= 0.5)
    .sort((a, b) => b.footprintCoverage - a.footprintCoverage)[0];
}

export function buildingProfile(building, route, near, center = near) {
  const identity = buildingSeed(building);
  const recordedLevels = positiveNumber(building.levels);
  const recordedHeight =
    positiveNumber(building.height) ?? (recordedLevels ?? 4) * 3.3;
  const levels = Math.max(
    1,
    Math.round(recordedLevels ?? recordedHeight / 3.3),
  );
  const architecture = String(building.architecture ?? "").toLowerCase();
  const type = String(building.type ?? "yes");
  const roofPart = primaryRoofPart(building);
  const roofShape = String(
    building.roofShape ?? roofPart?.tags?.["roof:shape"] ?? "",
  ).toLowerCase();
  const roofDirection =
    building.roofDirection ?? roofPart?.tags?.["roof:direction"];
  const roofOrientation =
    building.roofOrientation ?? roofPart?.tags?.["roof:orientation"];
  const roofAngle = building.roofAngle ?? roofPart?.tags?.["roof:angle"];
  const sacred = /^(church|chapel|temple)$/.test(type);
  const utility =
    /^(garage|garages|shed|hut|bunker|greenhouse|toilets|parking|construction)$/.test(
      type,
    );
  const industrial =
    /^(industrial|warehouse|barn|service|transportation)$/.test(type);
  const modern = /modern|functional|constructiv|brutalist|high tech/.test(
    architecture,
  );
  const historic =
    !modern &&
    !industrial &&
    !utility &&
    (route.isHistoric(near.s) ||
      // The Vršovice tenement belt is a district approximation, not an OSM style tag.
      (near.s >= 13500 &&
        near.s < 16000 &&
        levels >= 3 &&
        levels <= 6 &&
        /^(residential|apartments|yes)$/.test(type) &&
        roofShape !== "flat") ||
      /baroque|renaissance|classic|rococo|nouveau|gothic|romanesque|cubism/.test(
        architecture,
      ));
  const style = sacred
    ? "sacred"
    : industrial
      ? "industrial"
      : modern
        ? "modern"
        : /baroque|rococo/.test(architecture)
          ? "baroque"
          : /renaissance/.test(architecture)
            ? "renaissance"
            : historic
              ? "tenement"
              : "modern";
  const lowRiseHousing =
    /^(house|detached|semidetached_house|terrace|farm)$/.test(type) &&
    levels <= 3;
  const pitched = roofShape
    ? !/^(flat|none)$/.test(roofShape)
    : recordedHeight <= 34 && (historic || lowRiseHousing);
  const declaredRoofHeight =
    positiveNumber(building.roofHeight) ??
    positiveNumber(roofPart?.roofHeight ?? roofPart?.tags?.["roof:height"]);
  const footprint = (building.points ?? []).map((p) =>
    Array.isArray(p) ? route.project(...p) : route.project(p.lat, p.lon),
  );
  const roof = pitched
    ? roofProfile(footprint, 0, {
        roofShape,
        roofHeight: declaredRoofHeight,
        roofDirection,
        roofOrientation,
        roofAngle,
      })
    : null;
  let roofHeight = pitched ? (declaredRoofHeight ?? roof?.rise ?? 0) : 0;
  // OSM height measures the top of the roof. Levels-derived and explicitly
  // recovered eaves heights already describe the wall below the roof. The
  // enrichment can also preserve an unchanged outline height, which remains
  // an OSM total height despite its enclosing eaves metadata.
  const recoveredEaves =
    building.buildingParts?.heightPart &&
    building.buildingParts?.heightInterpretation === "eaves" &&
    building.buildingParts?.eavesSource !== "original-outline-height";
  const totalHeightRecorded =
    building.heightSource === "OSM" && !recoveredEaves;
  if (totalHeightRecorded)
    roofHeight = Math.min(roofHeight, Math.max(0, recordedHeight - 0.2));
  const wallHeight = totalHeightRecorded
    ? recordedHeight - roofHeight
    : recordedHeight;
  const totalHeight = wallHeight + roofHeight;
  // Keep the public height alias for facade callers: it consistently denotes
  // the wall/eaves height, never the top of a pitched roof.
  const height = wallHeight;
  const wallColor = buildingColor(
    building.color,
    PALETTE[identity % PALETTE.length],
  );
  const groundHeight =
    levels === 1
      ? height
      : Math.min(
          height * 0.5,
          Math.max(
            2.65,
            Math.min(5, (height / levels) * (historic ? 1.18 : 1.05)),
          ),
        );
  const upperHeight = levels > 1 ? (height - groundHeight) / (levels - 1) : 0;
  const floors = Array.from({ length: levels }, (_, floor) => {
    const bottom = floor === 0 ? 0 : groundHeight + (floor - 1) * upperHeight;
    const top = floor === 0 ? groundHeight : bottom + upperHeight;
    const h = top - bottom;
    return {
      bottom,
      top,
      height: h,
      center: bottom + h * (floor === 0 ? 0.56 : 0.51),
      windowHeight: Math.min(
        h * 0.64,
        historic ? (floor === 1 ? 2.35 : 2.15) : 1.75,
      ),
    };
  });
  return {
    height,
    wallHeight,
    totalHeight,
    roofHeight,
    heightInterpretation: totalHeightRecorded ? "total" : "eaves",
    roofHeightSource:
      declaredRoofHeight !== null || roof?.riseSource === "angle"
        ? "OSM"
        : "estimated",
    roofDirection,
    roofOrientation,
    roofAngle,
    roofOptions: {
      roofShape,
      roofHeight,
      roofDirection,
      roofOrientation,
      roofAngle,
    },
    base: (route.groundHeight?.(center, near) ?? route.height(near.s)) + 0.15,
    levels,
    floors,
    groundHeight,
    historic,
    style,
    architecture,
    type,
    identity,
    sacred,
    utility,
    industrial,
    roofShape,
    pitched,
    wallColor,
    trimColor: lighten(wallColor, 0.48),
    bayWidth: sacred ? 5.2 : industrial ? 4.2 : historic ? 3.05 : 3.45,
    windowWidth: industrial ? 2.05 : historic ? 1.18 : 1.45,
    // Schools and palaces do not acquire invented retail tenants.
    retail:
      /^(retail|commercial|mall)$/.test(type) ||
      (historic &&
        /^(residential|apartments|hotel|yes)$/.test(type) &&
        !/palác|palace/i.test(building.name ?? "")),
    ornate: /baroque|rococo|renaissance|classic|nouveau/.test(architecture),
  };
}
export function facadeBays(profile, length) {
  const margin = Math.min(0.85, length * 0.12);
  const columns = Math.max(
    1,
    Math.floor((length - margin * 2) / profile.bayWidth),
  );
  const spacing = (length - margin * 2) / columns;
  return {
    columns,
    spacing,
    margin,
    centers: Array.from(
      { length: columns },
      (_, i) => (margin + (i + 0.5) * spacing) / length,
    ),
    width: Math.min(profile.windowWidth, spacing * 0.55),
  };
}
