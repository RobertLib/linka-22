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
const STEP = 1 / 60;
const GRAVITY = 9.80665;
const STOP_TOLERANCE = 18;
const DOOR_SPEED = 0.12;

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
    this.regenerationReceptivity = clamp(
      finite(config.regenerationReceptivity, 0.6),
      0,
      1,
    );
    this.getSpeedLimit =
      typeof config.getSpeedLimit === "function"
        ? config.getSpeedLimit
        : () => 50;
    this.dwellRequired = Math.max(3, finite(config.dwellRequired, 8));
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
    this.damage = clamp(finite(options.damage, 0), 0, 100);
    this.collisionEnergyKJ = Math.max(0, finite(options.collisionEnergyKJ, 0));
    this.lateralAccel = 0;
    this.chassisRoll = 0;
    this.chassisPitch = 0;
    this.rideShake = 0;
    this._rollVelocity = 0;
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
        "collisions",
      ].map((key) => [
        key,
        Math.max(0, Math.floor(finite(options.violations?.[key], 0))),
      ]),
    );
    this.time = Math.max(0, finite(options.time, 0));
    this.finished = Boolean(options.finished);
    this.emergency = false;
    const savedStop = this.stops[this.nextStopIndex];
    const sameBoardingStop = Boolean(
      savedStop &&
      options.boardingStopIndex === this.nextStopIndex &&
      Math.abs(savedStop.s - this.s) <= STOP_TOLERANCE,
    );
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
      this._setMessage("Nástup nebyl dokončen. Znovu otevřete dveře.", 4);
    }
    return true;
  }

  /** Called by the scene for a real overlap, never a speculative warning. */
  reportCollision(impact = 1) {
    if (this._collisionCooldown > 0 || this.finished) return false;
    const details = typeof impact === "object" && impact ? impact : {};
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
    const reducedMass = (mass * otherMass) / (mass + otherMass);
    const relativeSpeed = Math.max(0, this.speed - otherSpeed);
    // Momentum transfer for a predominantly longitudinal contact. A 1.5 t car
    // cannot remove 85% of the momentum of a 35 t tram consist in one frame.
    const impulse = reducedMass * (1 + restitution) * relativeSpeed * fraction;
    const dissipated =
      0.5 *
      reducedMass *
      relativeSpeed ** 2 *
      (1 - restitution ** 2) *
      fraction;
    this._collisionCooldown = 3;
    this.violations.collisions += 1;
    this.score -= Math.round(120 * severity);
    this.speed = Math.max(0, this.speed - impulse / mass);
    this.collisionEnergyKJ += dissipated / 1000;
    this.damage = clamp(this.damage + dissipated / 10000, 0, 100);
    this.emergency = true;
    this.throttle = -1;
    this.acceleration = 0;
    this._brakingCache = null;
    this._setMessage("Střet s vozidlem. Zastavte a zajistěte tramvaj.", 7);
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

  _adhesion(mass) {
    const wet = this.weather === "rain";
    const base = wet ? PHYSICS.wetAdhesion : PHYSICS.dryAdhesion;
    const sanded = wet ? PHYSICS.sandedWetAdhesion : PHYSICS.sandedDryAdhesion;
    return mass * GRAVITY * (base + (sanded - base) * this._sandEffect);
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

  _brakeForces(speed, demand, mass, emergency = false) {
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
    const mechanical = emergency
      ? Math.max(0, demand - electric)
      : demand * (1 - fade);
    const wheelDemand = electric + mechanical;
    const adhesion = this._adhesion(mass);
    const antiSkidFactor = wheelDemand > adhesion ? 0.96 : 1;
    const wheelForce = Math.min(wheelDemand, adhesion) * antiSkidFactor;
    const scale = wheelDemand > 0 ? wheelForce / wheelDemand : 0;
    const rail = emergency
      ? this.maxRailBrakeForceN * (this.weather === "rain" ? 0.9 : 1)
      : 0;
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
    const target = -(emergency
      ? this.maxEmergencyWheelForceN
      : this.maxServiceBrakeForceN);
    const ramp =
      inertia * (emergency ? PHYSICS.emergencyJerk : PHYSICS.brakeJerk);
    const integrate = (step, force, applyRailBrake) => {
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
      );
      brake.rail *= railProgress;
      const traction = Math.max(
        0,
        Math.min(
          force,
          this.getAvailableTractionForce(speed),
          this._adhesion(mass),
        ),
      );
      const projectedS = Math.min(this.routeLength, this.s + distance);
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
    this.doorProgress = moveTowards(
      this.doorProgress,
      this.doors ? 1 : 0,
      dt / (this.doors ? 1.25 : 1.6),
    );
    if (this.doorProgress < 1e-8) this.doorProgress = 0;
    if (this.doorProgress > 1 - 1e-8) this.doorProgress = 1;

    const previousS = this.s;
    const grade = clamp(finite(this.getGrade(this.s), 0), -0.14, 0.14);
    const mass = this._mass();
    const inertia = mass * PHYSICS.rotatingMassFactor;
    const doorInterlock = this.doors || this.doorProgress > 1e-6;
    const secured = doorInterlock || this.finished || this.parkingBrake;
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

    const radius = this._radius();
    this.lateralAccel = Number.isFinite(radius) ? this.speed ** 2 / radius : 0;
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
        0.25 * Math.sin((this.s * Math.PI * 2) / 0.72));

    if (!this.finished) {
      this._checkSignals(previousS, dt);
      this._checkSpeed(dt);
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
      const last = this.nextStopIndex === this.stops.length - 1;
      const off = last
        ? this.passengers
        : Math.min(this.passengers, 3 + ((this.nextStopIndex * 7 + 2) % 15));
      const on = last
        ? 0
        : Math.min(
            this.capacity - this.passengers + off,
            7 + ((this.nextStopIndex * 11 + 3) % 19),
          );
      this._boardingPlan = { off, on };
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

  _completeStop() {
    const stop = this.stops[this.nextStopIndex];
    const error = stop ? Math.abs(stop.s - this.s) : STOP_TOLERANCE;
    const reward = Math.round(
      100 + 40 * (1 - clamp(error / STOP_TOLERANCE, 0, 1)),
    );
    this.score += reward;
    this.completedStops += 1;
    this.nextStopIndex += 1;
    this._stopBoarded = false;
    this._boardingPlan = null;
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
      this._setMessage(
        `${stop?.name || "Zastávka"} obsloužena: +${reward} bodů. Další ${this.stops[this.nextStopIndex]?.name || "konec trati"}.`,
        5,
      );
    }
  }

  _checkMissedStops() {
    while (this.nextStopIndex < this.stops.length) {
      const stop = this.stops[this.nextStopIndex];
      if (this.s <= stop.s + STOP_TOLERANCE || this._stopBoarded) break;
      if (this.mode === "service") {
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

  _speedLimit() {
    return clamp(
      finite(this.getSpeedLimit(this.s), 50),
      5,
      this.profile.maxSpeedKmh,
    );
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
    const cacheKey = `${Math.round(this.speed * 10)}:${Math.round(this.s / 3)}:${Math.round(this._driveForce / 2000)}:${this.weather}:${Math.round(this._sandEffect * 5)}:${this.passengers}`;
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
      else if (this.doors || this.doorProgress > 0)
        message = this._stopBoarded
          ? "Nástup dokončen. Zavřete dveře."
          : `Nástup cestujících: ${Math.ceil(Math.max(0, this.dwellRequired - this.dwell))} s.`;
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
      else if (this.speed * 3.6 > this._speedLimit() + 2)
        message = "Překročená rychlost. Plynule přibrzděte.";
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
      adhesionCoefficient:
        this._adhesion(this._mass()) / (this._mass() * GRAVITY),
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
      consumptionKWh: this.consumptionKWh,
      regeneratedKWh: this.regeneratedKWh,
      netEnergyKWh: this.consumptionKWh - this.regeneratedKWh,
      resistorHeatKWh: this.resistorHeatKWh,
      damage: this.damage,
      collisionEnergyKJ: this.collisionEnergyKJ,
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
      limit: this._speedLimit(),
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
      weather: this.weather,
      mode: this.mode,
      finished: this.finished,
      consumptionKWh: this.consumptionKWh,
      regeneratedKWh: this.regeneratedKWh,
      resistorHeatKWh: this.resistorHeatKWh,
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
