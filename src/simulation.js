/**
 * Deterministic longitudinal tram and street-traffic simulation, in SI units.
 * Route position is the front of the player's tram. Speed limits are km/h;
 * getGrade(s) returns rise/run (0.04 is a 4 % uphill gradient).
 * No station, signal or speed-limit autopilot is applied to the player.
 */

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const moveTowards = (value, target, amount) =>
  value + clamp(target - value, -amount, amount);
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const clockText = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60) % 24}:${String(minutes % 60).padStart(2, "0")}`;
};
const unitVector = (value, fallback) => {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.z)) return fallback;
  const length = Math.hypot(value.x, value.z);
  return length > 1e-8
    ? { x: value.x / length, z: value.z / length }
    : fallback;
};
const STEP = 1 / 60;
const GRAVITY = 9.80665;
const STOP_TOLERANCE = 18;
const DOOR_SPEED = 0.12;
const RAIL_LABELS = Object.freeze({
  dry: "Suchá kolej",
  wet: "Mokrá kolej",
  leaves: "Listí na koleji",
  grease: "Znečištěná kolej",
});
const smoothstep = (value) => {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * Calibrated simulation assumptions, not unpublished DPP controller maps.
 * Motor power/empty mass/dimensions in TRAM_PROFILES are published DPP data.
 * All forces below are at the wheel/rail contact, per powered car.
 */
export const PHYSICS = Object.freeze({
  rotatingMassFactor: 1.07,
  passengerMass: 75,
  tractionForcePerCar: 26000,
  serviceBrakeForcePerCar: 32000,
  emergencyWheelForcePerCar: 40000,
  railBrakeForcePerCar: 20000,
  dynamicBrakePowerFactor: 2,
  dynamicBrakeFadeSpeed: 1.8,
  tractionJerk: 0.7,
  brakeJerk: 0.9,
  emergencyJerk: 4.5,
  railBrakeDeploymentSeconds: 0.2,
  dryAdhesion: 0.23,
  wetAdhesion: 0.085,
  sandedWetAdhesion: 0.15,
  sandedDryAdhesion: 0.26,
  dryLeafAdhesion: 0.1,
  wetLeafAdhesion: 0.035,
  greaseAdhesion: 0.045,
  sandedLeafAdhesion: 0.13,
  sandedGreaseAdhesion: 0.11,
  railWettingSeconds: 18,
  railDryingSeconds: 300,
  frictionHeatCapacityPerCar: 100000,
  frictionCoolingPerCar: 180,
  frictionAirCoolingPerCar: 25,
  resistorHeatCapacityPerCar: 180000,
  resistorCoolingPerCar: 600,
  resistorAirCoolingPerCar: 30,
  frictionFadeStartC: 300,
  frictionFadeRangeC: 400,
  rollingCoefficient: 0.0022,
  linearResistancePerCar: 18,
  aerodynamicCoefficient: 3.4,
  curveResistanceCoefficient: 0.45,
  tractionEfficiency: 0.88,
  regenerativeEfficiency: 0.72,
  copperLossPerCar: 6500,
  auxiliaryPowerPerCar: 2500,
  lineVoltage: 600,
});

export const TRAM_PROFILES = Object.freeze({
  "T3R.P": Object.freeze({
    name: "Tatra T3R.P",
    mass: 17300,
    power: 160000,
    length: 15.104,
    width: 2.5,
    maxSpeedKmh: 65,
    capacity: 91,
  }),
  "15T": Object.freeze({
    name: "Škoda 15T",
    mass: 43800,
    power: 745600,
    length: 31.4,
    width: 2.46,
    maxSpeedKmh: 60,
    capacity: 199,
  }),
});

/** Shared clock for the scene's white tram-signal bars and traffic AI. */
export function getSignalAspect(signal, time) {
  if (signal.aspect === "stop" || signal.aspect === "go") return signal.aspect;
  const period = Math.max(4, finite(signal.period, 48));
  const phase =
    (((time + finite(signal.offset, 0)) % period) + period) % period;
  const goDuration = clamp(finite(signal.goDuration, period * 0.46), 0, period);
  return phase < goDuration ? "go" : "stop";
}

export class TramSimulation {
  constructor(config = {}) {
    this.config = { ...config };
    this.routeLength = Math.max(1, finite(config.routeLength, 10000));
    this.profile = TRAM_PROFILES[config.profile] || TRAM_PROFILES["T3R.P"];
    const carCount = clamp(Math.round(finite(config.carCount, 1)), 1, 2);
    this.carCount = carCount;
    this.vehicleMass = this.profile.mass * carCount;
    this.vehiclePower = this.profile.power * carCount;
    this.vehicleLength = this.profile.length * carCount;
    const forceScale = this.vehicleMass / TRAM_PROFILES["T3R.P"].mass;
    this.maxTractionForceN = PHYSICS.tractionForcePerCar * forceScale;
    this.maxServiceBrakeForceN = PHYSICS.serviceBrakeForcePerCar * forceScale;
    this.maxEmergencyWheelForceN =
      PHYSICS.emergencyWheelForcePerCar * forceScale;
    this.maxRailBrakeForceN = PHYSICS.railBrakeForcePerCar * forceScale;
    this.capacity = this.profile.capacity * carCount;
    this.stops = (config.stops || [])
      .map((stop, index) => ({
        ...stop,
        name: stop.name || `Zastávka ${index + 1}`,
        s: finite(stop.s, 0),
        side: stop.side || "right",
      }))
      .sort((a, b) => a.s - b.s);
    this.signals = (config.signals || [])
      .map((signal, index) => ({
        ...signal,
        id: signal.id || `signal-${index}`,
        s: finite(signal.s, 0),
      }))
      .sort((a, b) => a.s - b.s);
    this.getGrade =
      typeof config.getGrade === "function" ? config.getGrade : () => 0;
    // A signed radius conveys turn direction; Infinity means straight track.
    this.getCurveRadius =
      typeof config.getCurveRadius === "function"
        ? config.getCurveRadius
        : () => Infinity;
    // Authored local conditions, never a randomly triggered brake failure.
    this.railConditions = (config.railConditions || [])
      .filter(
        (zone) =>
          Number.isFinite(zone.startS) &&
          Number.isFinite(zone.endS) &&
          zone.endS > zone.startS &&
          ["wet", "leaves", "grease"].includes(zone.condition),
      )
      .map((zone) => ({
        ...zone,
        severity: clamp(finite(zone.severity, 1), 0, 1),
        transitionMeters: Math.max(0.1, finite(zone.transitionMeters, 8)),
      }))
      .sort((a, b) => a.startS - b.startS);
    this.getRailCondition =
      typeof config.getRailCondition === "function"
        ? config.getRailCondition
        : null;
    this.ambientTemperatureC = clamp(
      finite(config.ambientTemperatureC, 18),
      -30,
      45,
    );
    this.regenerationReceptivity = clamp(
      finite(config.regenerationReceptivity, 0.6),
      0,
      1,
    );
    this.getSpeedLimit =
      typeof config.getSpeedLimit === "function"
        ? config.getSpeedLimit
        : () => 50;
    this.baseDwellRequired = Math.max(3, finite(config.dwellRequired, 8));
    this.dwellRequired = this.baseDwellRequired;
    // Optional flows of one trip: boarding, alighting, dwell and requests at
    // request stops. Without them the original fixed boarding model applies.
    this.passengerDemand = config.passengerDemand ?? null;
    this.reset(config);
  }

  reset(options = {}) {
    this.mode =
      options.mode === "free"
        ? "free"
        : options.mode === "service"
          ? "service"
          : this.config.mode || "service";
    this.weather =
      options.weather === "rain"
        ? "rain"
        : options.weather === "clear"
          ? "clear"
          : this.config.weather || "clear";
    this.s = clamp(
      finite(options.startS, finite(this.config.startS, 0)),
      0,
      this.routeLength,
    );
    this.speed = Math.max(0, finite(options.speed, 0));
    this.acceleration = 0;
    this.throttle = 0;
    // A new/resumed service starts secured; selecting coast explicitly releases
    // this parking brake. Coast never silently applies a brake on a descent.
    this.parkingBrake = this.speed === 0 && options.parkingBrake !== false;
    this.sanding = false;
    this.wheelSlip = 0;
    this.railWetness = clamp(
      finite(options.railWetness, this.weather === "rain" ? 1 : 0),
      0,
      1,
    );
    this._sandEffect = 0;
    this._driveForce = this.parkingBrake ? -this.maxServiceBrakeForceN : 0;
    this.tractionForceN = 0;
    this.electricBrakeForceN = 0;
    this.mechanicalBrakeForceN = 0;
    this.railBrakeForceN = 0;
    this._railBrakeProgress = 0;
    this.resistanceForceN = 0;
    this.gradeForceN = 0;
    this.powerKW = 0;
    this.brakePowerKW = 0;
    this.tractionCurrentA = 0;
    this.brakeCurrentA = 0;
    this.lineCurrentA = 0;
    this.consumptionKWh = Math.max(0, finite(options.consumptionKWh, 0));
    this.regeneratedKWh = Math.max(0, finite(options.regeneratedKWh, 0));
    this.resistorHeatKWh = Math.max(0, finite(options.resistorHeatKWh, 0));
    this.mechanicalBrakeHeatKWh = Math.max(
      0,
      finite(options.mechanicalBrakeHeatKWh, 0),
    );
    this.brakeTemperatureC = clamp(
      finite(options.brakeTemperatureC, this.ambientTemperatureC),
      this.ambientTemperatureC,
      1000,
    );
    this.resistorTemperatureC = clamp(
      finite(options.resistorTemperatureC, this.ambientTemperatureC),
      this.ambientTemperatureC,
      1000,
    );
    this.damage = clamp(finite(options.damage, 0), 0, 100);
    this.collisionEnergyKJ = Math.max(0, finite(options.collisionEnergyKJ, 0));
    this.lastCollisionImpact = null;
    this.impactShake = 0;
    this._impactElapsed = 0;
    this.lateralAccel = 0;
    this.chassisRoll = 0;
    this.chassisPitch = 0;
    this.rideShake = 0;
    this._rollVelocity = 0;
    this.passengerSway = { longitudinal: 0, lateral: 0 };
    this._swayVelocity = { longitudinal: 0, lateral: 0 };
    this.jerk = 0;
    this._filteredJerk = 0;
    this.comfortStress = 0;
    this.comfortDose = Math.max(0, finite(options.comfortDose, 0));
    this.drivingSeconds = Math.max(0, finite(options.drivingSeconds, 0));
    this.comfortRating = clamp(
      100 - (this.comfortDose / Math.max(20, this.drivingSeconds)) * 65,
      0,
      100,
    );
    this._comfortExposure = 0;
    this._brakingCache = null;
    this.doors = false;
    this.doorProgress = 0;
    this.doorSide = "right";
    this.passengers = clamp(
      Math.round(finite(options.passengers, 28)),
      0,
      this.capacity,
    );
    const inferredStop = this.stops.findIndex(
      (stop) => stop.s >= this.s - STOP_TOLERANCE,
    );
    const initialStop = finite(
      options.startStopIndex,
      finite(
        this.config.startStopIndex,
        inferredStop < 0 ? this.stops.length : inferredStop,
      ),
    );
    this.nextStopIndex = clamp(Math.floor(initialStop), 0, this.stops.length);
    this.score = finite(options.score, 1000);
    this.violations = Object.fromEntries(
      [
        "redSignals",
        "speeding",
        "missedStops",
        "unsafeDoors",
        "harshBraking",
        "roughRide",
        "collisions",
        "earlyDepartures",
      ].map((key) => [
        key,
        Math.max(0, Math.floor(finite(options.violations?.[key], 0))),
      ]),
    );
    this.time = Math.max(0, finite(options.time, 0));
    if (options.passengerDemand !== undefined)
      this.passengerDemand = options.passengerDemand;
    // Optional published trip: departure seconds of the service day per stop.
    // Without it the simulator runs untimed, as in free or test operation.
    const schedule = options.schedule ?? this.config.schedule;
    this.schedule = Array.isArray(schedule)
      ? this.stops.map((_, i) =>
          Number.isFinite(schedule[i]) ? schedule[i] : null,
        )
      : null;
    this.clockStart = finite(
      options.clockStart,
      finite(this.config.clockStart, 0),
    );
    this.punctualDepartures = Math.max(
      0,
      Math.floor(finite(options.punctualDepartures, 0)),
    );
    this.lastDeparture = null;
    this._pendingDeparture = null;
    this.finished = Boolean(options.finished);
    this.emergency = false;
    const savedStop = this.stops[this.nextStopIndex];
    const sameBoardingStop = Boolean(
      savedStop &&
      options.boardingStopIndex === this.nextStopIndex &&
      Math.abs(savedStop.s - this.s) <= STOP_TOLERANCE,
    );
    this.dwellRequired = sameBoardingStop
      ? clamp(
          finite(options.dwellRequired, this.baseDwellRequired),
          this.baseDwellRequired,
          60,
        )
      : this.baseDwellRequired;
    this.dwell = sameBoardingStop
      ? clamp(finite(options.dwell, 0), 0, this.dwellRequired)
      : 0;
    this.boarding = this.dwell / this.dwellRequired;
    this.completedStops = Math.max(
      0,
      Math.floor(
        finite(
          options.completedStops,
          this.nextStopIndex - this._initialStopIndex(options),
        ),
      ),
    );
    this.serviceState = this.finished ? "finished" : "approaching";
    this._stopBoarded = sameBoardingStop && options.stopBoarded === true;
    if (this._stopBoarded) {
      this.dwell = this.dwellRequired;
      this.boarding = 1;
    }
    this._boardingPlan = null;
    this._messageText = "";
    this._messageTimer = 0;
    this._overspeedTime = 0;
    this._overspeedEpisode = false;
    this._comfortEpisode = false;
    this._signalsCrossed = new Set();
    this._doorAttemptCooldown = 0;
    this._collisionCooldown = 0;
    this._collisionCooldowns = new Map();
    this._refreshServiceState();
    return this;
  }

  _initialStopIndex(options) {
    return Math.max(
      0,
      Math.floor(
        finite(options.startStopIndex, finite(this.config.startStopIndex, 0)),
      ),
    );
  }

  setWeather(weather) {
    this.weather = weather === "rain" ? "rain" : "clear";
    this._brakingCache = null;
    return this.weather;
  }

  setSanding(active) {
    this.sanding = Boolean(active);
    this._brakingCache = null;
    return this.sanding;
  }

  setController(value) {
    this.throttle = clamp(finite(value, 0), -1, 1);
    if (this.parkingBrake) this._driveForce = 0;
    this.parkingBrake = false;
    this._brakingCache = null;
    if (this.emergency && this.speed < DOOR_SPEED && this.throttle <= 0) {
      this.emergency = false;
      this._setMessage(
        "Nouzová brzda uvolněna. Před rozjezdem zkontrolujte trať.",
        4,
      );
    }
    return this.throttle;
  }

  emergencyBrake() {
    if (!this.emergency && this.speed > 2) {
      this.violations.harshBraking += 1;
      this.score -= 15;
    }
    this.emergency = true;
    this.throttle = -1;
    this._setMessage("Nouzová brzda! Po zastavení vraťte řadič do výběhu.", 5);
  }

  releaseEmergencyBrake() {
    if (this.speed >= DOOR_SPEED) return false;
    this.emergency = false;
    this.throttle = 0;
    this.acceleration = 0;
    this._driveForce = 0;
    return true;
  }

  toggleDoors(side = "right") {
    if (this.finished) return false;
    if (this.speed > DOOR_SPEED) {
      if (this._doorAttemptCooldown <= 0) {
        this.violations.unsafeDoors += 1;
        this.score -= 10;
        this._doorAttemptCooldown = 3;
      }
      this._setMessage(
        "Dveře jsou blokované za jízdy. Nejdřív úplně zastavte.",
        4,
      );
      return false;
    }
    this.speed = 0;
    this.acceleration = 0;
    this.doors = !this.doors;
    if (this.doors) {
      this.doorSide = side === "left" ? "left" : "right";
      const stop = this.stops[this.nextStopIndex];
      if (
        stop &&
        Math.abs(stop.s - this.s) <= STOP_TOLERANCE &&
        !this._correctSide(stop)
      ) {
        this.violations.unsafeDoors += 1;
        this.score -= 30;
        this._setMessage(
          "Dveře na nesprávné straně nástupiště. Zavřete je.",
          5,
        );
      } else if (!stop || Math.abs(stop.s - this.s) > STOP_TOLERANCE) {
        this._setMessage("Mimo nástupiště: nástup cestujících není možný.", 4);
      } else {
        this._setMessage(`${stop.name}: probíhá otevírání dveří.`, 2);
      }
    } else if (!this._stopBoarded && this.dwell > 0) {
      this.dwell = 0;
      this.boarding = 0;
      this._boardingPlan = null;
      this.dwellRequired = this.baseDwellRequired;
      this._setMessage("Nástup nebyl dokončen. Znovu otevřete dveře.", 4);
    }
    return true;
  }

  /**
   * Called by the scene for a closing contact, never a speculative warning.
   * World vectors use x/z; the normal points from the tram toward the other
   * body. The tram is constrained to its track tangent. The boolean return is
   * retained for callers; lastCollisionImpact carries the resolved impulse.
   */
  reportCollision(impact = 1) {
    if (this.finished) return false;
    const details = typeof impact === "object" && impact ? impact : {};
    const continuingContact = details.continuingContact === true;
    const contactId =
      typeof details.contactId === "string" ||
      typeof details.contactId === "number"
        ? String(details.contactId)
        : null;
    if (
      !continuingContact &&
      (contactId === null
        ? this._collisionCooldown > 0
        : (this._collisionCooldowns.get(contactId) ?? 0) > this.time)
    )
      return false;
    const severity = clamp(
      finite(details.severity, typeof impact === "number" ? impact : 1),
      0.1,
      3,
    );
    const otherMass = Math.max(1, finite(details.otherMass, 1500));
    const otherSpeed = finite(details.otherSpeed, 0);
    const restitution = clamp(finite(details.restitution, 0.05), 0, 1);
    const fraction = clamp(finite(details.impactFraction, severity), 0, 1);
    const mass = this._mass();
    const tangent = unitVector(details.tramDirection, { x: 0, z: 1 });
    const normal = unitVector(details.contactNormal, tangent);
    const otherVelocity = {
      x: finite(details.otherVelocity?.x, tangent.x * otherSpeed),
      z: finite(details.otherVelocity?.z, tangent.z * otherSpeed),
    };
    const inverseInertia =
      Number.isFinite(details.otherInertia) && details.otherInertia > 1e-8
        ? 1 / details.otherInertia
        : 0;
    const angularVelocity = inverseInertia
      ? finite(details.otherAngularVelocity, 0)
      : 0;
    const offset = {
      x: finite(details.contactOffset?.x, 0),
      z: finite(details.contactOffset?.z, 0),
    };
    // Positive yaw about Y gives contact velocity (omega * rz, -omega * rx).
    const lever = offset.z * normal.x - offset.x * normal.z;
    const coupling = normal.x * tangent.x + normal.z * tangent.z;
    const beforeSpeed = this.speed;
    const closingSpeed =
      beforeSpeed * coupling -
      otherVelocity.x * normal.x -
      otherVelocity.z * normal.z -
      angularVelocity * lever;
    // A resting overlap or a car already pulling away is not another impact.
    if (closingSpeed <= 0.025 || fraction === 0) return false;
    const otherInverseMass = 1 / otherMass + lever ** 2 * inverseInertia;
    const inverseMass = coupling ** 2 / mass + otherInverseMass;
    let impulse = ((1 + restitution) * closingSpeed * fraction) / inverseMass;
    // The longitudinal simulator cannot reverse. If a much heavier opposing
    // vehicle would push it backwards, the track constraint holds it at zero;
    // recompute the car impulse rather than adding energy through a speed clamp.
    if (coupling > 0 && beforeSpeed - (impulse * coupling) / mass < 0)
      impulse =
        ((1 + restitution) * closingSpeed * fraction - beforeSpeed * coupling) /
        otherInverseMass;
    const afterSpeed = Math.max(0, beforeSpeed - (impulse * coupling) / mass);
    const impulseVector = { x: normal.x * impulse, z: normal.z * impulse };
    const afterVelocity = {
      x: otherVelocity.x + impulseVector.x / otherMass,
      z: otherVelocity.z + impulseVector.z / otherMass,
    };
    const afterAngularVelocity =
      angularVelocity + impulse * lever * inverseInertia;
    const rotationalEnergyLoss = inverseInertia
      ? (angularVelocity ** 2 - afterAngularVelocity ** 2) /
        (2 * inverseInertia)
      : 0;
    // Account for actual translational and rotational velocities, including
    // partial/glancing impulses. Off-center hits cannot create extra energy.
    const dissipated = Math.max(
      0,
      0.5 * mass * (beforeSpeed ** 2 - afterSpeed ** 2) +
        0.5 *
          otherMass *
          (otherVelocity.x ** 2 +
            otherVelocity.z ** 2 -
            afterVelocity.x ** 2 -
            afterVelocity.z ** 2) +
        rotationalEnergyLoss,
    );
    if (!continuingContact) {
      if (contactId === null) this._collisionCooldown = 3;
      else this._collisionCooldowns.set(contactId, this.time + 0.25);
      this.violations.collisions += 1;
      this.score -= Math.round(120 * severity);
    }
    this.speed = afterSpeed;
    this.lastCollisionImpact = {
      contactId,
      continuingContact,
      time: this.time,
      impulseNs: impulse,
      impulse: impulseVector,
      contactNormal: normal,
      closingSpeed,
      dissipatedEnergyKJ: dissipated / 1000,
      tramSpeedBefore: beforeSpeed,
      tramSpeedAfter: afterSpeed,
      deltaSpeedMps: afterSpeed - beforeSpeed,
      otherVelocityBefore: otherVelocity,
      otherVelocityAfter: afterVelocity,
      otherAngularVelocityBefore: angularVelocity,
      otherAngularVelocityAfter: afterAngularVelocity,
    };
    this.collisionEnergyKJ += dissipated / 1000;
    this.damage = clamp(this.damage + dissipated / 10000, 0, 100);
    this.impactShake = Math.max(
      this.impactShake,
      clamp(Math.sqrt(dissipated) / 6000, 0.002, 0.065),
    );
    if (!continuingContact) this._impactElapsed = 0;
    this.rideShake += this.impactShake;
    this.chassisPitch = clamp(
      this.chassisPitch + (afterSpeed - beforeSpeed) * 0.009,
      -0.07,
      0.07,
    );
    this._rollVelocity +=
      ((impulseVector.x * tangent.z - impulseVector.z * tangent.x) / mass) *
      0.025;
    if (!continuingContact) {
      this.emergency = true;
      this.throttle = -1;
      this._setMessage("Střet s vozidlem. Zastavte a zajistěte tramvaj.", 7);
    }
    this.acceleration = 0;
    this._brakingCache = null;
    return true;
  }

  _mass() {
    return this.vehicleMass + this.passengers * PHYSICS.passengerMass;
  }

  _radius(s = this.s) {
    const radius = this.getCurveRadius(s);
    return Number.isFinite(radius) && Math.abs(radius) >= 10
      ? radius
      : Infinity;
  }

  _railAt(s, sandEffect, wetness) {
    let condition = wetness > 0.12 ? "wet" : "dry";
    let label = RAIL_LABELS[condition];
    let severity = 0;
    let localWetness = wetness;
    const consider = (zone, strength = zone?.severity) => {
      if (!zone || !["wet", "leaves", "grease"].includes(zone.condition))
        return;
      const amount = clamp(finite(strength, 1), 0, 1);
      if (zone.condition === "wet") {
        localWetness = Math.max(localWetness, amount);
        if (severity === 0 && localWetness > 0.12) {
          condition = "wet";
          label = zone.label || RAIL_LABELS.wet;
        }
      } else if (amount > severity) {
        condition = zone.condition;
        severity = amount;
        label = zone.label || RAIL_LABELS[condition];
      }
    };
    for (const zone of this.railConditions) {
      if (s < zone.startS || s > zone.endS) continue;
      const transition = Math.min(
        zone.transitionMeters,
        (zone.endS - zone.startS) / 2,
      );
      const edge = Math.min(s - zone.startS, zone.endS - s);
      consider(zone, zone.severity * smoothstep(edge / transition));
    }
    if (this.getRailCondition) {
      const local = this.getRailCondition(s, {
        weather: this.weather,
        time: this.time,
        railWetness: wetness,
      });
      consider(typeof local === "string" ? { condition: local } : local);
    }
    let base =
      PHYSICS.dryAdhesion +
      (PHYSICS.wetAdhesion - PHYSICS.dryAdhesion) * localWetness;
    let sanded =
      PHYSICS.sandedDryAdhesion +
      (PHYSICS.sandedWetAdhesion - PHYSICS.sandedDryAdhesion) * localWetness;
    if (severity > 0) {
      const contaminated =
        condition === "leaves"
          ? PHYSICS.dryLeafAdhesion +
            (PHYSICS.wetLeafAdhesion - PHYSICS.dryLeafAdhesion) * localWetness
          : PHYSICS.greaseAdhesion;
      const treated =
        condition === "leaves"
          ? PHYSICS.sandedLeafAdhesion
          : PHYSICS.sandedGreaseAdhesion;
      base += (Math.min(base, contaminated) - base) * severity;
      sanded += (Math.min(sanded, treated) - sanded) * severity;
    }
    return {
      coefficient: base + (sanded - base) * sandEffect,
      condition,
      label,
      severity,
      wetness: localWetness,
    };
  }

  _railState(
    s = this.s,
    sandEffect = this._sandEffect,
    wetness = this.railWetness,
  ) {
    let coefficient = 0;
    let strongest = null;
    // Two representative bogie contacts per car: entering a short patch does
    // not instantaneously give the entire coupled tram the same adhesion.
    for (let car = 0; car < this.carCount; car++) {
      for (const fraction of [0.2, 0.8]) {
        const point = s - this.profile.length * (car + fraction);
        const rail = this._railAt(point, sandEffect, wetness);
        coefficient += rail.coefficient / (this.carCount * 2);
        if (
          !strongest ||
          rail.severity > strongest.severity ||
          (rail.severity === strongest.severity &&
            rail.wetness > strongest.wetness)
        )
          strongest = rail;
      }
    }
    return { ...strongest, coefficient };
  }

  _adhesion(
    mass,
    s = this.s,
    sandEffect = this._sandEffect,
    wetness = this.railWetness,
  ) {
    return mass * GRAVITY * this._railState(s, sandEffect, wetness).coefficient;
  }

  _frictionBrakeFactor(temperature = this.brakeTemperatureC) {
    return (
      1 -
      0.55 *
        clamp(
          (temperature - PHYSICS.frictionFadeStartC) /
            PHYSICS.frictionFadeRangeC,
          0,
          1,
        )
    );
  }

  _temperatureStep(temperature, power, speed, dt, resistor = false) {
    const capacity = resistor
      ? PHYSICS.resistorHeatCapacityPerCar
      : PHYSICS.frictionHeatCapacityPerCar;
    const cooling = resistor
      ? PHYSICS.resistorCoolingPerCar + PHYSICS.resistorAirCoolingPerCar * speed
      : PHYSICS.frictionCoolingPerCar +
        PHYSICS.frictionAirCoolingPerCar * speed;
    const scale = this.vehicleMass / TRAM_PROFILES["T3R.P"].mass;
    // Exact first-order heat balance for constant work/cooling in a substep.
    const equilibrium = this.ambientTemperatureC + power / (cooling * scale);
    return (
      equilibrium +
      (temperature - equilibrium) * Math.exp((-cooling * dt) / capacity)
    );
  }

  _resistance(speed, mass, s = this.s) {
    if (speed < 1e-6) return 0;
    const radius = this._radius(s);
    const curve = Number.isFinite(radius)
      ? (mass * GRAVITY * PHYSICS.curveResistanceCoefficient) / Math.abs(radius)
      : 0;
    return (
      mass * GRAVITY * PHYSICS.rollingCoefficient +
      this.carCount * PHYSICS.linearResistancePerCar * speed +
      PHYSICS.aerodynamicCoefficient *
        (1 + (this.carCount - 1) * 0.2) *
        speed ** 2 +
      curve
    );
  }

  /** Available motor force before wheel-slip limiting (N). */
  getAvailableTractionForce(speed = this.speed) {
    if (speed >= this.profile.maxSpeedKmh / 3.6) return 0;
    const damageFactor = 1 - 0.45 * clamp((this.damage - 30) / 70, 0, 1);
    return (
      Math.min(
        this.maxTractionForceN,
        this.vehiclePower / Math.max(speed, 0.1),
      ) * damageFactor
    );
  }

  _brakeForces(
    speed,
    demand,
    mass,
    emergency = false,
    {
      s = this.s,
      wetness = this.railWetness,
      temperature = this.brakeTemperatureC,
    } = {},
  ) {
    const fade = clamp(speed / PHYSICS.dynamicBrakeFadeSpeed, 0, 1);
    const edLimit =
      Math.min(
        this.maxServiceBrakeForceN,
        (this.vehiclePower * PHYSICS.dynamicBrakePowerFactor) /
          Math.max(speed, 0.1),
      ) * fade;
    const electric = Math.min(demand * fade, edLimit);
    // Friction brakes take over as the motors lose electromotive force. Under
    // emergency braking they supplement the motors at every speed.
    const mechanical =
      Math.max(0, demand - electric) * this._frictionBrakeFactor(temperature);
    const wheelDemand = electric + mechanical;
    const adhesion = this._adhesion(mass, s, this._sandEffect, wetness);
    const antiSkidFactor = wheelDemand > adhesion ? 0.96 : 1;
    const wheelForce = Math.min(wheelDemand, adhesion) * antiSkidFactor;
    const scale = wheelDemand > 0 ? wheelForce / wheelDemand : 0;
    const rail = emergency ? this.maxRailBrakeForceN * (1 - 0.1 * wetness) : 0;
    return {
      electric: electric * scale,
      mechanical: mechanical * scale,
      rail,
      wheelSlip:
        wheelDemand > 0
          ? clamp((wheelDemand - adhesion) / wheelDemand, 0, 1)
          : 0,
    };
  }

  /** Full brake projection with force build-up and gradient along the path. */
  getBrakingDistance({
    emergency = false,
    reactionTime = emergency ? 0 : 0.8,
  } = {}) {
    if (this.speed <= 0) return 0;
    const mass = this._mass();
    const inertia = mass * PHYSICS.rotatingMassFactor;
    const grade = clamp(finite(this.getGrade(this.s), 0), -0.14, 0.14);
    let speed = this.speed;
    let distance = 0;
    let force = this._driveForce;
    let railProgress = this._railBrakeProgress;
    let brakeTemperature = this.brakeTemperatureC;
    let wetness = this.railWetness;
    const target = -(emergency
      ? this.maxEmergencyWheelForceN
      : this.maxServiceBrakeForceN);
    const ramp =
      inertia * (emergency ? PHYSICS.emergencyJerk : PHYSICS.brakeJerk);
    const integrate = (step, force, applyRailBrake) => {
      const projectedS = Math.min(this.routeLength, this.s + distance);
      const targetWetness = this.weather === "rain" ? 1 : 0;
      const wetnessSeconds =
        targetWetness > wetness
          ? PHYSICS.railWettingSeconds
          : PHYSICS.railDryingSeconds;
      wetness +=
        (targetWetness - wetness) * (1 - Math.exp(-step / wetnessSeconds));
      railProgress = moveTowards(
        railProgress,
        applyRailBrake ? 1 : 0,
        step / PHYSICS.railBrakeDeploymentSeconds,
      );
      const brake = this._brakeForces(
        speed,
        Math.max(0, -force),
        mass,
        applyRailBrake,
        { s: projectedS, wetness, temperature: brakeTemperature },
      );
      brake.rail *= railProgress;
      const traction = Math.max(
        0,
        Math.min(
          force,
          this.getAvailableTractionForce(speed),
          this._adhesion(mass, projectedS, this._sandEffect, wetness),
        ),
      );
      const projectedGrade = clamp(
        finite(this.getGrade(projectedS), grade),
        -0.14,
        0.14,
      );
      const gravityForce =
        (mass * GRAVITY * projectedGrade) / Math.sqrt(1 + projectedGrade ** 2);
      const acceleration =
        (traction -
          brake.electric -
          brake.mechanical -
          brake.rail -
          gravityForce -
          this._resistance(speed, mass, projectedS)) /
        inertia;
      const next = Math.max(0, speed + acceleration * step);
      brakeTemperature = this._temperatureStep(
        brakeTemperature,
        brake.mechanical * (speed + next) * 0.5,
        (speed + next) * 0.5,
        step,
      );
      distance += (speed + next) * 0.5 * step;
      speed = next;
    };
    // During driver reaction, the current motor/brake force remains applied.
    // Gravity on a descent can therefore lengthen both phases of the stop.
    let reactionRemaining = clamp(
      finite(reactionTime, emergency ? 0 : 0.8),
      0,
      10,
    );
    while (reactionRemaining > 1e-9 && speed > 0.001) {
      const step = Math.min(0.08, reactionRemaining);
      integrate(step, force, this.emergency);
      reactionRemaining -= step;
    }
    for (let elapsed = 0; elapsed < 180 && speed > 0.001; elapsed += 0.08) {
      force = moveTowards(force, target, ramp * 0.08);
      integrate(0.08, force, emergency);
    }
    // A sufficiently steep/low-adhesion descent may exceed the service brake.
    return speed > 0.001 ? Infinity : distance;
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return this.getSnapshot();
    let remaining = dt;
    while (remaining > 1e-9) {
      const step = Math.min(STEP, remaining);
      this._step(step);
      remaining -= step;
    }
    return this.getSnapshot();
  }

  _step(dt) {
    this.time += dt;
    this._messageTimer = Math.max(0, this._messageTimer - dt);
    this._doorAttemptCooldown = Math.max(0, this._doorAttemptCooldown - dt);
    this._collisionCooldown = Math.max(0, this._collisionCooldown - dt);
    for (const [contactId, until] of this._collisionCooldowns)
      if (until <= this.time) this._collisionCooldowns.delete(contactId);
    this._impactElapsed += dt;
    this.impactShake *= Math.exp(-5 * dt);
    this.doorProgress = moveTowards(
      this.doorProgress,
      this.doors ? 1 : 0,
      dt / (this.doors ? 1.25 : 1.6),
    );
    if (this.doorProgress < 1e-8) this.doorProgress = 0;
    if (this.doorProgress > 1 - 1e-8) this.doorProgress = 1;

    const previousS = this.s;
    const previousAcceleration = this.acceleration;
    const grade = clamp(finite(this.getGrade(this.s), 0), -0.14, 0.14);
    const mass = this._mass();
    const inertia = mass * PHYSICS.rotatingMassFactor;
    const doorInterlock = this.doors || this.doorProgress > 1e-6;
    const secured = doorInterlock || this.finished || this.parkingBrake;
    const targetWetness = this.weather === "rain" ? 1 : 0;
    const wetnessSeconds =
      targetWetness > this.railWetness
        ? PHYSICS.railWettingSeconds
        : PHYSICS.railDryingSeconds;
    this.railWetness +=
      (targetWetness - this.railWetness) * (1 - Math.exp(-dt / wetnessSeconds));
    this._sandEffect = moveTowards(
      this._sandEffect,
      this.sanding ? 1 : 0,
      dt * (this.sanding ? 2 : 0.5),
    );
    let demand =
      this.throttle > 0
        ? this.throttle * this.getAvailableTractionForce()
        : this.throttle * this.maxServiceBrakeForceN;
    if (this.emergency) demand = -this.maxEmergencyWheelForceN;
    if (secured) demand = -this.maxServiceBrakeForceN;
    const jerk = this.emergency
      ? PHYSICS.emergencyJerk
      : demand < this._driveForce
        ? PHYSICS.brakeJerk
        : PHYSICS.tractionJerk;
    this._driveForce = moveTowards(
      this._driveForce,
      demand,
      inertia * jerk * dt,
    );
    if (secured && this.speed < 0.025) this._driveForce = 0;
    const adhesion = this._adhesion(mass);
    const tractionDemand =
      secured || this.emergency ? 0 : Math.max(0, this._driveForce);
    const forceSpeed = this.speed + Math.max(0, this.acceleration) * dt * 0.5;
    this.tractionForceN = Math.min(
      tractionDemand,
      this.getAvailableTractionForce(forceSpeed),
      adhesion,
    );
    const brake = this._brakeForces(
      this.speed,
      Math.max(0, -this._driveForce),
      mass,
      this.emergency,
    );
    this._railBrakeProgress = moveTowards(
      this._railBrakeProgress,
      this.emergency ? 1 : 0,
      dt / PHYSICS.railBrakeDeploymentSeconds,
    );
    brake.rail *= this._railBrakeProgress;
    if (secured && this.speed < 0.025)
      brake.mechanical = this.maxServiceBrakeForceN;
    this.electricBrakeForceN = brake.electric;
    this.mechanicalBrakeForceN = brake.mechanical;
    this.railBrakeForceN = brake.rail;
    const slip =
      tractionDemand > 0
        ? clamp((tractionDemand - adhesion) / tractionDemand, 0, 1)
        : brake.wheelSlip;
    this.wheelSlip = moveTowards(this.wheelSlip, slip, dt * 3);
    this.resistanceForceN = this._resistance(this.speed, mass);
    this.gradeForceN = (mass * GRAVITY * grade) / Math.sqrt(1 + grade * grade);
    const brakeForce = brake.electric + brake.mechanical + brake.rail;
    this.acceleration =
      (this.tractionForceN -
        brakeForce -
        this.gradeForceN -
        this.resistanceForceN) /
      inertia;
    const oldSpeed = this.speed;
    // Zero speed is a static-friction case, not a negative acceleration. Only
    // an actual applied brake can hold against a forward/downhill gravity load.
    const downhillForce = Math.max(0, -this.gradeForceN);
    if (
      oldSpeed < 0.025 &&
      (secured || brakeForce > 0) &&
      brakeForce >= downhillForce
    ) {
      this.speed = 0;
      this.acceleration = 0;
    } else {
      this.speed = Math.max(0, this.speed + this.acceleration * dt);
      if (this.speed === 0) this.acceleration = 0;
    }
    // The published maximum is a traction cut-off, never an inertia-destroying
    // hard clamp: an unbraked vehicle can overspeed while descending a hill.
    this.s = clamp(
      this.s + (oldSpeed + this.speed) * 0.5 * dt,
      0,
      this.routeLength,
    );

    const meanSpeed = (oldSpeed + this.speed) * 0.5;
    const motorPower = this.tractionForceN * meanSpeed;
    const copperLoss =
      PHYSICS.copperLossPerCar *
      this.carCount *
      (this.tractionForceN / this.maxTractionForceN) ** 2;
    const tractionElectric =
      motorPower / PHYSICS.tractionEfficiency + copperLoss;
    const dynamicElectric =
      brake.electric * meanSpeed * PHYSICS.regenerativeEfficiency;
    const regenerated = dynamicElectric * this.regenerationReceptivity;
    const auxiliary = PHYSICS.auxiliaryPowerPerCar * this.carCount;
    this.powerKW = motorPower / 1000;
    this.brakePowerKW =
      ((brake.electric + brake.mechanical + brake.rail) * meanSpeed) / 1000;
    this.tractionCurrentA = tractionElectric / PHYSICS.lineVoltage;
    this.brakeCurrentA = dynamicElectric / PHYSICS.lineVoltage;
    this.lineCurrentA =
      (tractionElectric + auxiliary - regenerated) / PHYSICS.lineVoltage;
    this.consumptionKWh += ((tractionElectric + auxiliary) * dt) / 3600000;
    this.regeneratedKWh += (regenerated * dt) / 3600000;
    this.resistorHeatKWh += ((dynamicElectric - regenerated) * dt) / 3600000;
    const frictionPower = brake.mechanical * meanSpeed;
    this.mechanicalBrakeHeatKWh += (frictionPower * dt) / 3600000;
    this.brakeTemperatureC = this._temperatureStep(
      this.brakeTemperatureC,
      frictionPower,
      meanSpeed,
      dt,
    );
    this.resistorTemperatureC = this._temperatureStep(
      this.resistorTemperatureC,
      dynamicElectric - regenerated,
      meanSpeed,
      dt,
      true,
    );

    const radius = this._radius();
    this.lateralAccel = Number.isFinite(radius) ? this.speed ** 2 / radius : 0;
    this.jerk = (this.acceleration - previousAcceleration) / dt;
    this._updateComfort(dt);
    const targetRoll = clamp(-this.lateralAccel * 0.016, -0.075, 0.075);
    // Damped suspension body roll, not an instantaneous camera tilt.
    this._rollVelocity +=
      ((targetRoll - this.chassisRoll) * 20 - this._rollVelocity * 7) * dt;
    this.chassisRoll += this._rollVelocity * dt;
    this.chassisPitch = moveTowards(
      this.chassisPitch,
      this.acceleration * 0.004,
      dt * 0.01,
    );
    const trackAmplitude =
      ((0.002 + this.speed * 0.00055) * this.speed) / (this.speed + 2);
    this.rideShake =
      trackAmplitude *
        (Math.sin((this.s * Math.PI * 2) / 18) +
          0.25 * Math.sin((this.s * Math.PI * 2) / 0.72)) +
      this.impactShake * Math.cos(this._impactElapsed * 43);

    if (!this.finished) {
      this._checkSignals(previousS, dt);
      this._checkSpeed(dt);
      this._checkDeparture();
      this._updateBoarding(dt);
      if (!this.doors && this.doorProgress === 0 && this._stopBoarded)
        this._completeStop();
      this._checkMissedStops();
      if (this.s >= this.routeLength && this.speed > DOOR_SPEED) {
        this.speed = 0;
        this.acceleration = 0;
        this.throttle = 0;
        if (this.nextStopIndex >= this.stops.length || this.mode === "free") {
          this.finished = true;
          this.serviceState = "finished";
          this._setMessage(
            "Dojeli jste na konec modelované trati. Jízda je ukončena.",
            20,
          );
        } else {
          this._setMessage(
            "Konec trati. Dokončete nástup cestujících na konečné.",
            6,
          );
        }
      }
    }
    this._refreshServiceState();
  }

  _correctSide(stop) {
    return stop.side === "both" || stop.side === this.doorSide;
  }

  _updateComfort(dt) {
    this._filteredJerk +=
      (this.jerk - this._filteredJerk) * (1 - Math.exp(-dt / 0.3));
    const load = Math.hypot(this.acceleration / 1.25, this.lateralAccel / 1.4);
    const stress =
      Math.max(0, load - 0.8) +
      Math.max(0, Math.abs(this._filteredJerk) - 1.5) * 0.12;
    this.comfortStress +=
      (stress - this.comfortStress) * (1 - Math.exp(-dt / 0.7));
    if (this.speed > 0.5) {
      this.drivingSeconds += dt;
      this.comfortDose += Math.min(2, this.comfortStress) * dt;
    }
    this.comfortRating = clamp(
      100 - (this.comfortDose / Math.max(20, this.drivingSeconds)) * 65,
      0,
      100,
    );
    for (const [axis, acceleration] of [
      ["longitudinal", this.acceleration],
      ["lateral", this.lateralAccel],
    ]) {
      const target = clamp((-acceleration * 0.8) / GRAVITY, -0.24, 0.24);
      this._swayVelocity[axis] +=
        ((target - this.passengerSway[axis]) * 18 -
          this._swayVelocity[axis] * 6.5) *
        dt;
      this.passengerSway[axis] += this._swayVelocity[axis] * dt;
    }
    // A brief track joint, normal service braking or an urgent stop does not
    // trigger an extra penalty. Sustained excessive loads count once per event.
    if (
      load > 1.6 &&
      this.passengers > 0 &&
      this.speed > 2 &&
      !this.emergency
    ) {
      this._comfortExposure += dt;
      if (this._comfortExposure > 0.8 && !this._comfortEpisode) {
        this._comfortEpisode = true;
        this.violations.roughRide += 1;
        this.score -= 8;
        this._setMessage(
          "Cestující ztrácejí stabilitu. Zvolněte v oblouku a ovládejte řadič plynule.",
          5,
        );
      }
    } else {
      this._comfortExposure = Math.max(0, this._comfortExposure - dt * 2);
      if (this._comfortExposure === 0) this._comfortEpisode = false;
    }
  }

  _updateBoarding(dt) {
    const stop = this.stops[this.nextStopIndex];
    if (
      !stop ||
      this._stopBoarded ||
      !this.doors ||
      this.doorProgress < 1 - 1e-6 ||
      this.speed >= DOOR_SPEED ||
      Math.abs(stop.s - this.s) > STOP_TOLERANCE ||
      !this._correctSide(stop)
    )
      return;
    if (!this._boardingPlan) {
      this._boardingPlan = this._planBoarding(this.nextStopIndex);
      if (this._boardingPlan.dwell)
        this.dwellRequired = Math.max(
          this.baseDwellRequired,
          this._boardingPlan.dwell,
        );
    }
    this.dwell = Math.min(this.dwellRequired, this.dwell + dt);
    this.boarding = this.dwell / this.dwellRequired;
    if (this.dwell >= this.dwellRequired - 1e-6) {
      this.dwell = this.dwellRequired;
      this.boarding = 1;
      this.passengers = clamp(
        this.passengers - this._boardingPlan.off + this._boardingPlan.on,
        0,
        this.capacity,
      );
      this._stopBoarded = true;
      this._setMessage(
        "Nástup dokončen. Zavřete dveře a vyčkejte na jejich zajištění.",
        4,
      );
    }
  }

  _planBoarding(index) {
    const last = index === this.stops.length - 1;
    const demand = this.passengerDemand;
    if (demand) {
      const off = last
        ? this.passengers
        : clamp(
            Math.round(finite(demand.alighting?.(index, this.passengers), 0)),
            0,
            this.passengers,
          );
      const on = last
        ? 0
        : clamp(
            Math.round(finite(demand.boarding?.(index), 0)),
            0,
            this.capacity - this.passengers + off,
          );
      return { off, on, dwell: finite(demand.dwell?.(on, off), 0) };
    }
    const off = last
      ? this.passengers
      : Math.min(this.passengers, 3 + ((index * 7 + 2) % 15));
    const on = last
      ? 0
      : Math.min(
          this.capacity - this.passengers + off,
          7 + ((index * 11 + 3) % 19),
        );
    return { off, on };
  }

  /** A request stop (na znamení) needs serving only when someone asked. */
  stopRequested(index = this.nextStopIndex) {
    const stop = this.stops[index];
    if (!stop?.request) return true;
    return this.passengerDemand?.requested
      ? Boolean(this.passengerDemand.requested(index))
      : true;
  }

  /** Seconds of the service day; may exceed 24 h for after-midnight trips. */
  get clock() {
    return this.clockStart + this.time;
  }

  /**
   * Timetable deviation at the current position: positive is a delay. The
   * scheduled passage is interpolated by distance between published times.
   */
  _scheduleState() {
    if (!this.schedule || this.mode !== "service") return null;
    const index = this.nextStopIndex;
    const stop = this.stops[index];
    const departure = this.schedule[index];
    if (!stop || departure == null) return null;
    const atStop =
      Math.abs(stop.s - this.s) <= STOP_TOLERANCE && this.speed < DOOR_SPEED;
    let expected = departure;
    if (!atStop) {
      let previous = index - 1;
      while (previous >= 0 && this.schedule[previous] == null) previous--;
      const from = previous >= 0 ? this.stops[previous] : null;
      if (from) {
        const t = clamp((this.s - from.s) / Math.max(1, stop.s - from.s), 0, 1);
        expected =
          this.schedule[previous] + (departure - this.schedule[previous]) * t;
      }
    }
    return {
      stopIndex: index,
      scheduledDeparture: departure,
      deviation: this.clock - expected,
      atStop,
      waitSeconds: atStop ? Math.max(0, departure - this.clock) : 0,
    };
  }

  /** Evaluated when the tram actually leaves the platform, not at door closure. */
  _checkDeparture() {
    const pending = this._pendingDeparture;
    if (!pending) return;
    if (this.s < pending.s + 1.5 && this.speed < 0.6) return;
    this._pendingDeparture = null;
    const deviation = this.clock - pending.scheduled;
    this.lastDeparture = { stopIndex: pending.index, deviation };
    if (deviation < -5) {
      this.violations.earlyDepartures += 1;
      this.score -= 60;
      this._setMessage(
        `Předčasný odjezd ze zastávky ${pending.name} o ${Math.ceil(-deviation)} s: −60 bodů. Odjíždějte podle jízdního řádu.`,
        6,
      );
    } else if (deviation <= 180) {
      this.punctualDepartures += 1;
      this.score += 20;
    } else {
      this.score -= Math.min(30, Math.round((deviation - 180) / 10));
    }
  }

  _completeStop() {
    const stop = this.stops[this.nextStopIndex];
    const error = stop ? Math.abs(stop.s - this.s) : STOP_TOLERANCE;
    const reward = Math.round(
      100 + 40 * (1 - clamp(error / STOP_TOLERANCE, 0, 1)),
    );
    this.score += reward;
    const scheduled = this.schedule?.[this.nextStopIndex];
    if (
      this.mode === "service" &&
      scheduled != null &&
      this.nextStopIndex < this.stops.length - 1
    )
      this._pendingDeparture = {
        index: this.nextStopIndex,
        name: stop.name,
        s: this.s,
        scheduled,
      };
    this.completedStops += 1;
    this.nextStopIndex += 1;
    this._stopBoarded = false;
    this._boardingPlan = null;
    this.dwellRequired = this.baseDwellRequired;
    this.dwell = 0;
    this.boarding = 0;
    if (this.nextStopIndex >= this.stops.length && this.mode === "service") {
      this.finished = true;
      this.throttle = 0;
      this.serviceState = "finished";
      this._setMessage(
        `Služba dokončena. Obslouženo ${this.completedStops} zastávek.`,
        60,
      );
    } else {
      const hold = this._pendingDeparture;
      this._setMessage(
        hold && this.clock < hold.scheduled - 5
          ? `${stop?.name || "Zastávka"} obsloužena: +${reward} bodů. Odjezd podle jízdního řádu v ${clockText(hold.scheduled)}, vyčkejte.`
          : `${stop?.name || "Zastávka"} obsloužena: +${reward} bodů. Další ${this.stops[this.nextStopIndex]?.name || "konec trati"}.`,
        5,
      );
    }
  }

  _checkMissedStops() {
    while (this.nextStopIndex < this.stops.length) {
      const stop = this.stops[this.nextStopIndex];
      if (this.s <= stop.s + STOP_TOLERANCE || this._stopBoarded) break;
      if (!this.stopRequested(this.nextStopIndex)) {
        if (this.mode === "service")
          this._setMessage(
            `${stop.name} (na znamení): nikdo nevystupuje ani nečeká, zastavení nebylo nutné.`,
            5,
          );
      } else if (this.mode === "service") {
        this.violations.missedStops += 1;
        this.score -= 140;
        this._setMessage(
          `Vynechaná zastávka ${stop.name}: −140 bodů. Pokračujte k další.`,
          6,
        );
      }
      this.nextStopIndex += 1;
      this.dwell = 0;
      this.boarding = 0;
      this._boardingPlan = null;
      this.dwellRequired = this.baseDwellRequired;
    }
  }

  _checkSignals(previousS, dt) {
    for (const signal of this.signals) {
      if (
        signal.s <= previousS ||
        signal.s > this.s ||
        this._signalsCrossed.has(signal.id)
      )
        continue;
      this._signalsCrossed.add(signal.id);
      // Evaluate at interpolated crossing time, not the end of a long frame.
      const fraction =
        (signal.s - previousS) / Math.max(1e-9, this.s - previousS);
      if (getSignalAspect(signal, this.time - dt + dt * fraction) === "stop") {
        this.violations.redSignals += 1;
        this.score -= 100;
        this._setMessage(
          "Projeté návěstidlo „Stůj“: −100 bodů. Sledujte bílé tramvajové návěsti.",
          6,
        );
      }
    }
  }

  _checkSpeed(dt) {
    const limit = this._speedLimit();
    if (this.speed * 3.6 > limit + 2) {
      this._overspeedTime += dt;
      if (this._overspeedTime >= 1.5) {
        if (!this._overspeedEpisode) {
          this._overspeedEpisode = true;
          this.violations.speeding += 1;
          this.score -= 25;
        }
        this.score -= dt * Math.min(3, (this.speed * 3.6 - limit) * 0.12);
      }
    } else {
      this._overspeedTime = 0;
      this._overspeedEpisode = false;
    }
  }

  _limitAt(s) {
    return clamp(
      finite(this.getSpeedLimit(clamp(s, 0, this.routeLength)), 50),
      5,
      this.profile.maxSpeedKmh,
    );
  }

  /**
   * A reduced speed applies until the rear of the consist has passed the
   * restricted section, as on any railway; the front alone is not enough.
   */
  _speedLimit() {
    const key = Math.round(this.s * 2);
    if (this._limitCache?.key === key) return this._limitCache.value;
    let limit = this._limitAt(this.s);
    for (let d = 3; d < this.vehicleLength; d += 3)
      limit = Math.min(limit, this._limitAt(this.s - d));
    limit = Math.min(limit, this._limitAt(this.s - this.vehicleLength));
    this._limitCache = { key, value: limit };
    return limit;
  }

  /** The next lower limit for the front within sighting distance. */
  _nextLimit(current = this._speedLimit()) {
    const key = Math.round(this.s / 4);
    if (
      this._nextLimitCache?.key === key &&
      this._nextLimitCache.current === current
    )
      return this._nextLimitCache.value;
    let value = null;
    for (let d = 4; d <= 320; d += 4) {
      const limit = this._limitAt(this.s + d);
      if (limit < current) {
        value = { limit, distance: d };
        break;
      }
    }
    this._nextLimitCache = { key, current, value };
    return value;
  }

  _refreshServiceState() {
    if (this.finished) {
      this.serviceState = "finished";
      return;
    }
    const stop = this.stops[this.nextStopIndex];
    if (!stop) {
      this.serviceState = "running";
      return;
    }
    if (
      Math.abs(stop.s - this.s) <= STOP_TOLERANCE &&
      this.speed < DOOR_SPEED
    ) {
      this.serviceState = this._stopBoarded
        ? "ready"
        : this.doors
          ? "boarding"
          : "stopped";
    } else {
      this.serviceState = "approaching";
    }
  }

  _setMessage(message, seconds) {
    this._messageText = message;
    this._messageTimer = seconds;
  }

  getSnapshot() {
    const stop = this.stops[this.nextStopIndex];
    const nextStop = stop ? { ...stop, distance: stop.s - this.s } : null;
    const signal = this.signals.find((item) => item.s >= this.s - 0.5);
    const nearestSignal = signal
      ? {
          ...signal,
          distance: signal.s - this.s,
          aspect: getSignalAspect(signal, this.time),
        }
      : null;
    const grade = clamp(finite(this.getGrade(this.s), 0), -0.14, 0.14);
    const rail = this._railState();
    const upcomingRail = this.railConditions.find(
      (zone) => zone.startS > this.s && zone.startS - this.s < 180,
    );
    const cacheKey = `${Math.round(this.speed * 10)}:${Math.round(this.s / 3)}:${Math.round(this._driveForce / 2000)}:${this.weather}:${Math.round(this._sandEffect * 5)}:${this.passengers}:${Math.round(this.railWetness * 20)}:${Math.round(this.brakeTemperatureC / 10)}:${Math.round(rail.coefficient * 1000)}`;
    if (this._brakingCache?.key !== cacheKey) {
      this._brakingCache = {
        key: cacheKey,
        service: this.getBrakingDistance(),
        emergency: this.getBrakingDistance({
          emergency: true,
          reactionTime: 0,
        }),
      };
    }
    const brakingDistance = Math.min(1000, this._brakingCache.service);
    const brakingUnsafe =
      !Number.isFinite(this._brakingCache.service) ||
      this._brakingCache.service > 1000;
    let message = this._messageTimer > 0 ? this._messageText : "";
    if (!message) {
      if (this.finished)
        message = "Jízda dokončena. Spusťte novou službu nebo volnou jízdu.";
      else if (this.emergency)
        message = "Nouzová brzda aktivní. Po zastavení vraťte řadič do výběhu.";
      else if (!this.doors && this.doorProgress > 0)
        message = "Dveře se zavírají · trakce blokována.";
      else if (this.doors || this.doorProgress > 0) {
        const wait = this._scheduleState()?.waitSeconds ?? 0;
        message = this._stopBoarded
          ? wait > 5
            ? `Nástup dokončen. Odjezd podle jízdního řádu v ${clockText(this.schedule[this.nextStopIndex])} · náskok ${Math.ceil(wait)} s.`
            : "Nástup dokončen. Zavřete dveře."
          : `Nástup cestujících: ${Math.ceil(Math.max(0, this.dwellRequired - this.dwell))} s.`;
      } else if (
        this._pendingDeparture &&
        this.speed < 0.6 &&
        this.clock < this._pendingDeparture.scheduled - 5
      )
        message = `Odbaveno. Odjezd v ${clockText(this._pendingDeparture.scheduled)} · náskok ${Math.ceil(this._pendingDeparture.scheduled - this.clock)} s. Předčasný odjezd je chyba.`;
      else if (this._stopBoarded)
        message =
          "Nástup dokončen a dveře zajištěny. Zastávka připravena k odjezdu.";
      else if (this.serviceState === "stopped")
        message = `${stop.name}: otevřete pravé dveře a obslužte zastávku.`;
      else if (
        nearestSignal?.aspect === "stop" &&
        nearestSignal.distance < Math.max(50, brakingDistance + 20)
      )
        message = "Návěst „Stůj“. Zastavte před návěstidlem.";
      else if (brakingUnsafe || this.wheelSlip > 0.12)
        message =
          "Nízká adheze. Přidržte G pro pískování, snižte výkon a začněte brzdit dříve.";
      else if (
        rail.severity > 0.15 &&
        rail.coefficient < 0.12 &&
        this.speed > 2
      )
        message = `${rail.label}. Brzděte s předstihem a použijte písek.`;
      else if (this._frictionBrakeFactor() < 0.9)
        message =
          "Mechanické brzdy jsou přehřáté. Jeďte pomalu a umožněte jejich ochlazení.";
      else if (this.speed * 3.6 > this._speedLimit() + 2)
        message = "Překročená rychlost. Plynule přibrzděte.";
      else if (
        stop?.request &&
        nextStop.distance > 0 &&
        nextStop.distance < Math.max(250, brakingDistance + 60)
      )
        message = this.stopRequested()
          ? `${stop.name} (na znamení): požadavek na zastavení.`
          : `${stop.name} (na znamení): nikdo nevystupuje ani nečeká, můžete projet.`;
      else if (
        nextStop &&
        nextStop.distance > 0 &&
        nextStop.distance < brakingDistance + 20 &&
        this.speed > 2
      )
        message = `${stop.name}: začněte plynule brzdit.`;
      else
        message =
          this.mode === "free"
            ? "Volná jízda. Sledujte rychlost, provoz a tramvajová návěstidla."
            : "Sledujte trať a návěsti. Zastavujte u označníků a obsluhujte dveře.";
    }
    return {
      s: this.s,
      speed: this.speed,
      speedKmh: this.speed * 3.6,
      throttle: this.throttle,
      acceleration: this.acceleration,
      jerk: this.jerk,
      massKg: this._mass(),
      effectiveMassKg: this._mass() * PHYSICS.rotatingMassFactor,
      kineticEnergyKWh:
        (0.5 * this._mass() * PHYSICS.rotatingMassFactor * this.speed ** 2) /
        3600000,
      tractionForceN: this.tractionForceN,
      electricBrakeForceN: this.electricBrakeForceN,
      mechanicalBrakeForceN: this.mechanicalBrakeForceN,
      railBrakeForceN: this.railBrakeForceN,
      resistanceForceN: this.resistanceForceN,
      gradeForceN: this.gradeForceN,
      powerKW: this.powerKW,
      brakePowerKW: this.brakePowerKW,
      tractionCurrentA: this.tractionCurrentA,
      brakeCurrentA: this.brakeCurrentA,
      lineCurrentA: this.lineCurrentA,
      wheelSlip: this.wheelSlip,
      sanding: this.sanding,
      sandEffect: this._sandEffect,
      adhesionCoefficient: rail.coefficient,
      railCondition: rail.condition,
      railConditionLabel: rail.label,
      railConditionSeverity: rail.severity,
      railWetness: this.railWetness,
      nextRailCondition: upcomingRail
        ? {
            condition: upcomingRail.condition,
            label: upcomingRail.label || RAIL_LABELS[upcomingRail.condition],
            distance: upcomingRail.startS - this.s,
            severity: upcomingRail.severity,
          }
        : null,
      parkingBrake: this.parkingBrake,
      brakeBlend:
        this.mechanicalBrakeForceN /
        Math.max(1, this.electricBrakeForceN + this.mechanicalBrakeForceN),
      railBrake: this.railBrakeForceN > 0,
      curveRadius: this._radius(),
      lateralAccel: this.lateralAccel,
      chassisRoll: this.chassisRoll,
      chassisPitch: this.chassisPitch,
      rideShake: this.rideShake,
      impactShake: this.impactShake,
      consumptionKWh: this.consumptionKWh,
      regeneratedKWh: this.regeneratedKWh,
      netEnergyKWh: this.consumptionKWh - this.regeneratedKWh,
      resistorHeatKWh: this.resistorHeatKWh,
      mechanicalBrakeHeatKWh: this.mechanicalBrakeHeatKWh,
      brakeTemperatureC: this.brakeTemperatureC,
      resistorTemperatureC: this.resistorTemperatureC,
      frictionBrakeFactor: this._frictionBrakeFactor(),
      comfortRating: this.comfortRating,
      comfortStress: this.comfortStress,
      passengerSway: { ...this.passengerSway },
      damage: this.damage,
      collisionEnergyKJ: this.collisionEnergyKJ,
      collisionCount: this.violations.collisions,
      lastCollisionImpact: this.lastCollisionImpact,
      doors: this.doors,
      doorProgress: this.doorProgress,
      doorSide: this.doorSide,
      doorState:
        this.doorProgress === 0
          ? "closed"
          : this.doorProgress === 1
            ? "open"
            : this.doors
              ? "opening"
              : "closing",
      passengers: this.passengers,
      capacity: this.capacity,
      nextStopIndex: this.nextStopIndex,
      nextStop,
      dwell: this.dwell,
      dwellRequired: this.dwellRequired,
      boarding: this.boarding,
      serviceState: this.serviceState,
      completedStops: this.completedStops,
      totalStops: this.stops.length,
      score: Math.round(this.score),
      violations: { ...this.violations },
      violationCount: Object.values(this.violations).reduce(
        (sum, value) => sum + value,
        0,
      ),
      time: this.time,
      clock: this.clock,
      schedule: this._scheduleState(),
      lastDeparture: this.lastDeparture,
      punctualDepartures: this.punctualDepartures,
      departureHold: this._pendingDeparture
        ? {
            stopIndex: this._pendingDeparture.index,
            scheduled: this._pendingDeparture.scheduled,
            wait: Math.max(0, this._pendingDeparture.scheduled - this.clock),
          }
        : null,
      nextStopRequest: stop?.request
        ? { requested: this.stopRequested(), name: stop.name }
        : null,
      boardingPlan: this._boardingPlan ? { ...this._boardingPlan } : null,
      limit: this._speedLimit(),
      nextLimit: this._nextLimit(),
      nearestSignal,
      brakingDistance,
      brakingUnsafe,
      emergencyBrakingDistance: Math.min(1000, this._brakingCache.emergency),
      gradePercent: grade * 100,
      emergency: this.emergency,
      weather: this.weather,
      mode: this.mode,
      distanceRemaining: this.routeLength - this.s,
      message,
      finished: this.finished,
    };
  }

  getSaveState() {
    return {
      startS: this.s,
      startStopIndex: this.nextStopIndex,
      speed: 0,
      score: this.score,
      passengers: this.passengers,
      time: this.time,
      completedStops: this.completedStops,
      violations: { ...this.violations },
      boardingStopIndex: this.nextStopIndex,
      stopBoarded: this._stopBoarded,
      dwell: this.dwell,
      dwellRequired: this.dwellRequired,
      schedule: this.schedule ? [...this.schedule] : null,
      clockStart: this.clockStart,
      punctualDepartures: this.punctualDepartures,
      weather: this.weather,
      mode: this.mode,
      finished: this.finished,
      consumptionKWh: this.consumptionKWh,
      regeneratedKWh: this.regeneratedKWh,
      resistorHeatKWh: this.resistorHeatKWh,
      mechanicalBrakeHeatKWh: this.mechanicalBrakeHeatKWh,
      brakeTemperatureC: this.brakeTemperatureC,
      resistorTemperatureC: this.resistorTemperatureC,
      railWetness: this.railWetness,
      comfortDose: this.comfortDose,
      drivingSeconds: this.drivingSeconds,
      damage: this.damage,
      collisionEnergyKJ: this.collisionEnergyKJ,
      parkingBrake: true,
    };
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Signal-aware street traffic and passing trams; renderer projects s/laneOffset. */
export class CityTrafficSimulation {
  constructor(config = {}) {
    this.routeLength = Math.max(200, finite(config.routeLength, 10000));
    this.signals = config.signals || [];
    this.getSpeedLimit =
      typeof config.getSpeedLimit === "function"
        ? config.getSpeedLimit
        : () => 40;
    this.random = seededRandom(finite(config.seed, 22));
    this.time = 0;
    this.vehicles = [];
    const colors = [
      0x536671, 0xdddacf, 0x242d35, 0x9f433a, 0x304b68, 0xb5b9b6, 0x79685a,
    ];
    const count = clamp(Math.round(finite(config.count, 30)), 0, 150);
    for (let i = 0; i < count; i++) {
      const direction = i % 3 === 0 ? -1 : 1;
      const tram = i % 13 === 0 && direction === -1;
      this.vehicles.push({
        id: `traffic-${i}`,
        type: tram ? "tram" : "car",
        direction,
        s:
          ((i + 0.3 + this.random() * 0.4) / Math.max(1, count)) *
          this.routeLength,
        laneOffset: tram ? -3.15 : direction * (4.65 + (i % 5 === 0 ? 3.2 : 0)),
        length: tram ? 15.104 : 3.9 + this.random() * 1.1,
        color: tram ? 0xc83b2f : colors[i % colors.length],
        speed: 4 + this.random() * 5,
        cruiseSpeed: tram ? 10 : 7 + this.random() * 5,
        acceleration: 0,
        braking: false,
        signalAspect: "go",
      });
    }
  }

  update(dt, player = null, simulationTime = null) {
    if (!Number.isFinite(dt) || dt <= 0) return this.vehicles;
    let remaining = dt;
    while (remaining > 1e-9) {
      const step = Math.min(1 / 30, remaining);
      this.time += step;
      const clock = Number.isFinite(simulationTime)
        ? simulationTime - remaining + step
        : this.time;
      const oldStates = this.vehicles.map((vehicle) => ({ ...vehicle }));
      for (let index = 0; index < this.vehicles.length; index++) {
        const vehicle = this.vehicles[index];
        const previous = oldStates[index];
        let target = Math.min(
          vehicle.cruiseSpeed,
          Math.max(10, finite(this.getSpeedLimit(vehicle.s), 40)) / 3.6,
        );
        let closestGap = Infinity;
        let leadSpeed = 0;
        for (const ahead of oldStates) {
          if (
            ahead.id === vehicle.id ||
            ahead.direction !== vehicle.direction ||
            Math.abs(ahead.laneOffset - vehicle.laneOffset) > 1.2
          )
            continue;
          const distance =
            (ahead.s - vehicle.s) * vehicle.direction -
            (ahead.length + vehicle.length) / 2;
          if (distance >= 0 && distance < closestGap) {
            closestGap = distance;
            leadSpeed = ahead.speed;
          }
        }
        const desiredGap = 4 + vehicle.speed * 1.7;
        if (closestGap < desiredGap + vehicle.speed ** 2 / 4)
          target = Math.min(
            target,
            Math.max(0, leadSpeed + (closestGap - desiredGap) * 0.3),
          );
        const aheadSignals = this.signals.filter(
          (signal) =>
            (signal.s - vehicle.s) * vehicle.direction >= 0 &&
            (signal.s - vehicle.s) * vehicle.direction < 100,
        );
        aheadSignals.sort((a, b) => (a.s - b.s) * vehicle.direction);
        const signal = aheadSignals[0];
        vehicle.signalAspect = signal ? getSignalAspect(signal, clock) : "go";
        if (signal && vehicle.signalAspect === "stop") {
          const gap =
            (signal.s - vehicle.s) * vehicle.direction - vehicle.length / 2 - 2;
          target = Math.min(
            target,
            Math.sqrt(Math.max(0, 2 * 1.5 * Math.max(0, gap))),
          );
        }
        // A passing tram respects the player's stopping clearance if on its track.
        if (
          player &&
          Math.abs(vehicle.laneOffset) < 1.4 &&
          vehicle.direction === 1
        ) {
          const gap = player.s - vehicle.s - vehicle.length / 2 - 3;
          if (gap > 0 && gap < 60)
            target = Math.min(
              target,
              Math.max(0, player.speed + (gap - desiredGap) * 0.3),
            );
        }
        const desiredAcceleration = clamp(
          (target - vehicle.speed) * 1.4,
          -2.5,
          1.3,
        );
        vehicle.acceleration = moveTowards(
          vehicle.acceleration,
          desiredAcceleration,
          step * 2.2,
        );
        vehicle.braking = vehicle.acceleration < -0.25;
        vehicle.speed = clamp(
          vehicle.speed + vehicle.acceleration * step,
          0,
          vehicle.cruiseSpeed,
        );
        vehicle.s +=
          (previous.speed + vehicle.speed) * 0.5 * step * vehicle.direction;
        if (signal && vehicle.signalAspect === "stop") {
          const stopAt =
            signal.s - vehicle.direction * (vehicle.length / 2 + 2);
          if (
            (vehicle.s - stopAt) * vehicle.direction > 0 &&
            (previous.s - stopAt) * vehicle.direction <= 0
          ) {
            vehicle.s = stopAt;
            vehicle.speed = 0;
            vehicle.acceleration = 0;
          }
        }
        if (closestGap < 1.5) {
          vehicle.s = previous.s;
          vehicle.speed = 0;
          vehicle.acceleration = 0;
        }
        if (vehicle.s > this.routeLength + 50) {
          vehicle.s = -50;
          vehicle.speed = 3;
        }
        if (vehicle.s < -50) {
          vehicle.s = this.routeLength + 50;
          vehicle.speed = 3;
        }
      }
      remaining -= step;
    }
    return this.vehicles;
  }
}
