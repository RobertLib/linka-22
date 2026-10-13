import "./style.css";
import { Route } from "./route.js";
import { World } from "./world.js";
import { TramSimulation } from "./simulation.js";
import { TramAudio } from "./audio.js";

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
  savedState = null;
const cameraNames = ["Kabina", "Za tramvají", "Nad městem"];
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
        updated: Date.now(),
      }),
    );
  } catch {}
}
function displayTime(seconds) {
  const t = Math.floor(seconds),
    hh = Math.floor(t / 3600) % 24,
    mm = Math.floor(t / 60) % 60,
    ss = t % 60;
  return [hh, mm, ss].map((v) => String(v).padStart(2, "0")).join(":");
}
function rating(snap) {
  const possible =
    1000 + 140 * (snap.completedStops + snap.violations.missedStops);
  return Math.max(0, Math.min(100, Math.round((100 * snap.score) / possible)));
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
  $$("dialog[open]").forEach((d) => d.close());
  playing = false;
  paused = false;
  ui.hud.classList.add("hidden");
  ui.menu.classList.remove("hidden");
  world.setCamera(1);
  world.setWeather($("#weather").value);
  savedState = safelyReadSave();
  $("#resume").classList.toggle("hidden", !savedState);
}
function start(resume = false) {
  closeDialog();
  selectedWeather = resume
    ? (savedState?.weather ?? "clear")
    : $("#weather").value;
  startIndex = resume
    ? (savedState?.startIndex ?? 15)
    : Number($("#start-stop").value);
  const state =
    resume && savedState
      ? savedState.state
      : {
          startS: route.stops[startIndex].s,
          startStopIndex: startIndex,
          mode: $("#mode").value,
          weather: selectedWeather === "rain" ? "rain" : "clear",
          passengers: startIndex === 0 ? 0 : 34,
        };
  sim.reset(state);
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
  updateHUD();
  drawMiniMap();
  try {
    if (!localStorage.getItem("praha22-intro")) {
      localStorage.setItem("praha22-intro", "1");
      openDialog("help");
    }
  } catch {}
}
function setController(value) {
  if (!playing || paused) return;
  sim.setController(value);
  ui.controller.value = sim.throttle;
  updateHUD();
}
function doors() {
  if (!playing || paused) return;
  if (sim.toggleDoors()) {
    audio.doors(sim.doors);
    if (sim.doors && sim.getSnapshot().serviceState === "boarding")
      audio.announce(
        route.stops[sim.nextStopIndex]?.name ?? "Konečná zastávka",
      );
  }
  updateHUD();
}
function bell() {
  if (!playing || paused) return;
  audio.bell();
  world.ringBell?.();
}
function emergency() {
  if (!playing || paused) return;
  sim.emergencyBrake();
  ui.controller.value = -1;
  updateHUD();
}
function sanding(active) {
  if (!sim) return;
  sim.setSanding(active && playing && !paused);
  $("#sanding").classList.toggle("active", sim.sanding);
}
function camera() {
  if (!playing) return;
  world.setCamera((world.cameraMode + 1) % 3);
  $("#camera-button span").textContent = cameraNames[world.cameraMode];
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
$("#sanding").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.target.setPointerCapture?.(e.pointerId);
  sanding(true);
});
$("#sanding").addEventListener("pointerup", () => sanding(false));
$("#sanding").addEventListener("pointercancel", () => sanding(false));
$("#quality").addEventListener("change", () =>
  world?.setQuality($("#quality").value),
);
$("#weather").addEventListener("change", () =>
  world?.setWeather($("#weather").value),
);
$("#start-stop").addEventListener("change", () => {
  world.cameraInitialized = false;
});
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
      "Space",
      "ArrowLeft",
      "ArrowRight",
      "KeyX",
      "KeyE",
      "KeyB",
      "KeyC",
    ].includes(e.code)
  )
    e.preventDefault();
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
  if (e.code === "KeyF") {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
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
  if (playing && !paused && world.cameraMode === 0) {
    drag = { x: e.clientX, y: e.clientY, look: world.look, pitch: world.pitch };
    $("#world").setPointerCapture(e.pointerId);
  }
});
$("#world").addEventListener("pointermove", (e) => {
  if (drag) {
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
  $("#current-area").textContent = `Praha · ${route.area(snap.s)}`;
  $("#map-area").textContent = route.area(snap.s);
  $("#game-clock").textContent = displayTime(
    (selectedWeather === "evening" ? 18 : 8) * 3600 + snap.time,
  );
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
  $("#dwell-label").textContent = snap.doors
    ? snap.dwell >= snap.dwellRequired
      ? "Nástup dokončen"
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
  ui.advice.textContent = snap.message;
  $("#stop-advice>small").textContent =
    snap.mode === "free"
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
      audio.announce(`Příští zastávka ${next.name}.`);
      showToast(`Příští zastávka: ${next.name}`);
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
    $("#finish-stats").textContent =
      `Služba dokončena za ${Math.floor(snap.time / 60)} minut. Obslouženo ${snap.completedStops} zastávek. Hodnocení ${rating(snap)}/100, porušení pravidel ${snap.violationCount}.`;
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
  ctx.restore();
  return ctx;
}
function drawMiniMap() {
  if (!route) return;
  const p = route.at(sim.s),
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
    "<h3>Skutečné podklady</h3><p>Celá pravidelná trasa linky 22 ve směru Bílá Hora → Nádraží Hostivař. Oficiální souřadnice zastávek a geometrie PID GTFS. Půdorysy budov, okolní komunikace, řeka, zeleň a části katedrály sv. Víta pocházejí z OpenStreetMap. Okolní kopce vycházejí z výškových dat Copernicus.</p><h3>Zdroje</h3>";
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
    '<h3>Co se simuluje</h3><p>Souprava Tatra T3R.P, sílová fyzika, výkon, sklony, adheze, pískování, rekuperace a elektrická i mechanická brzda. Chodci chodí k přechodům a dveřím, auta tvoří fronty a reagují na semafory a nástup. Modely tramvaje, kabiny, automobilů a lidí vznikly v Blenderu. Fotografické PBR materiály, HDR a optimalizovaný strom jsou z Poly Haven (CC0).</p><h3>Míra věrnosti</h3><p>Trať a půdorysy mají skutečné geografické podklady. Fasády, detaily dominant, výšky některých budov, jízdní fyzika a provoz jsou rekonstrukce pro hru. Návěstní cykly a rychlostní omezení jsou herní aproximace. Výškový profil využívá upravený terénní model, nikoli zaměření kolejí. Krátkodobé výluky nejsou simulovány.</p><p>Zvuk jízdy a zvonku je syntetický. Hlášení používá český hlas prohlížeče, pokud je dostupný.</p><p class="quiet">Data ověřena 13. 10. 2026 · PID CC BY 4.0 · © přispěvatelé OpenStreetMap, ODbL · Poly Haven CC0</p>';
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
      if (keys.has("ArrowLeft")) world.look = Math.max(-1.35, world.look - dt);
      if (keys.has("ArrowRight")) world.look = Math.min(1.35, world.look + dt);
      sim.update(dt);
      audio.update(sim.getSnapshot(), dt);
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
  try {
    const results = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/route22.json`),
      fetch(`${import.meta.env.BASE_URL}data/city.json`),
      fetch(`${import.meta.env.BASE_URL}data/crossings.json`),
      fetch(`${import.meta.env.BASE_URL}data/terrain.json`),
      fetch(`${import.meta.env.BASE_URL}data/skyline.json`),
      fetch(`${import.meta.env.BASE_URL}data/public-spaces.json`),
      fetch(`${import.meta.env.BASE_URL}data/city-context.json`),
      fetch(`${import.meta.env.BASE_URL}data/landmark-parts.json`),
    ]);
    if (results.some((r) => !r.ok))
      throw new Error(
        "Nepodařilo se načíst geografická data. Obnovte stránku a zkuste to znovu.",
      );
    const [
      data,
      map,
      crossings,
      terrain,
      skyline,
      publicSpaces,
      context,
      landmarkParts,
    ] = await Promise.all(results.map((r) => r.json()));
    map.crossings = crossings.crossings;
    map.skyline = skyline;
    map.publicSpaces = publicSpaces;
    map.context = context;
    map.landmarkParts = landmarkParts;
    for (const building of map.buildings)
      Object.assign(
        building,
        context.buildingAttributes?.[building.osmId] ?? {},
      );
    route = new Route(data, terrain);
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
    $("#route-stats").textContent =
      `${(route.length / 1000).toFixed(1)} km · ${route.stops.length} zastávek · přibližně 65 minut`;
    sourceHTML(data);
    world = new World(
      $("#world"),
      route,
      city,
      (t) => ($("#loading-status").textContent = t),
    );
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
    $("#resume").classList.toggle("hidden", !savedState);
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
