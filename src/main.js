import "./style.css";
import { Route } from "./route.js";
import { World } from "./world.js";
import { TramSimulation } from "./simulation.js";
import { TramAudio } from "./audio.js";
import { loadBinary, loadJSON } from "./asset-loader.js";
import {
  chooseTrip,
  formatClock,
  formatDeviation,
  pragueNow,
  serviceDays,
  tripTimes,
  tripsOn,
  weekdayIndex,
} from "./timetable.js";
import { createPassengerDemand, TRANSFERS } from "./passengers.js";

const $ = (s) => document.querySelector(s),
  $$ = (s) => document.querySelectorAll(s);
const ui = {
  loading: $("#loading"),
  menu: $("#menu"),
  hud: $("#hud"),
  speed: $("#speed"),
  limit: $("#limit"),
  score: $("#score"),
  name: $("#next-name"),
  distance: $("#next-distance"),
  doors: $("#doors"),
  controller: $("#controller"),
  advice: $("#stop-advice p"),
};
let route,
  city,
  world,
  sim,
  audio,
  playing = false,
  paused = false,
  lastTime = 0,
  hudTime = 0,
  mapTime = 0,
  saveTime = 0,
  frameCount = 0,
  fpsTime = 0,
  fps = 60,
  previousStop = -1,
  lastMessage = "",
  dialogWasPlaying = false,
  selectedWeather = "clear",
  startIndex = 15,
  savedState = null,
  timetable = null,
  // The published trip being driven: its service day and per-stop times.
  service = null,
  // Prague service day of the running clock, also without a published trip.
  clockDay = null;
const cameraNames = ["Kabina", "Za tramvají", "Nad městem"];
try {
  const quality = localStorage.getItem("praha22-quality");
  if (["high", "medium", "low"].includes(quality))
    $("#quality").value = quality;
} catch {}
function safelyReadSave() {
  try {
    const d = JSON.parse(localStorage.getItem("praha22-save-v1"));
    return d?.version === 1 && !d.state?.finished ? d : null;
  } catch {
    return null;
  }
}
function save() {
  if (!sim || !playing) return;
  try {
    localStorage.setItem(
      "praha22-save-v1",
      JSON.stringify({
        version: 1,
        state: sim.getSaveState(),
        weather: selectedWeather,
        startIndex,
        tripId: service?.trip.id ?? null,
        serviceDay: clockDay,
        updated: Date.now(),
      }),
    );
  } catch {}
}
function rating(snap) {
  const perStop = snap.schedule || snap.punctualDepartures ? 160 : 140;
  const possible =
    1000 + perStop * (snap.completedStops + snap.violations.missedStops);
  return Math.max(0, Math.min(100, Math.round((100 * snap.score) / possible)));
}
const isWeekend = (ymd) => weekdayIndex(ymd) >= 5;
/** Trips of the selected day that serve the selected starting stop. */
function dayTrips() {
  const ymd = $("#service-day").value;
  const index = Number($("#start-stop").value);
  return tripsOn(timetable, ymd).filter((trip) => index >= trip.firstStop);
}
function fillTrips(preferSeconds = null) {
  const select = $("#trip");
  const index = Number($("#start-stop").value);
  const trips = dayTrips();
  const previous = select.value;
  select.replaceChildren();
  for (const trip of trips) {
    const option = document.createElement("option");
    const here = trip.minutes[index - trip.firstStop] * 60;
    const origin = trip.firstStop === 0 ? "z Bílé Hory" : "z Vypichu";
    option.value = trip.id;
    option.textContent =
      index === trip.firstStop
        ? formatClock(here, false)
        : `${formatClock(here, false)} · spoj ${formatClock(trip.minutes[0] * 60, false)}`;
    option.title = `Spoj ${formatClock(trip.minutes[0] * 60, false)} ${origin}, příjezd Nádraží Hostivař ${formatClock(trip.minutes.at(-1) * 60, false)}`;
    select.append(option);
  }
  if (!trips.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Bez pravidelného spoje";
    select.append(option);
    return;
  }
  // Default to the next real departure at the current Prague time of day.
  const target = preferSeconds ?? pragueNow().seconds;
  if (preferSeconds == null && trips.some((t) => t.id === previous))
    select.value = previous;
  else select.value = chooseTrip(trips, index, target)?.id ?? trips[0].id;
}
function buildService(tripId, ymd, index) {
  const trip = timetable?.trips.find((t) => t.id === tripId);
  if (!trip || index < trip.firstStop) return null;
  const times = tripTimes(trip, route.stops.length);
  // At the terminus the crew is on the stand before departure; elsewhere
  // the tram has just arrived and still has to load passengers.
  const clockStart = times[index] - (index === trip.firstStop ? 150 : 40);
  const demand = createPassengerDemand({
    stops: route.stops,
    tripId: trip.id,
    times,
    clockStart,
    weekend: isWeekend(ymd),
    capacity: sim.capacity,
  });
  let load = 0;
  for (let i = trip.firstStop; i < index; i++)
    if (demand.requested(i)) {
      load -= demand.alighting(i, load);
      load = Math.min(sim.capacity, load + demand.boarding(i));
    }
  return { trip, times, clockStart, demand, ymd, load };
}
/** Prague time of the running service; start() always sets its origin. */
function serviceClock(snap = sim?.getSnapshot()) {
  return Number.isFinite(snap?.clock) ? snap.clock : 8 * 3600;
}
function showToast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $("#toast").classList.add("hidden"), 4200);
}
function openDialog(id) {
  const d = $(`#${id}-dialog`);
  if (d.open) return;
  dialogWasPlaying = playing && !paused;
  sanding(false);
  keys.clear();
  drag = null;
  paused = true;
  d.showModal();
  if (id === "map") drawFullMap();
}
function closeDialog() {
  const d = $("dialog[open]");
  if (d) d.close();
  if (dialogWasPlaying && playing) paused = false;
  dialogWasPlaying = false;
}
function pause() {
  if (!playing) return;
  save();
  openDialog("pause");
}
function menu() {
  save();
  sanding(false);
  keys.clear();
  drag = null;
  world.walker.reset();
  $$("dialog[open]").forEach((d) => d.close());
  playing = false;
  paused = false;
  ui.hud.classList.add("hidden");
  ui.menu.classList.remove("hidden");
  world.setCamera(1);
  world.setWeather($("#weather").value);
  menuService();
  savedState = safelyReadSave();
  $("#resume").classList.toggle("hidden", !savedState);
}
function start(resume = false) {
  closeDialog();
  keys.clear();
  drag = null;
  selectedWeather = resume
    ? (savedState?.weather ?? "clear")
    : $("#weather").value;
  // The former "Podvečer" weather is now a real time of day.
  if (selectedWeather === "evening") selectedWeather = "clear";
  startIndex = resume
    ? (savedState?.startIndex ?? 15)
    : Number($("#start-stop").value);
  service = resume
    ? buildService(
        savedState?.tripId,
        savedState?.serviceDay,
        savedState?.startIndex ?? startIndex,
      )
    : buildService($("#trip").value, $("#service-day").value, startIndex);
  const mode = resume ? savedState?.state?.mode : $("#mode").value;
  const state =
    resume && savedState
      ? {
          ...savedState.state,
          passengerDemand: service?.demand ?? null,
          schedule:
            mode === "service" ? (savedState.state.schedule ?? null) : null,
          clockStart:
            savedState.state.clockStart ?? service?.clockStart ?? 8 * 3600,
        }
      : {
          startS: route.stops[startIndex].s,
          startStopIndex: startIndex,
          mode,
          weather: selectedWeather === "rain" ? "rain" : "clear",
          passengers: service ? service.load : startIndex === 0 ? 0 : 34,
          passengerDemand: service?.demand ?? null,
          schedule: mode === "service" ? (service?.times ?? null) : null,
          clockStart: service?.clockStart ?? 8 * 3600,
        };
  sim.reset(state);
  clockDay =
    service?.ymd ??
    (resume ? savedState?.serviceDay : $("#service-day").value) ??
    pragueNow().ymd;
  world.serviceDemand = service?.demand ?? null;
  world.setClock(clockDay, serviceClock());
  world.resetStreetLife(sim.s);
  world.setQuality($("#quality").value);
  world.setWeather(selectedWeather);
  world.setCamera(0);
  $("#camera-button span").textContent = cameraNames[0];
  playing = true;
  paused = false;
  previousStop = sim.nextStopIndex;
  lastMessage = "";
  ui.controller.value = 0;
  ui.menu.classList.add("hidden");
  ui.hud.classList.remove("hidden");
  audio.start();
  const currentStop = route.stops[sim.nextStopIndex] ?? route.stops.at(-1);
  const announcement =
    Math.abs(currentStop.s - sim.s) < 18 ? "Zastávka" : "Příští zastávka";
  audio.announce(
    `Linka dvacet dva, směr Nádraží Hostivař. ${announcement} ${currentStop.name}.`,
  );
  if (service && mode === "service")
    showToast(
      `Spoj ${formatClock(service.times[service.trip.firstStop], false)} · odjezd ze zastávky ${currentStop.name} v ${formatClock(service.times[startIndex], false)} podle jízdního řádu PID.`,
    );
  updateHUD();
  drawMiniMap();
  try {
    if (!localStorage.getItem("praha22-intro")) {
      localStorage.setItem("praha22-intro", "1");
      openDialog("help");
    }
  } catch {}
}
// Spoken in the order of the on-board information system: the stop, any
// interchange, and at the terminus the request to leave the tram.
function arrivalAnnouncement(index) {
  const stop = route.stops[index];
  if (!stop) return "Konečná zastávka.";
  const parts = [`${stop.name}.`];
  if (TRANSFERS[stop.name]) parts.push(TRANSFERS[stop.name]);
  if (index === route.stops.length - 1)
    parts.push("Konečná zastávka, prosíme, vystupte.");
  return parts.join(" ");
}
function nextStopAnnouncement(index) {
  const stop = route.stops[index];
  if (!stop) return "";
  return `Příští zastávka: ${stop.name}${stop.request ? ", na znamení" : ""}.`;
}
function setController(value) {
  if (!playing || paused || world.walker.active) return;
  sim.setController(value);
  ui.controller.value = sim.throttle;
  updateHUD();
}
function doors() {
  if (!playing || paused || world.walker.active) return;
  if (sim.toggleDoors()) {
    audio.doors(sim.doors);
    if (sim.doors && sim.getSnapshot().serviceState === "boarding")
      audio.announce(arrivalAnnouncement(sim.nextStopIndex));
  }
  updateHUD();
}
function bell() {
  if (!playing || paused || world.walker.active) return;
  audio.bell();
  world.ringBell?.();
}
function emergency() {
  if (!playing || paused || world.walker.active) return;
  sim.emergencyBrake();
  ui.controller.value = -1;
  updateHUD();
}
function sanding(active) {
  if (!sim) return;
  sim.setSanding(active && playing && !paused && !world?.walker.active);
  $("#sanding").classList.toggle("active", sim.sanding);
}
function camera() {
  if (!playing || paused || world.walker.active) return;
  world.setCamera((world.cameraMode + 1) % 3);
  $("#camera-button span").textContent = cameraNames[world.cameraMode];
}
function walk() {
  if (!playing || paused) return;
  const error = world.walker.interact(sim);
  if (error) {
    showToast(error);
    return;
  }
  keys.clear();
  drag = null;
  sanding(false);
  showToast(
    world.walker.active
      ? "Jste venku · WASD pohyb, Shift rychleji, R nástup u dveří."
      : "Zpět v kabině. Zavřete dveře klávesou E.",
  );
  updateHUD();
  drawMiniMap();
}
function handleAction(action) {
  if (action === "help") openDialog("help");
  if (action === "map") openDialog("map");
  if (action === "sources") openDialog("sources");
  if (action === "pause") pause();
  if (action === "close" || action === "continue") closeDialog();
  if (action === "menu") menu();
}
$$("[data-action]").forEach((el) =>
  el.addEventListener("click", () => handleAction(el.dataset.action)),
);
$$("dialog").forEach((d) => {
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog();
  });
  d.addEventListener("click", (e) => {
    if (e.target === d) {
      const rect = d.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      )
        closeDialog();
    }
  });
});
$("#start").addEventListener("click", () => start());
$("#resume").addEventListener("click", () => start(true));
ui.controller.addEventListener("input", (e) =>
  setController(Number(e.target.value)),
);
ui.doors.addEventListener("click", doors);
$("#bell").addEventListener("click", bell);
$("#emergency").addEventListener("click", emergency);
$("#camera-button").addEventListener("click", camera);
$("#walk-button").addEventListener("click", walk);
$$("[data-walk-key]").forEach((button) => {
  const release = () => keys.delete(button.dataset.walkKey);
  button.addEventListener("pointerdown", (e) => {
    if (!playing || paused || !world.walker.active) return;
    e.preventDefault();
    button.setPointerCapture(e.pointerId);
    keys.add(button.dataset.walkKey);
  });
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
});
$("#sanding").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.target.setPointerCapture?.(e.pointerId);
  sanding(true);
});
$("#sanding").addEventListener("pointerup", () => sanding(false));
$("#sanding").addEventListener("pointercancel", () => sanding(false));
$("#quality").addEventListener("change", () => {
  const quality = $("#quality").value;
  world?.setQuality(quality);
  try {
    localStorage.setItem("praha22-quality", quality);
  } catch {}
});
$("#weather").addEventListener("change", () =>
  world?.setWeather($("#weather").value),
);
$("#start-stop").addEventListener("change", () => {
  fillTrips();
  menuService();
  world.resetStreetLife(route.stops[Number($("#start-stop").value)].s);
});
$("#service-day").addEventListener("change", () => {
  fillTrips();
  menuService();
});
$("#trip").addEventListener("change", menuService);
/** The menu backdrop shows the selected trip's real light and passengers. */
function menuService() {
  if (!world || !route || playing) return;
  const index = Number($("#start-stop").value);
  const preview = buildService(
    $("#trip").value,
    $("#service-day").value,
    index,
  );
  world.serviceDemand = preview?.demand ?? null;
  world.setClock(
    preview?.ymd ?? $("#service-day").value,
    preview ? preview.times[index] : pragueNow().seconds,
  );
  world.setWeather($("#weather").value);
}
let muted = false;
$("#audio-toggle").addEventListener("click", () => {
  muted = !muted;
  audio.setMuted(muted);
  $("#audio-toggle").textContent = muted ? "ZVUK VYPNUTÝ" : "ZVUK ZAPNUTÝ";
});
const keys = new Set();
document.addEventListener("keydown", (e) => {
  if (
    (["SELECT", "TEXTAREA"].includes(e.target.tagName) ||
      (e.target.tagName === "INPUT" && e.target.type !== "range")) &&
    e.code !== "Escape"
  )
    return;
  if (
    e.target.id === "controller" &&
    ["ArrowLeft", "ArrowRight"].includes(e.code)
  )
    return;
  if (e.code === "Escape") {
    e.preventDefault();
    if ($("dialog[open]")) closeDialog();
    else pause();
    return;
  }
  if ($("dialog[open]")) return;
  if (e.code === "KeyH") {
    e.preventDefault();
    openDialog("help");
    return;
  }
  if (e.code === "KeyM") {
    e.preventDefault();
    openDialog("map");
    return;
  }
  if (!playing || paused) return;
  keys.add(e.code);
  if (
    [
      "KeyW",
      "KeyS",
      "KeyA",
      "KeyD",
      "Space",
      "ArrowLeft",
      "ArrowRight",
      "KeyX",
      "KeyE",
      "KeyB",
      "KeyC",
      "KeyR",
    ].includes(e.code)
  )
    e.preventDefault();
  if (e.code === "KeyR") {
    if (!e.repeat) walk();
    return;
  }
  if (e.code === "KeyF") {
    if (e.repeat) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
    return;
  }
  if (world.walker.active) return;
  if (e.code === "KeyW")
    setController(Math.min(1, Math.round((sim.throttle + 0.2) * 5) / 5));
  if (e.code === "KeyS")
    setController(Math.max(-1, Math.round((sim.throttle - 0.2) * 5) / 5));
  if (e.code === "KeyX") setController(0);
  if (e.code === "Space") emergency();
  if (e.code === "KeyG") {
    e.preventDefault();
    sanding(true);
  }
  if (e.repeat) return;
  if (e.code === "KeyE") doors();
  if (e.code === "KeyB") bell();
  if (e.code === "KeyC") camera();
  if (e.code === "KeyV") {
    world.wipers = !world.wipers;
    showToast(world.wipers ? "Stěrače zapnuté" : "Stěrače vypnuté");
  }
});
document.addEventListener("keyup", (e) => {
  keys.delete(e.code);
  if (e.code === "KeyG") sanding(false);
});
window.addEventListener("blur", () => {
  keys.clear();
  sanding(false);
  drag = null;
});
let drag = null;
$("#world").addEventListener("pointerdown", (e) => {
  if (playing && !paused && (world.cameraMode === 0 || world.walker.active)) {
    drag = {
      x: e.clientX,
      y: e.clientY,
      look: world.walker.active ? world.walker.yaw : world.look,
      pitch: world.walker.active ? world.walker.pitch : world.pitch,
      walking: world.walker.active,
    };
    $("#world").setPointerCapture(e.pointerId);
  }
});
$("#world").addEventListener("pointermove", (e) => {
  if (drag) {
    if (drag.walking) {
      world.walker.yaw = drag.look - (e.clientX - drag.x) * 0.004;
      world.walker.pitch = Math.max(
        -1.2,
        Math.min(1.2, drag.pitch + (e.clientY - drag.y) * 0.003),
      );
      return;
    }
    world.look = Math.max(
      -1.35,
      Math.min(1.35, drag.look - (e.clientX - drag.x) * 0.004),
    );
    world.pitch = Math.max(
      -0.3,
      Math.min(0.3, drag.pitch + (e.clientY - drag.y) * 0.002),
    );
  }
});
$("#world").addEventListener("pointerup", () => (drag = null));
$("#world").addEventListener("pointercancel", () => (drag = null));
$("#world").addEventListener("lostpointercapture", () => (drag = null));
$("#world").addEventListener("dblclick", () => {
  if (world) {
    if (world.walker.active) {
      world.walker.pitch = 0;
      return;
    }
    world.look = 0;
    world.pitch = 0;
  }
});
window.addEventListener("resize", () => world?.resize());
document.addEventListener("visibilitychange", () => {
  if (document.hidden && playing && !paused) pause();
});
window.addEventListener("pagehide", save);

function updateHUD() {
  if (!sim) return;
  const snap = sim.getSnapshot(),
    next = snap.nextStop;
  const walking = world.walker.active;
  const doorDistance = walking ? world.walker.distanceToDoor() : 0;
  ui.hud.classList.toggle("walking", walking);
  $("#walking-panel").classList.toggle("hidden", !walking);
  $("#walk-label").textContent = walking ? "Nastoupit" : "Vystoupit";
  $("#walk-button").classList.toggle("active", walking);
  $("#walk-button").title = walking
    ? "Nastoupit u otevřených dveří (R)"
    : "Vystoupit ze stojící tramvaje s otevřenými dveřmi (R)";
  $("#camera-button span").textContent = walking
    ? "Pěšky"
    : cameraNames[world.cameraMode];
  $("#camera-button").disabled = walking;
  ui.controller.disabled = walking;
  for (const id of ["doors", "bell", "emergency", "sanding"])
    $(`#${id}`).disabled = walking;
  $("#walking-distance").textContent =
    doorDistance <= 2.4
      ? "U dveří · R pro nástup"
      : `${Math.round(doorDistance)} m k nejbližším dveřím`;
  ui.speed.textContent = Math.round(snap.speedKmh);
  ui.speed.style.color = snap.speedKmh > snap.limit + 2 ? "#e19b83" : "";
  ui.limit.textContent = snap.limit;
  $("#speed-line").setAttribute(
    "d",
    `M0 8H${Math.min(200, (snap.speedKmh / 65) * 200)}`,
  );
  ui.score.textContent = rating(snap);
  ui.name.textContent = next?.name ?? "Konečná zastávka";
  ui.distance.textContent = next
    ? `${Math.abs(next.distance) < 18 ? "U označníku" : `${Math.round(next.distance)} m`}`
    : "Služba dokončena";
  const areaS = walking ? route.nearest(world.walker.position).s : snap.s;
  $("#current-area").textContent = `Praha · ${route.area(areaS)}`;
  $("#map-area").textContent = route.area(areaS);
  $("#game-clock").textContent = formatClock(serviceClock(snap));
  const schedule = snap.schedule;
  const scheduleStatus = $("#schedule-status");
  const hold = snap.departureHold;
  if (hold && snap.speedKmh < 2) {
    // Served and closed, still at the platform: count down to departure.
    scheduleStatus.textContent = `Odjezd ${formatClock(hold.scheduled, false)} · ${
      hold.wait > 5
        ? `za ${formatDeviation(hold.wait).replace("+", "")}`
        : "odjezd"
    }`;
    scheduleStatus.className = hold.wait > 5 ? "schedule early" : "schedule";
  } else if (!schedule) scheduleStatus.className = "schedule hidden";
  else {
    const deviation = Math.round(schedule.deviation);
    scheduleStatus.textContent = `Odjezd ${formatClock(schedule.scheduledDeparture, false)} · ${
      Math.abs(deviation) < 30
        ? "včas"
        : deviation > 0
          ? `zpoždění ${formatDeviation(deviation)}`
          : `náskok ${formatDeviation(-deviation).replace("+", "")}`
    }`;
    scheduleStatus.className =
      deviation < -5 && (schedule.atStop || snap.speedKmh < 1)
        ? "schedule early"
        : deviation > 180
          ? "schedule late"
          : "schedule";
  }
  const request = snap.nextStopRequest;
  $("#request-lamp").classList.toggle("hidden", !request);
  $("#request-lamp").classList.toggle("lit", Boolean(request?.requested));
  $("#request-lamp").textContent = request?.requested
    ? "ZNAMENÍ · ZASTAVÍ"
    : "NA ZNAMENÍ";
  const nextLimit = snap.nextLimit;
  $("#limit-next").textContent = nextLimit
    ? `${nextLimit.limit} za ${Math.max(10, Math.round(nextLimit.distance / 10) * 10)} m`
    : "";
  $("#passengers").textContent = snap.passengers;
  $("#traction-power").textContent = `${Math.round(snap.powerKW)} kW`;
  $("#traction-current").textContent =
    `${Math.round(snap.tractionCurrentA > 0 ? snap.tractionCurrentA : -snap.brakeCurrentA)} A`;
  $("#adhesion-status").textContent = snap.sanding
    ? "Písek na kolejnicích"
    : snap.wheelSlip
      ? "Skluz · přidržte G"
      : snap.brakingUnsafe
        ? "Dlouhá brzdná dráha · přidržte G"
        : snap.railCondition === "leaves"
          ? "Listí · brzděte s předstihem"
          : snap.nextRailCondition?.condition === "leaves"
            ? `Listí za ${Math.ceil(snap.nextRailCondition.distance)} m`
            : snap.railWetness > 0.25
              ? "Mokré koleje · nižší adheze"
              : "Adheze v pořádku";
  $("#adhesion-status").classList.toggle(
    "slip",
    snap.wheelSlip || snap.brakingUnsafe,
  );
  $("#sanding").classList.toggle("active", snap.sanding);
  $("#braking-distance").textContent = snap.brakingUnsafe
    ? "> 1 000 m"
    : `${Math.ceil(snap.brakingDistance)} m`;
  $("#brake-temperature").textContent =
    `${Math.round(snap.brakeTemperatureC)} °C`;
  $("#ride-comfort").textContent = `${Math.round(snap.comfortRating)} %`;
  $("#ride-comfort").classList.toggle("caution", snap.comfortStress > 0.7);
  $("#brake-temperature").classList.toggle(
    "caution",
    snap.brakeTemperatureC > 300,
  );
  $("#doors-label").textContent = snap.doors
    ? "Zavřít dveře"
    : snap.doorProgress > 0
      ? "Zavírání…"
      : "Otevřít dveře";
  ui.doors.classList.toggle("active", snap.doors);
  const plan = snap.boardingPlan;
  $("#dwell-label").textContent = snap.doors
    ? snap.dwell >= snap.dwellRequired
      ? "Nástup dokončen"
      : plan
        ? `↓${plan.off} ↑${plan.on} · ${Math.ceil(snap.dwellRequired - snap.dwell)} s`
        : `Nástup · ${Math.ceil(snap.dwellRequired - snap.dwell)} s`
    : `${snap.completedStops} obsloužených zastávek`;
  $("#controller-label").textContent = snap.emergency
    ? "NOUZOVÁ BRZDA"
    : snap.throttle > 0
      ? `VÝKON ${Math.round(snap.throttle * 100)} %`
      : snap.throttle < 0
        ? `BRZDA ${Math.round(-snap.throttle * 100)} %`
        : "VÝBĚH";
  ui.controller.value = snap.throttle;
  ui.advice.textContent = walking
    ? "Tramvaj je zabrzděná. Pro návrat přijďte k otevřeným dveřím a stiskněte R."
    : snap.message;
  $("#stop-advice>small").textContent = walking
    ? "PROCHÁZKA PO PRAZE"
    : snap.mode === "free"
      ? "VOLNÁ JÍZDA"
      : snap.serviceState === "boarding"
        ? "ODBAVENÍ CESTUJÍCÍCH"
        : "LINKOVÝ PROVOZ";
  const signal = snap.nearestSignal;
  $("#signal-aspect").className = `signal-aspect ${signal?.aspect ?? "go"}`;
  $("#signal-text").textContent = signal?.aspect === "stop" ? "Stůj" : "Volno";
  $("#signal-distance").textContent = signal
    ? `${Math.round(signal.distance)} m`
    : "Volná trať";
  $("#service-status").textContent = paused
    ? "Jízda pozastavena"
    : walking
      ? "Pěšky · tramvaj zabrzděná"
      : snap.emergency
        ? "Nouzová brzda"
        : snap.doors
          ? "Dveře otevřené · trakce blokována"
          : snap.serviceState === "ready"
            ? "Odbaveno · zavřete dveře"
            : `${route.area(snap.s)} · ${(snap.distanceRemaining / 1000).toFixed(1)} km do konečné`;
  if (snap.nextStopIndex !== previousStop) {
    previousStop = snap.nextStopIndex;
    if (next) {
      audio.announce(nextStopAnnouncement(snap.nextStopIndex));
      showToast(
        `Příští zastávka: ${next.name}${next.request ? " · na znamení" : ""}`,
      );
    }
  }
  if (
    snap.message !== lastMessage &&
    /Nouzová|blokované|Překročená|Střet|vynechána|Návěst/.test(snap.message)
  ) {
    showToast(snap.message);
  }
  lastMessage = snap.message;
  if (snap.finished && !$("#finish-dialog").open) {
    save();
    const punctuality = service
      ? ` Příjezd ${formatClock(serviceClock(snap), false)} (jízdní řád ${formatClock(service.times.at(-1), false)}), včasné odjezdy ${snap.punctualDepartures}, předčasné ${snap.violations.earlyDepartures}.`
      : "";
    $("#finish-stats").textContent =
      `Služba dokončena za ${Math.floor(snap.time / 60)} minut. Obslouženo ${snap.completedStops} zastávek.${punctuality} Hodnocení ${rating(snap)}/100, porušení pravidel ${snap.violationCount}.`;
    openDialog("finish");
  }
}
function mapCanvas(canvas, center, scale, width, height, rotation = 0) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#172e28";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(rotation);
  ctx.scale(scale, scale);
  ctx.translate(-center.x, -center.z);
  const bounds = Math.max(width, height) / scale;
  const inView = (p) =>
    Math.abs(p.x - center.x) < bounds && Math.abs(p.z - center.z) < bounds;
  ctx.fillStyle = "#263e30";
  for (const park of city.parks ?? []) {
    const ps =
      park.mapPoints ??
      (park.mapPoints = park.points.map((p) => route.project(...p)));
    if (!ps.some(inView)) continue;
    ctx.beginPath();
    ps.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = "#335458";
  for (const water of city.waters ?? []) {
    const ps =
      water.mapPoints ??
      (water.mapPoints = water.points.map((p) => route.project(...p)));
    if (!ps.some(inView) && !water.name?.includes("Vltava")) continue;
    ctx.beginPath();
    ps.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = "#49604b";
  for (const b of city.buildings) {
    const ps =
      b.mapPoints ?? (b.mapPoints = b.points.map((p) => route.project(...p)));
    if (!inView(ps[0])) continue;
    ctx.beginPath();
    ps.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = "#66705b";
  ctx.lineWidth = 1.2 / scale;
  for (const r of city.roads ?? []) {
    const ps =
      r.mapPoints ?? (r.mapPoints = r.points.map((p) => route.project(...p)));
    if (!ps.some(inView)) continue;
    ctx.beginPath();
    ps.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
    ctx.stroke();
  }
  ctx.strokeStyle = "#ccb17d";
  ctx.lineWidth = 3 / scale;
  ctx.lineJoin = "round";
  ctx.beginPath();
  route.points.forEach((p, i) =>
    i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z),
  );
  ctx.stroke();
  for (const stop of route.stops) {
    const p = route.flat(stop.s);
    if (!inView(p)) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.z, 2.8 / scale, 0, Math.PI * 2);
    ctx.fillStyle = "#e6d5aa";
    ctx.fill();
  }
  const player = route.at(
    playing ? sim.s : route.stops[Number($("#start-stop").value)].s,
  );
  ctx.save();
  ctx.translate(player.x, player.z);
  ctx.rotate(player.yaw);
  ctx.fillStyle = "#df6f58";
  ctx.strokeStyle = "#f7e9b8";
  ctx.lineWidth = 1.5 / scale;
  ctx.beginPath();
  ctx.moveTo(0, -8 / scale);
  ctx.lineTo(-5 / scale, 5 / scale);
  ctx.lineTo(5 / scale, 5 / scale);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  if (playing && world.walker.active) {
    const walker = world.walker;
    ctx.save();
    ctx.translate(walker.position.x, walker.position.z);
    ctx.rotate(walker.yaw);
    ctx.fillStyle = "#e6d5aa";
    ctx.beginPath();
    ctx.arc(0, 0, 4 / scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#e6d5aa";
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -10 / scale);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  return ctx;
}
function drawMiniMap() {
  if (!route) return;
  const p = world.walker.active
      ? { ...world.walker.position, yaw: world.walker.yaw }
      : route.at(sim.s),
    c = $("#minimap"),
    ctx = mapCanvas(c, p, 0.3, c.width, c.height, p.yaw);
  ctx.font = "9px sans-serif";
  ctx.fillStyle = "#a2bba4";
  ctx.fillText("100 m", 12, 206);
  ctx.strokeStyle = "#a2bba4";
  ctx.beginPath();
  ctx.moveTo(12, 194);
  ctx.lineTo(42, 194);
  ctx.stroke();
}
function drawFullMap() {
  if (!route) return;
  const xs = route.points.map((p) => p.x),
    zs = route.points.map((p) => p.z),
    minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minZ = Math.min(...zs),
    maxZ = Math.max(...zs),
    c = $("#route-map"),
    scale = Math.min(
      (c.width - 80) / (maxX - minX),
      (c.height - 80) / (maxZ - minZ),
    ),
    center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
    ctx = mapCanvas(c, center, scale, c.width, c.height);
  ctx.font = "14px sans-serif";
  ctx.fillStyle = "#ddd0ad";
  for (const idx of [0, 10, 14, 15, 18, 23, 27, 36, 43]) {
    const stop = route.stops[idx],
      p = route.flat(stop.s),
      x = (p.x - center.x) * scale + c.width / 2,
      y = (p.z - center.z) * scale + c.height / 2;
    const textWidth = ctx.measureText(stop.name).width;
    ctx.fillText(
      stop.name,
      Math.max(10, Math.min(c.width - textWidth - 10, x + 8)),
      Math.max(18, y - 8),
    );
  }
  $$("#stop-list>div").forEach((el, i) =>
    el.classList.toggle(
      "current",
      i === (playing ? sim.nextStopIndex : Number($("#start-stop").value)),
    ),
  );
}
function sourceHTML(data) {
  const links = [
    ...(data.sources ?? []),
    {
      title: "Tatra T3R.P — technické údaje DPP",
      url: "https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p",
    },
    {
      title: "OpenStreetMap a licence ODbL",
      url: "https://www.openstreetmap.org/copyright",
    },
    {
      title:
        "Datový podklad © IPR Praha — technická mapa vozovek a chodníků (CC BY 4.0)",
      url: "https://dmvs.cuzk.gov.cz/portal/vydej-dat/verejne-datove-sady",
    },
    {
      title: "Zaměřené osy jednotlivých kolejí — veřejná DI v DMVS",
      url: "https://www.cuzk.gov.cz/DMVS/Poskytovani-dat.aspx",
    },
    {
      title: "Fotografické materiály a HDR — Poly Haven (CC0)",
      url: "https://polyhaven.com/license",
    },
    {
      title: "Okolní terén — Copernicus DEM / Open-Meteo",
      url: "https://open-meteo.com/en/docs/elevation-api",
    },
    {
      title: "Pražská dlažba — manuál IPR Praha",
      url: "https://iprpraha.cz/uploads/assets/manual_tvorby_verejnych_prostranstvi/pdf/D.1.pdf",
    },
  ];
  const node = document.createElement("div");
  const left = document.createElement("section");
  left.innerHTML =
    "<h3>Skutečné podklady</h3><p>Celá pravidelná trasa linky 22 ve směru Bílá Hora → Nádraží Hostivař. Oficiální souřadnice zastávek a geometrie PID GTFS. Půdorysy budov, okolní komunikace, řeka, zeleň a části katedrály sv. Víta pocházejí z OpenStreetMap. Hrany vozovek, chodníků, nástupišť a tramvajových pásů doplňuje pražská digitální technická mapa z veřejných dat DMVS: stav 30. září 2026 se změnami do 13. října 2026. Datový podklad © IPR Praha, CC BY 4.0, převedený do herní scény. Datum databáze neznamená nové zaměření každé ulice. Okolní kopce vycházejí z výškových dat Copernicus.</p><h3>Zdroje</h3>";
  links.forEach((link) => {
    const p = document.createElement("p"),
      a = document.createElement("a");
    a.textContent = link.title;
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener";
    p.append(a);
    left.append(p);
  });
  const right = document.createElement("section");
  right.innerHTML =
    '<h3>Co se simuluje</h3><p>Souprava Tatra T3R.P, sílová fyzika, výkon, sklony, adheze, pískování, rekuperace a elektrická i mechanická brzda. Chodci chodí k přechodům a dveřím, auta tvoří fronty a reagují na semafory a nástup. Modely tramvaje, kabiny, automobilů a lidí vznikly v Blenderu. Fotografické PBR materiály, HDR a optimalizovaný strom jsou z Poly Haven (CC0).</p><h3>Míra věrnosti</h3><p>Trať a půdorysy mají skutečné geografické podklady. Dostupné ověřené výšky hran komunikací doplňují terénní model; mezi nimi se výška odvozuje. Chybějící nebo nejisté zaměření zůstává aproximací. Fasády, detaily dominant, výšky některých budov, jízdní fyzika a provoz jsou rekonstrukce pro hru. Návěstní cykly a rychlostní omezení jsou herní aproximace. Krátkodobé výluky nejsou simulovány.</p><p>Zvuk jízdy a zvonku je syntetický. Hlášení používá český hlas prohlížeče, pokud je dostupný.</p><p class="quiet">Podklady pořízeny 14. 10. 2026 · PID CC BY 4.0 · © přispěvatelé OpenStreetMap, ODbL · datový podklad © IPR Praha, CC BY 4.0 · Poly Haven CC0</p>';
  $("#source-content").append(left, right);
}
function frame(time) {
  requestAnimationFrame(frame);
  const frameSeconds = lastTime ? (time - lastTime) / 1000 : 0;
  const dt = Math.min(0.2, frameSeconds);
  lastTime = time;
  frameCount++;
  fpsTime += frameSeconds;
  if (fpsTime > 1) {
    fps = Math.round(frameCount / fpsTime);
    frameCount = 0;
    fpsTime = 0;
    $("#fps").textContent = `${fps} FPS`;
    if (world && sim) {
      $("#fps").dataset.scene = JSON.stringify(world.stats());
      const snapshot = sim.getSnapshot();
      $("#fps").dataset.physics = JSON.stringify({
        s: sim.s,
        speed: snapshot.speedKmh,
        acceleration: snapshot.acceleration,
        power: snapshot.powerKW,
        slip: snapshot.wheelSlip,
        sanding: snapshot.sanding,
        brakingDistance: snapshot.brakingDistance,
        damage: snapshot.damage,
      });
    }
  }
  if (!world || !sim) return;
  if (playing) {
    if (!paused) {
      if (world.walker.active) world.walker.update(dt, keys);
      else {
        if (keys.has("ArrowLeft"))
          world.look = Math.max(-1.35, world.look - dt);
        if (keys.has("ArrowRight"))
          world.look = Math.min(1.35, world.look + dt);
      }
      sim.update(dt);
      audio.update(sim.getSnapshot(), dt);
      world.setClock(clockDay, serviceClock());
      world.update(dt, sim);
      saveTime += dt;
      if (saveTime > 4) {
        save();
        saveTime = 0;
      }
    } else {
      audio.update(
        {
          ...sim.getSnapshot(),
          speed: 0,
          speedKmh: 0,
          throttle: 0,
          paused: true,
        },
        dt,
      );
      world.update(0, sim);
    }
    hudTime += dt;
    mapTime += dt;
    if (hudTime > 0.1) {
      updateHUD();
      hudTime = 0;
    }
    if (mapTime > 0.5) {
      drawMiniMap();
      mapTime = 0;
    }
  } else {
    const s = route.stops[Number($("#start-stop").value)].s;
    world.update(
      dt,
      { s, doorProgress: 0, time: 0, speed: 0, nextStopIndex: 0 },
      true,
    );
  }
}
async function init() {
  const loadingStarted = performance.now();
  const sceneryReady = loadBinary(
    `${import.meta.env.BASE_URL}${import.meta.env.SCENERY_ASSET}`,
  ).catch((error) => {
    console.warn("Předpočítané ulice nejsou dostupné:", error.message);
    return null;
  });
  try {
    const [
      data,
      map,
      crossings,
      terrain,
      skyline,
      publicSpaces,
      context,
      landmarkParts,
      streetNetwork,
      streetSurfaces,
      surveyedTrackAxes,
      timetableData,
      speedLimits,
    ] = await Promise.all([
      loadJSON(`${import.meta.env.BASE_URL}data/route22.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/city.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/crossings.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/terrain.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/skyline.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/public-spaces.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/city-context.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/landmark-parts.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/street-network.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/street-surfaces.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/dtm-track-axes.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/timetable22.json`),
      loadJSON(`${import.meta.env.BASE_URL}data/speed-limits.json`),
    ]);
    map.crossings = crossings.crossings;
    map.skyline = skyline;
    map.publicSpaces = publicSpaces;
    map.context = context;
    map.landmarkParts = landmarkParts;
    const mergeById = (original, precise) => [
      ...new Map([
        ...(original ?? []).map((feature) => [feature.osmId, feature]),
        ...(precise ?? []).map((feature) => [feature.osmId, feature]),
      ]).values(),
    ];
    map.roads = mergeById(map.roads, streetNetwork.roads);
    map.rails = mergeById(map.rails, streetNetwork.rails);
    // The tram bridge's sidewalks belong to the same deck. Other elevated
    // or underground paths need their own height data rather than flattening.
    map.publicSpaces.paths = mergeById(
      map.publicSpaces.paths,
      (streetNetwork.sidewalkPaths ?? []).filter(
        (path) =>
          path.tunnel !== "yes" &&
          (!Number(path.layer) ||
            (path.bridge === "yes" &&
              path.points.some(
                ([lat, lon]) =>
                  lat > 50.0803 &&
                  lat < 50.0819 &&
                  lon > 14.4065 &&
                  lon < 14.4138,
              ))),
      ),
    );
    map.publicSpaces.areas = mergeById(
      map.publicSpaces.areas,
      streetNetwork.carriagewayAreas,
    );
    map.streetNetwork = streetNetwork;
    map.streetSurfaces = streetSurfaces;
    map.surveyedTrackAxes = surveyedTrackAxes;
    for (const building of map.buildings)
      Object.assign(
        building,
        context.buildingAttributes?.[building.osmId] ?? {},
      );
    route = new Route(data, terrain, map);
    route.setSpeedLimits(speedLimits);
    timetable = timetableData;
    // GTFS pickup/drop-off type 3: the tram calls only on request.
    for (const index of timetable.requestStops ?? [])
      if (route.stops[index]) route.stops[index].request = true;
    city = map;
    route.stops.forEach((stop, i) => {
      const option = document.createElement("option");
      option.value = i;
      option.textContent = stop.name;
      $("#start-stop").append(option);
      const row = document.createElement("div"),
        num = document.createElement("span");
      num.textContent = String(i + 1).padStart(2, "0");
      row.append(num, document.createTextNode(stop.name));
      $("#stop-list").append(row);
    });
    $("#start-stop").value = 15;
    for (const day of serviceDays(timetable)) {
      const option = document.createElement("option");
      option.value = day.ymd;
      // Compact for the menu: "Ne 18. 10. · dnes".
      const [, relative, name, date] =
        /^(?:(Dnes|Zítra) · )?(\S+) (.+)$/.exec(day.label) ?? [];
      option.textContent = name
        ? `${name[0].toUpperCase()}${name[1]} ${date}${relative ? ` · ${relative.toLowerCase()}` : ""}`
        : day.label;
      option.title = day.label;
      $("#service-day").append(option);
    }
    const runtimes = timetable.trips
      .filter((trip) => trip.firstStop === 0)
      .map((trip) => trip.minutes.at(-1) - trip.minutes[0]);
    $("#route-stats").textContent =
      `${(route.length / 1000).toFixed(1)} km · ${route.stops.length} zastávek · jízdní doba ${runtimes.length ? `${Math.min(...runtimes)}–${Math.max(...runtimes)}` : 65} minut`;
    sourceHTML(data);
    world = new World(
      $("#world"),
      route,
      city,
      (t) => ($("#loading-status").textContent = t),
      $("#quality").value,
    );
    world.prebuiltSceneryReady = sceneryReady;
    // The menu opens on the next real departure; load the sky for its hour.
    {
      const now = pragueNow();
      const firstDay = serviceDays(timetable)[0]?.ymd ?? now.ymd;
      const trip = chooseTrip(tripsOn(timetable, firstDay), 15, now.seconds);
      world.setClock(
        firstDay,
        trip ? trip.minutes[15 - trip.firstStop] * 60 : now.seconds,
      );
    }
    await world.init();
    world.setQuality($("#quality").value);
    sim = new TramSimulation({
      routeLength: route.length,
      stops: route.stops,
      signals: world.signalConfigs,
      getGrade: (s) => route.grade(s),
      getCurveRadius: (s) => route.curveRadius(s),
      getSpeedLimit: (s) => route.limit(s),
      railConditions: world.railConditions,
      profile: "T3R.P",
      carCount: 2,
      startS: route.stops[15].s,
      startStopIndex: 15,
    });
    audio = new TramAudio();
    savedState = safelyReadSave();
    world.loadingMs = Math.round(performance.now() - loadingStarted);
    $("#resume").classList.toggle("hidden", !savedState);
    fillTrips();
    menuService();
    ui.loading.classList.add("hidden");
    ui.menu.classList.remove("hidden");
    world.update(0, sim, true);
    requestAnimationFrame(frame);
    // Read-only diagnostics for reproducible browser verification and future development.
    window.tramDebug = {
      snapshot: () => sim.getSnapshot(),
      stats: () => ({
        ...world.stats(),
        fps,
        routeLength: route.length,
        stopCount: route.stops.length,
        playing,
        paused,
      }),
      route: () => ({ stops: route.stops, length: route.length }),
      walking: () => world.walker.snapshot(),
    };
  } catch (error) {
    console.error(error);
    ui.loading.classList.add("hidden");
    $("#fatal-error").classList.remove("hidden");
    $("#error-text").textContent =
      `${error.message}. Simulátor vyžaduje moderní prohlížeč s WebGL 2 a zapnutou hardwarovou akcelerací.`;
  }
}
init();
