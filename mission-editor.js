import { GHOST_CAP_MISSION_INT_WRITE } from "./ghost-dp-api.js?v=2";

const COMMANDS = new Map([
  [16, "Waypoint"], [18, "Loiter turns"], [19, "Loiter time"],
  [21, "Land"], [22, "Takeoff"],
]);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const commandName = (command) => COMMANDS.get(Number(command)) ?? `Command ${command}`;

function normaliseItem(item, sequence) {
  return {
    sequence, frame: Number(item.frame ?? 5), command: Number(item.command ?? 16),
    current: Number(item.current ?? 0), autocontinue: Number(item.autocontinue ?? 1),
    params: Array.from({ length: 4 }, (_, index) => finite(item.params?.[index], 0)),
    latitude: finite(item.latitude), longitude: finite(item.longitude),
    altitude: finite(item.altitude, 30),
  };
}

export function validateMission(items, maximum = 256) {
  const errors = [];
  if (items.length > maximum) errors.push(`Plan has ${items.length} items; FC maximum is ${maximum}.`);
  items.forEach((item, index) => {
    if (item.latitude < -90 || item.latitude > 90) errors.push(`WP ${index + 1}: latitude is outside ±90°.`);
    if (item.longitude < -180 || item.longitude > 180) errors.push(`WP ${index + 1}: longitude is outside ±180°.`);
    if (!Number.isFinite(item.altitude)) errors.push(`WP ${index + 1}: altitude is invalid.`);
  });
  return errors;
}

export function createMissionEditor(elements, { getApi, setStatus }) {
  let items = [];
  let maximum = 256;
  let opaqueId = 0;
  let dirty = false;
  let dragIndex = -1;
  let transform = null;
  let webMap = null;
  let webLayers = null;

  const setDirty = (value = true) => {
    dirty = value;
    elements.missionDirty.textContent = dirty ? "Unsaved draft" : "Matches FC";
    elements.missionDirty.dataset.dirty = String(dirty);
  };

  function bounds() {
    if (!items.length) return { minLat: -0.001, maxLat: 0.001, minLon: -0.001, maxLon: 0.001 };
    let minLat = Math.min(...items.map((item) => item.latitude));
    let maxLat = Math.max(...items.map((item) => item.latitude));
    let minLon = Math.min(...items.map((item) => item.longitude));
    let maxLon = Math.max(...items.map((item) => item.longitude));
    const latPad = Math.max((maxLat - minLat) * 0.15, 0.00015);
    const lonPad = Math.max((maxLon - minLon) * 0.15, 0.00015);
    return { minLat: minLat - latPad, maxLat: maxLat + latPad,
      minLon: minLon - lonPad, maxLon: maxLon + lonPad };
  }

  function renderMap() {
    const svg = elements.missionMap;
    const area = { left: 34, top: 24, width: 732, height: 462 };
    const b = bounds();
    const x = (lon) => area.left + (lon - b.minLon) / (b.maxLon - b.minLon) * area.width;
    const y = (lat) => area.top + (b.maxLat - lat) / (b.maxLat - b.minLat) * area.height;
    transform = { area, bounds: b, x, y };
    svg.replaceChildren();
    const ns = "http://www.w3.org/2000/svg";
    const make = (name, attributes = {}) => {
      const node = document.createElementNS(ns, name);
      Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
      return node;
    };
    for (let index = 0; index <= 8; index += 1) {
      svg.append(make("line", { x1: area.left + area.width * index / 8, y1: area.top,
        x2: area.left + area.width * index / 8, y2: area.top + area.height, class: "mission-grid-line" }));
      svg.append(make("line", { x1: area.left, y1: area.top + area.height * index / 8,
        x2: area.left + area.width, y2: area.top + area.height * index / 8, class: "mission-grid-line" }));
    }
    if (items.length) {
      svg.append(make("polyline", { points: items.map((item) => `${x(item.longitude)},${y(item.latitude)}`).join(" "),
        class: "mission-route" }));
    }
    items.forEach((item, index) => {
      const group = make("g", { class: "mission-marker", "data-index": index,
        transform: `translate(${x(item.longitude)} ${y(item.latitude)})` });
      group.append(make("circle", { r: 13 }));
      const label = make("text", { x: 0, y: 4, "text-anchor": "middle" });
      label.textContent = String(index + 1);
      group.append(label);
      const title = make("title"); title.textContent = `${commandName(item.command)} · ${item.altitude.toFixed(1)} m`;
      group.append(title); svg.append(group);
    });
    elements.missionMapEmpty.hidden = items.length > 0;
    renderWebMap();
  }

  function initialiseWebMap() {
    if (webMap || !window.L) return Boolean(webMap);
    webMap = window.L.map(elements.missionWebMap, { zoomControl: true });
    window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(webMap);
    webLayers = window.L.layerGroup().addTo(webMap);
    webMap.setView([0, 0], 2);
    return true;
  }

  function renderWebMap() {
    const webMode = elements.missionMapMode.value === "web";
    elements.missionMapWrap.dataset.mapMode = webMode ? "web" : "plane";
    elements.missionMap.hidden = webMode;
    elements.missionWebMap.hidden = !webMode;
    if (!webMode) return;
    if (!initialiseWebMap()) {
      elements.missionMapMode.value = "plane";
      elements.missionMapWrap.dataset.mapMode = "plane";
      elements.missionMap.hidden = false;
      elements.missionWebMap.hidden = true;
      setStatus("Web map library is unavailable; using the offline route plane.", "bad");
      return;
    }
    webMap.invalidateSize();
    webLayers.clearLayers();
    const positions = items.map((item) => [item.latitude, item.longitude]);
    if (positions.length > 1) window.L.polyline(positions, {
      color: "#d8ad00", weight: 4, opacity: 0.9,
    }).addTo(webLayers);
    items.forEach((item, index) => {
      const icon = window.L.divIcon({ className: "mission-web-marker",
        html: String(index + 1), iconSize: [28, 28], iconAnchor: [14, 14] });
      const marker = window.L.marker([item.latitude, item.longitude], {
        draggable: true, autoPan: true, icon,
      }).bindTooltip(`${commandName(item.command)} · ${item.altitude.toFixed(1)} m`)
        .addTo(webLayers);
      marker.on("dragend", () => {
        const location = marker.getLatLng();
        item.latitude = location.lat; item.longitude = location.lng;
        setDirty(); render();
      });
    });
    if (positions.length === 1) webMap.setView(positions[0], 17);
    else if (positions.length > 1) webMap.fitBounds(positions, { padding: [35, 35], maxZoom: 18 });
  }

  function renderTable() {
    elements.missionRows.replaceChildren();
    items.forEach((item, index) => {
      const row = document.createElement("tr");
      const commandOptions = [...COMMANDS].map(([value, name]) =>
        `<option value="${value}"${item.command === value ? " selected" : ""}>${name}</option>`).join("");
      row.innerHTML = `<td><strong>${index + 1}</strong></td><td><select data-key="command">${commandOptions}</select></td>` +
        `<td><input data-key="latitude" type="number" step="0.0000001" value="${item.latitude.toFixed(7)}"></td>` +
        `<td><input data-key="longitude" type="number" step="0.0000001" value="${item.longitude.toFixed(7)}"></td>` +
        `<td><input data-key="altitude" type="number" step="0.1" value="${item.altitude.toFixed(1)}"></td>` +
        `<td class="mission-row-actions"><button data-action="up" title="Move up">↑</button><button data-action="down" title="Move down">↓</button><button data-action="duplicate" title="Duplicate">＋</button><button data-action="delete" title="Delete">×</button></td>`;
      row.addEventListener("input", (event) => {
        const key = event.target.dataset.key;
        if (!key) return;
        item[key] = key === "command" ? Number(event.target.value) : finite(event.target.value);
        setDirty(); renderMap(); renderSummary();
      });
      row.addEventListener("change", (event) => {
        if (event.target.dataset.key === "command") {
          item.command = Number(event.target.value); setDirty(); renderMap(); renderSummary();
        }
      });
      row.addEventListener("click", (event) => {
        const action = event.target.dataset.action;
        if (!action) return;
        if (action === "delete") items.splice(index, 1);
        if (action === "duplicate") items.splice(index + 1, 0, { ...item, params: [...item.params] });
        if (action === "up" && index) [items[index - 1], items[index]] = [items[index], items[index - 1]];
        if (action === "down" && index + 1 < items.length) [items[index], items[index + 1]] = [items[index + 1], items[index]];
        items = items.map(normaliseItem); setDirty(); render();
      });
      elements.missionRows.append(row);
    });
  }

  function routeDistance() {
    const earth = 6371000;
    return items.slice(1).reduce((total, item, index) => {
      const previous = items[index];
      const dLat = (item.latitude - previous.latitude) * Math.PI / 180;
      const dLon = (item.longitude - previous.longitude) * Math.PI / 180;
      const meanLat = (item.latitude + previous.latitude) * Math.PI / 360;
      return total + earth * Math.hypot(dLat, dLon * Math.cos(meanLat));
    }, 0);
  }

  function renderSummary() {
    const errors = validateMission(items, maximum);
    const distance = routeDistance();
    elements.missionCount.textContent = `${items.length} / ${maximum}`;
    elements.missionDistance.textContent = distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${distance.toFixed(0)} m`;
    elements.missionRevision.textContent = opaqueId ? opaqueId.toString(16).padStart(8, "0") : "Local draft";
    elements.missionValidation.textContent = errors.length ? errors.join(" ") : items.length ? "Plan is locally valid." : "Add or import a waypoint.";
    elements.missionValidation.dataset.level = errors.length ? "bad" : "good";
    const api = getApi();
    const writeSupported = Boolean(api?.hello?.flags & GHOST_CAP_MISSION_INT_WRITE);
    elements.missionWriteSupport.textContent = writeSupported ? "Transactional" : "Read only";
    elements.missionWrite.disabled = !writeSupported || !dirty || !opaqueId ||
      !items.length || Boolean(errors.length);
  }

  function render() { renderTable(); renderMap(); renderSummary(); }

  async function readFromFc() {
    const api = getApi();
    if (!api) throw new Error("Connect a mission-capable flight controller first");
    setStatus("Reading flight plan from the FC…");
    const mission = await api.getMission();
    maximum = mission.maximum; opaqueId = mission.opaqueId;
    items = mission.items.map(normaliseItem); setDirty(false); render();
    setStatus(`Loaded ${items.length} flight-plan items from the FC.`, "good");
  }

  function exportPlan() {
    const payload = { schema: "ghost-flight-plan-v1", opaqueId, items };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
    link.download = "ghost-flight-plan.json"; link.click(); URL.revokeObjectURL(link.href);
  }

  elements.missionRead.addEventListener("click", () => readFromFc().catch((error) => setStatus(error.message, "bad")));
  elements.missionAdd.addEventListener("click", () => {
    const last = items.at(-1) ?? { latitude: 0, longitude: 0, altitude: 30 };
    items.push(normaliseItem({ ...last, longitude: last.longitude + 0.0001 }, items.length));
    setDirty(); render();
  });
  elements.missionExport.addEventListener("click", exportPlan);
  elements.missionImport.addEventListener("click", () => elements.missionFile.click());
  elements.missionFile.addEventListener("change", async () => {
    try {
      const parsed = JSON.parse(await elements.missionFile.files[0].text());
      if (parsed.schema !== "ghost-flight-plan-v1" || !Array.isArray(parsed.items)) throw new Error("Not a GHOST flight-plan file");
      items = parsed.items.map(normaliseItem); setDirty(); render();
      setStatus(`Imported ${items.length} flight-plan items into the local draft.`, "good");
    } catch (error) { setStatus(`Flight-plan import: ${error.message}`, "bad"); }
    elements.missionFile.value = "";
  });
  elements.missionMap.addEventListener("pointerdown", (event) => {
    const marker = event.target.closest(".mission-marker");
    if (!marker) return;
    dragIndex = Number(marker.dataset.index); elements.missionMap.setPointerCapture(event.pointerId);
  });
  elements.missionMap.addEventListener("pointermove", (event) => {
    if (dragIndex < 0 || !transform) return;
    const rect = elements.missionMap.getBoundingClientRect();
    const sx = (event.clientX - rect.left) / rect.width * 800;
    const sy = (event.clientY - rect.top) / rect.height * 520;
    const { area, bounds: b } = transform;
    items[dragIndex].longitude = b.minLon + (sx - area.left) / area.width * (b.maxLon - b.minLon);
    items[dragIndex].latitude = b.maxLat - (sy - area.top) / area.height * (b.maxLat - b.minLat);
    items[dragIndex].latitude = Math.max(-90, Math.min(90, items[dragIndex].latitude));
    items[dragIndex].longitude = Math.max(-180, Math.min(180, items[dragIndex].longitude));
    setDirty(); render();
  });
  const endDrag = () => { dragIndex = -1; };
  elements.missionMap.addEventListener("pointerup", endDrag);
  elements.missionMap.addEventListener("pointercancel", endDrag);
  elements.missionWrite.addEventListener("click", async () => {
    const errors = validateMission(items, maximum);
    if (errors.length) return setStatus(errors.join(" "), "bad");
    const api = getApi();
    if (!api || !opaqueId) return setStatus("Read the current FC mission before writing.", "bad");
    if (!window.confirm(`Replace the FC flight plan with ${items.length} items?`)) return;
    elements.missionWrite.disabled = true;
    try {
      const verified = await api.writeMission(items, opaqueId, (done, total) =>
        setStatus(`Uploading flight plan… ${done}/${total}`));
      maximum = verified.maximum; opaqueId = verified.opaqueId;
      items = verified.items.map(normaliseItem); setDirty(false); render();
      setStatus(`Flight plan committed and verified (${items.length} items).`, "good");
    } catch (error) {
      setStatus(`Flight-plan write: ${error.message}`, "bad");
      renderSummary();
    }
  });
  elements.missionMapMode.addEventListener("change", () => {
    try { localStorage.setItem("ghost-mission-map-mode", elements.missionMapMode.value); } catch (_) {}
    renderMap();
  });
  try {
    elements.missionMapMode.value = localStorage.getItem("ghost-mission-map-mode") || "web";
  } catch (_) { elements.missionMapMode.value = "web"; }
  render();
  return { readFromFc, setConnected: (connected) => {
    elements.missionRead.disabled = !connected;
    renderSummary();
  } };
}
