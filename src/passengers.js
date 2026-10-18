// Passenger flows for one published trip. PID does not publish boardings per
// stop and departure, so the relative stop weights below are an original
// estimate from transfer hubs (metro, funicular, railway), destinations and
// the residential belt. The time-of-day curve follows the usual weekday
// peaks. Every count is deterministic for a trip, so the scene can show the
// same people who then board.

/** Relative demand at directional stops towards Nádraží Hostivař. */
export const STOP_WEIGHTS = Object.freeze({
  "Bílá Hora": 3,
  "Malý Břevnov": 1,
  "Obora Hvězda": 1.4,
  Vypich: 2,
  Říčanova: 0.5,
  "Břevnovský klášter": 1.4,
  "U Kaštanu": 1.2,
  Drinopol: 1.5,
  Marjánka: 1.2,
  Malovanka: 2,
  Pohořelec: 2.4,
  Brusnice: 1.1,
  "Pražský hrad": 3.4,
  "Královský letohrádek": 1.4,
  Malostranská: 5,
  "Malostranské náměstí": 3.4,
  "Pražské Jezulátko": 1.4,
  Újezd: 2.4,
  "Národní divadlo": 4,
  "Národní třída": 5,
  "Karlovo náměstí": 4.6,
  Štěpánská: 2,
  "I. P. Pavlova": 5,
  "Náměstí Míru": 4.6,
  "Jana Masaryka": 1.4,
  Krymská: 2,
  Ruská: 1.5,
  "Vršovické náměstí": 2.5,
  "Čechovo náměstí": 2,
  "Koh-i-noor": 1.2,
  "Slavia - Nádraží Eden": 2.4,
  "Kubánské náměstí": 2.5,
  Průběžná: 2,
  "Na Hroudě": 1.2,
  "Staré Strašnice": 2,
  Radošovická: 1,
  Dubečská: 0.5,
  "Nádraží Zahradní Město": 1.5,
  "Zahradní Město": 2.4,
  "Sídliště Zahradní Město": 2.4,
  "Obchodní centrum Hostivař": 2,
  "Na Groši": 1.2,
  Hostivařská: 1.5,
  "Nádraží Hostivař": 2,
});

/** Interchanges announced on arrival (PID line network). */
export const TRANSFERS = Object.freeze({
  Malostranská: "Přestup na metro A.",
  Újezd: "Přestup na lanovou dráhu na Petřín.",
  "Národní třída": "Přestup na metro B.",
  "Karlovo náměstí": "Přestup na metro B.",
  "I. P. Pavlova": "Přestup na metro C.",
  "Náměstí Míru": "Přestup na metro A.",
  "Nádraží Zahradní Město": "Přestup na vlaky.",
  "Nádraží Hostivař": "Přestup na vlaky.",
});

const hash = (text) => {
  let h = 2166136261;
  for (const c of String(text)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const random = (seed) => {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Demand multiplier for a service-day time, 1 = ordinary daytime. */
export function timeOfDayFactor(secondsOfDay, weekend = false) {
  const h = (((secondsOfDay / 3600) % 24) + 24) % 24;
  const bump = (center, width) => Math.exp(-(((h - center) / width) ** 2));
  if (weekend)
    return Math.max(0.15, 0.25 + 0.55 * bump(14, 4.5) + 0.25 * bump(19, 2.2));
  return Math.max(
    0.15,
    0.3 +
      1.05 * bump(7.6, 1.3) +
      0.45 * bump(12.5, 3.2) +
      0.9 * bump(16.4, 1.8),
  );
}

export function createPassengerDemand({
  stops,
  tripId = "free",
  times = null,
  clockStart = 0,
  weekend = false,
  capacity = 182,
} = {}) {
  const seed = hash(tripId);
  const factor = (i) => timeOfDayFactor(times?.[i] ?? clockStart, weekend);
  const last = stops.length - 1;
  const weight = (i) => STOP_WEIGHTS[stops[i]?.name] ?? 1.2;
  const boardingCache = new Map();
  const boarding = (i) => {
    if (i >= last) return 0;
    if (!boardingCache.has(i)) {
      const r = random(seed ^ hash(`on/${i}`));
      // Late trips and the outer stops carry few people towards the centre.
      const outbound = i > 30 ? 0.65 : 1;
      let on = Math.round(4.2 * weight(i) * factor(i) * outbound * (0.55 + r));
      if (
        stops[i]?.request &&
        random(seed ^ hash(`wait/${i}`)) > 0.25 + 0.3 * factor(i)
      )
        on = 0;
      boardingCache.set(i, Math.max(0, on));
    }
    return boardingCache.get(i);
  };
  const wantsToAlight = (i) =>
    !stops[i]?.request ||
    random(seed ^ hash(`bell/${i}`)) < 0.3 + 0.3 * factor(i);
  const alighting = (i, passengers) => {
    if (i >= last) return passengers;
    if (!wantsToAlight(i) || passengers <= 0) return 0;
    const r = random(seed ^ hash(`off/${i}`));
    const share = Math.min(0.55, (weight(i) / 13) * (0.65 + 0.7 * r));
    const off = Math.round(passengers * share);
    return Math.min(passengers, stops[i]?.request ? Math.max(1, off) : off);
  };
  return {
    capacity,
    boarding,
    alighting,
    /** People waiting on the platform before the tram arrives. */
    waiting: (i) => boarding(i),
    /** Whether a request stop (na znamení) must be served on this trip. */
    requested: (i) => !stops[i]?.request || boarding(i) > 0 || wantsToAlight(i),
    /** Six double doors on two T3 cars; alighting is quicker than boarding. */
    dwell: (on, off) =>
      Math.min(45, Math.max(8, 4.5 + (on * 1.25 + off * 0.8) / 3.2)),
  };
}
