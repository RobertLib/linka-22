import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Street lighting along line 22 by section, read from the street photographs
// used for the environment check (KartaView 2017–2025, Wikimedia Commons).
// Prague publishes no open inventory of luminaire types, so this is an
// observed approximation; mapped OSM lamps keep their real positions.
//   historic: cast-iron poles with lanterns (Klárov, Letenská, Malostranské
//             náměstí, Most Legií and the National Theatre);
//   suspended: luminaires hung on cross wires over Karmelitská and Újezd, and
//             over Národní, Spálená, Ječná and I. P. Pavlova;
//   modern: galvanised 9 m poles with an outreach arm everywhere else.
export const LAMP_SECTIONS = [
  { from: 0, to: 7750, style: "modern" },
  { from: 7750, to: 8560, style: "historic" },
  { from: 8560, to: 9380, style: "suspended" },
  { from: 9380, to: 9800, style: "historic" },
  { from: 9800, to: 12150, style: "suspended" },
  { from: 12150, to: Infinity, style: "modern" },
];

export function lampStyleAt(s) {
  return (
    LAMP_SECTIONS.find((section) => s >= section.from && s < section.to)
      ?.style ?? "modern"
  );
}

/** Pole, arm and LED head of a modern lamp; the arm reaches along +X. */
export function modernLampGeometry() {
  const height = 9,
    reach = 1.6;
  const pole = new THREE.CylinderGeometry(0.055, 0.09, height, 10, 1);
  pole.translate(0, height / 2, 0);
  const base = new THREE.CylinderGeometry(0.13, 0.15, 0.5, 10, 1);
  base.translate(0, 0.25, 0);
  // A slightly rising outreach arm and the flat luminaire at its end.
  const arm = new THREE.CylinderGeometry(0.035, 0.045, reach, 8, 1);
  arm.rotateZ(Math.PI / 2 - 0.12);
  arm.translate(reach / 2, height - 0.05 + Math.sin(0.12) * (reach / 2), 0);
  const head = new THREE.BoxGeometry(0.62, 0.11, 0.28);
  head.translate(reach + 0.22, height + 0.13, 0);
  const steel = mergeGeometries([pole, base, arm, head], false);
  const lens = new THREE.BoxGeometry(0.5, 0.02, 0.22);
  lens.translate(reach + 0.24, height + 0.07, 0);
  [pole, base, arm, head].forEach((geometry) => geometry.dispose());
  return { steel, lens, light: new THREE.Vector3(reach + 0.24, height, 0) };
}

/**
 * A luminaire hanging in the middle of a cross wire. The wire spans
 * `span` metres across the street (local X) at `height` above the street.
 */
export function suspendedLampGeometry(span, height = 7.6) {
  const wire = new THREE.CylinderGeometry(0.008, 0.008, span, 4, 1);
  wire.rotateZ(Math.PI / 2);
  wire.translate(0, height + 0.32, 0);
  const hanger = new THREE.CylinderGeometry(0.012, 0.012, 0.3, 4, 1);
  hanger.translate(0, height + 0.17, 0);
  const head = new THREE.CylinderGeometry(0.2, 0.26, 0.16, 12, 1);
  head.translate(0, height, 0);
  const steel = mergeGeometries([wire, hanger, head], false);
  const lens = new THREE.CylinderGeometry(0.22, 0.22, 0.02, 12, 1);
  lens.translate(0, height - 0.085, 0);
  [wire, hanger, head].forEach((geometry) => geometry.dispose());
  return { steel, lens, light: new THREE.Vector3(0, height - 0.1, 0) };
}
