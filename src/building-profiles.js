// OSM describes the building, while untagged detail is a district-level
// approximation. Keep the distinction here so walls, roofs and details agree.
import { roofProfile } from "./roof-geometry.js";

// Untagged plaster follows the character of each district along the line:
// baroque pastels of Malá Strana and Hradčany, the greyer historicist
// tenements of Nové Město, lighter Vinohrady secession, interwar Břevnov,
// Vršovice and Strašnice, and the revitalised panel estates of Hostivař.
// Original estimates; an OSM building:colour always wins.
const PALETTES = {
  baroque: [
    0xe8cf9a, 0xe3be7e, 0xedd9b4, 0xe7c3a6, 0xddae94, 0xe9d3c8, 0xd8ddc6,
    0xf0ebdd, 0xcfc6b2, 0xe6d08e, 0xc9b7a0, 0xe2c9a0,
  ],
  centre: [
    0xd9cdb3, 0xcbbfa5, 0xbdb3a0, 0xe2d5b8, 0xd4b98f, 0xc5c0b4, 0xe9e1cd,
    0xb8a58a, 0xd7c7ae, 0xcfb9a3, 0xa9a596, 0xdcc9a2,
  ],
  vinohrady: [
    0xeee3c8, 0xe6d7b2, 0xdcd5c3, 0xf1ecdf, 0xe5cdb0, 0xd9dccf, 0xe8d9a6,
    0xd8c5b4, 0xcfcbbe, 0xe9d2b6, 0xd2c09c,
  ],
  interwar: [
    0xe6e0d0, 0xdcd3bd, 0xd2ccbc, 0xe8dcc0, 0xcec3a9, 0xbfbaaf, 0xe4d4b4,
    0xd9d2c4, 0xd6c8a8, 0xc9c3b6,
  ],
  house: [0xf0ebe0, 0xe9dfc8, 0xe2d8c2, 0xede3cf, 0xd9cfbc, 0xe4d2b0, 0xe8e4da],
  panel: [0xdedcd4, 0xd4d3cc, 0xe6e2d6, 0xcacbc6, 0xe0dbcf, 0xd8d6cf],
  // Insulated, repainted panel houses of the 2000s are the rule in Prague.
  panelAccent: [0xe2c47a, 0xdca06e, 0xb0c0cb, 0xb8c79c, 0xd8b0aa, 0xcdb87d],
  industrial: [0xb7b1a6, 0xa9a49a, 0xc2bbae, 0x9e6f58, 0xb9ad98],
  sacred: [0xe6dcc6, 0xd9ccb0, 0xeee6d3],
};
const PALETTE = PALETTES.centre;
/** Same chainage bands as Route.area(). */
export function districtAt(s) {
  if (s < 4500) return "Břevnov";
  if (s < 7300) return "Hradčany";
  if (s < 9500) return "Malá Strana";
  if (s < 12000) return "Nové Město";
  if (s < 13500) return "Vinohrady";
  if (s < 16400) return "Vršovice";
  if (s < 18200) return "Strašnice";
  return "Hostivař";
}
function paletteFor({ district, style, type, levels, pitched, historic }) {
  if (style === "sacred") return PALETTES.sacred;
  if (style === "industrial" || /garage|shed|service/.test(type))
    return PALETTES.industrial;
  if (/^(house|detached|semidetached_house|terrace|farm)$/.test(type))
    return PALETTES.house;
  if (
    !historic &&
    !pitched &&
    levels >= 5 &&
    /^(residential|apartments|yes)$/.test(type)
  )
    return "panel";
  if (district === "Malá Strana" || district === "Hradčany")
    return historic ? PALETTES.baroque : PALETTES.interwar;
  if (district === "Nové Město") return PALETTES.centre;
  if (district === "Vinohrady") return PALETTES.vinohrady;
  return historic ? PALETTES.centre : PALETTES.interwar;
}
/**
 * Pitched roofs without an OSM colour: fired clay in the old town, a share
 * of dark sheet metal and fibre-cement on the 19th-century tenements. Tints
 * are relative weathering of the covering's average colour.
 */
function roofFor({ district, style, identity, type }) {
  const pick = (identity >>> 7) % 20;
  const clay = [0xffffff, 0xf6e1d2, 0xffeadc, 0xecd0bd, 0xf9dcc8];
  if (style === "sacred" || style === "industrial") return null;
  if (
    (district === "Malá Strana" || district === "Hradčany") &&
    style !== "modern"
  )
    return { kind: "roofRed", tint: clay[pick % clay.length] };
  if (/^(house|detached|semidetached_house|terrace|farm)$/.test(type))
    return pick < 14
      ? { kind: "roofRed", tint: clay[pick % clay.length] }
      : pick < 18
        ? { kind: "roof", tint: 0xf0e6dc }
        : { kind: "roofSlate", tint: 0xf2f2f2 };
  return pick < 11
    ? { kind: "roofRed", tint: clay[pick % clay.length] }
    : pick < 17
      ? { kind: "roofSlate", tint: pick % 2 ? 0xe2e6e6 : 0xffffff }
      : { kind: "roof", tint: 0xe2d4c8 };
}
// Neighbouring houses of one palette still differ in weathering and paint.
function weathered(color, identity) {
  const shift = (((identity >>> 11) % 9) - 4) * 0.012;
  const channel = (c) =>
    Math.round(Math.max(0, Math.min(255, c * (1 + shift))));
  return (
    (channel((color >> 16) & 255) << 16) |
    (channel((color >> 8) & 255) << 8) |
    channel(color & 255)
  );
}
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
  const district = districtAt(near.s ?? 0);
  const palette = paletteFor({
    district,
    style,
    type,
    levels,
    pitched,
    historic,
  });
  const districtColor =
    palette === "panel"
      ? identity % 5 < 2
        ? PALETTES.panelAccent[(identity >>> 3) % PALETTES.panelAccent.length]
        : PALETTES.panel[(identity >>> 3) % PALETTES.panel.length]
      : (palette ?? PALETTE)[identity % (palette ?? PALETTE).length];
  const wallColor = buildingColor(
    building.color,
    weathered(districtColor, identity),
  );
  const roofFinish = roofFor({ district, style, identity, type });
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
    district,
    panel: palette === "panel",
    roofKind: roofFinish?.kind ?? null,
    roofTint: roofFinish?.tint ?? null,
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
