import { MSP, decodeAscii, parseCapabilities, parseConfiguredFields } from "./protocol.js";
import { SerialSession } from "./serial.js";
import { GhostMspApi } from "./ghost-api.js";
import {
  LOGICAL_WIDTH, LOGICAL_HEIGHT, ahiCenterFromPosition, ahiRect,
  ahiSizeFromPixels,
  clampPosition, logicalToPhysical, outputSize, statusRect, sticksRect,
} from "./layout.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);

let session = null;
let capabilities = [];
let configured = new Map();
let ghostApi = null;
let widgetProfileSupported = false;
let streamStatsTimer = null;
let streamStatsPrevious = null;
let streamStatsGeneration = 0;
let profileSaveQueue = Promise.resolve();
let selectedLayoutWidget = null;
let layoutDrag = null;
let layoutResize = null;
const anchoredLayoutWidgets = new Set();
const manifestWidgets = new Map();
let lastProfileSections = null;

const numeric = (id, fallback = 0) => {
  const value = Number(elements[id]?.value);
  return Number.isFinite(value) ? value : fallback;
};

function widgetLogicalRect(widget) {
  if (widget.startsWith("manifest:")) {
    const definition = manifestWidgets.get(widget.slice(9));
    if (!definition) return { x: 0, y: 0, width: 1, height: 1 };
    const value = (key, fallback) =>
      Number(definition.controls.get(key)?.value ?? fallback);
    return {
      x: value(definition.widget.geometry_x, 0),
      y: value(definition.widget.geometry_y, 0),
      width: value(definition.widget.geometry_width, 100),
      height: value(definition.widget.geometry_height, 100),
    };
  }
  if (widget === "ahi") {
    return ahiRect({
      centerX: numeric("ahiX", 5000),
      centerY: numeric("ahiY", 5000),
      width: numeric("ahiWidth", 4000),
      height: numeric("ahiHeight", 5000),
    });
  }
  if (widget === "sticks") {
    return sticksRect({
      x: numeric("sticksX", 1340),
      y: numeric("sticksY", 750),
      sizePercent: numeric("sticksSize", 100),
    });
  }
  return statusRect({
    x: numeric("statusX", 16),
    y: numeric("statusY", 12),
    sizePercent: numeric("statusSize", 100),
    showVtxTemperature: elements.statusVtxTemperature.checked,
    showVrxTemperature: elements.statusGogglesTemperature.checked,
    showVtxVoltage: elements.statusVtxVoltage.checked,
    showVrxVoltage: elements.statusGogglesVoltage.checked,
  });
}

function setWidgetLogicalPosition(widget, requestedX, requestedY, markDirty = true) {
  const rect = widgetLogicalRect(widget);
  let x = requestedX;
  let y = requestedY;
  if (elements.layoutSnap.checked) {
    x = Math.round(x / 10) * 10;
    y = Math.round(y / 10) * 10;
  }
  ({ x, y } = clampPosition(x, y, rect.width, rect.height));
  if (widget.startsWith("manifest:")) {
    const definition = manifestWidgets.get(widget.slice(9));
    definition.controls.get(definition.widget.geometry_x).value = Math.round(x);
    definition.controls.get(definition.widget.geometry_y).value = Math.round(y);
  } else if (widget === "ahi") {
    const center = ahiCenterFromPosition(x, y, rect.width, rect.height);
    elements.ahiX.value = center.centerX;
    elements.ahiY.value = center.centerY;
  } else if (widget === "sticks") {
    elements.sticksX.value = Math.round(x);
    elements.sticksY.value = Math.round(y);
  } else {
    elements.statusX.value = Math.round(x);
    elements.statusY.value = Math.round(y);
  }
  if (markDirty && elements.profileInfo.textContent !== "Not loaded") {
    elements.profileInfo.textContent = "Unsaved layout changes";
  }
  if (markDirty && layoutDrag?.widget === widget) layoutDrag.changed = true;
  refreshLayout();
}

function saveCompletedLayoutChange() {
  if (!session || !ghostApi || !widgetProfileSupported) {
    setStatus("Layout updated locally. Connect a compatible flight controller to apply it.", "neutral");
    return;
  }
  setStatus("Applying widget layout to the flight controller…");
  queueProfileSave();
}

function layoutElement(widget) {
  if (widget.startsWith("manifest:")) {
    return manifestWidgets.get(widget.slice(9))?.preview;
  }
  return elements[`layout${widget[0].toUpperCase()}${widget.slice(1)}`];
}

function updateLayoutReadout() {
  if (!selectedLayoutWidget) {
    elements.layoutSelection.textContent = "Select or drag a widget.";
    return;
  }
  const rect = widgetLogicalRect(selectedLayoutWidget);
  const output = outputSize(elements.layoutResolution.value);
  const logicalX = Math.round(rect.x);
  const logicalY = Math.round(rect.y);
  const physicalX = logicalToPhysical(logicalX, output.width, LOGICAL_WIDTH);
  const physicalY = logicalToPhysical(logicalY, output.height, LOGICAL_HEIGHT);
  const logicalWidth = Math.round(rect.width);
  const logicalHeight = Math.round(rect.height);
  const physicalWidth =
    logicalToPhysical(logicalWidth, output.width, LOGICAL_WIDTH);
  const physicalHeight =
    logicalToPhysical(logicalHeight, output.height, LOGICAL_HEIGHT);
  elements.layoutSelection.textContent =
    `${selectedLayoutWidget.toUpperCase()} · logical ${logicalX}, ${logicalY} ` +
    `· ${logicalWidth}×${logicalHeight} · ${output.width}×${output.height}: ` +
    `${physicalX}, ${physicalY} · ${physicalWidth}×${physicalHeight}`;
}

function refreshLayout() {
  const visibility = {
    ahi: elements.ahiVisible.checked,
    sticks: elements.sticksVisible.checked,
    status: elements.statusVisible.checked,
  };
  for (const widget of ["ahi", "sticks", "status", ...manifestLayoutKeys()]) {
    const preview = layoutElement(widget);
    if (!preview) continue;
    const rect = widgetLogicalRect(widget);
    preview.style.left = `${rect.x / LOGICAL_WIDTH * 100}%`;
    preview.style.top = `${rect.y / LOGICAL_HEIGHT * 100}%`;
    preview.style.width = `${rect.width / LOGICAL_WIDTH * 100}%`;
    preview.style.height = `${rect.height / LOGICAL_HEIGHT * 100}%`;
    const manifestDefinition = widget.startsWith("manifest:")
      ? manifestWidgets.get(widget.slice(9)) : null;
    const visible = manifestDefinition
      ? manifestDefinition.visibleControl.checked : visibility[widget];
    preview.classList.toggle("disabled", !visible);
    preview.classList.toggle("selected", selectedLayoutWidget === widget);
    preview.classList.toggle("anchored", anchoredLayoutWidgets.has(widget));
  }
  const statusRows = [];
  if (elements.statusVtxTemperature.checked || elements.statusVtxVoltage.checked) {
    statusRows.push(`VTX${elements.statusVtxTemperature.checked ? " 00.0 C" : ""}` +
      `${elements.statusVtxVoltage.checked ? " 00.00 V" : ""}`);
  }
  if (elements.statusGogglesTemperature.checked || elements.statusGogglesVoltage.checked) {
    statusRows.push(`VRX${elements.statusGogglesTemperature.checked ? " 00.0 C" : ""}` +
      `${elements.statusGogglesVoltage.checked ? " 00.00 V" : ""}`);
  }
  elements.layoutStatus.querySelector("small").innerHTML =
    (statusRows.length ? statusRows : ["DISABLED"]).join("<br>");
  updateLayoutReadout();
}

function selectLayoutWidget(widget) {
  selectedLayoutWidget = widget;
  refreshLayout();
}

function toggleLayoutAnchor(event) {
  event.stopPropagation();
  event.preventDefault();
  const widget = event.currentTarget.dataset.widget;
  if (!widget) return;
  if (anchoredLayoutWidgets.has(widget)) anchoredLayoutWidgets.delete(widget);
  else anchoredLayoutWidgets.add(widget);
  event.currentTarget.setAttribute(
    "aria-pressed", String(anchoredLayoutWidgets.has(widget)),
  );
  event.currentTarget.title = anchoredLayoutWidgets.has(widget)
    ? "Unlock position and return to corner resizing"
    : "Lock position and resize from centre";
  event.currentTarget.setAttribute("aria-label", event.currentTarget.title);
  selectLayoutWidget(widget);
}

function pointerLogicalPosition(event) {
  const canvas = elements.layoutCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - canvas.left) * LOGICAL_WIDTH / canvas.width,
    y: (event.clientY - canvas.top) * LOGICAL_HEIGHT / canvas.height,
  };
}

function beginLayoutDrag(event) {
  const widget = event.currentTarget.dataset.widget;
  if (!widget || event.currentTarget.classList.contains("disabled") ||
      anchoredLayoutWidgets.has(widget)) return;
  selectLayoutWidget(widget);
  const pointer = pointerLogicalPosition(event);
  const rect = widgetLogicalRect(widget);
  layoutDrag = {
    widget, offsetX: pointer.x - rect.x, offsetY: pointer.y - rect.y,
    changed: false,
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveLayoutDrag(event) {
  if (!layoutDrag) return;
  const pointer = pointerLogicalPosition(event);
  setWidgetLogicalPosition(layoutDrag.widget,
    pointer.x - layoutDrag.offsetX, pointer.y - layoutDrag.offsetY);
}

function endLayoutDrag(event) {
  if (!layoutDrag) return;
  const changed = layoutDrag.changed;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  layoutDrag = null;
  if (changed) saveCompletedLayoutChange();
}

const resizableWidgets = {
  ahi: {
    lockAspect: false,
    minimumWidth: 120,
    minimumHeight: 120,
    writeSize(width, height, anchorX, anchorY) {
      const normalized = ahiSizeFromPixels(width, height);
      const center = ahiCenterFromPosition(anchorX, anchorY, width, height);
      elements.ahiWidth.value = normalized.width;
      elements.ahiHeight.value = normalized.height;
      elements.ahiX.value = center.centerX;
      elements.ahiY.value = center.centerY;
    },
  },
};

function manifestLayoutKeys() {
  return [...manifestWidgets.values()]
    .filter((definition) => definition.preview)
    .map((definition) => `manifest:${definition.widget.id}`);
}

function resizableDefinition(widget) {
  if (resizableWidgets[widget]) return resizableWidgets[widget];
  if (!widget.startsWith("manifest:")) return null;
  const definition = manifestWidgets.get(widget.slice(9));
  if (!definition?.widget.geometry_width ||
      !definition?.widget.geometry_height) return null;
  const widthOption = definition.options.get(definition.widget.geometry_width);
  const heightOption = definition.options.get(definition.widget.geometry_height);
  return {
    lockAspect: definition.widget.geometry_lock_aspect === "true",
    minimumWidth: Number(widthOption?.min ?? 20),
    minimumHeight: Number(heightOption?.min ?? 20),
    writeSize(width, height, anchorX, anchorY) {
      definition.controls.get(definition.widget.geometry_width).value =
        Math.round(width);
      definition.controls.get(definition.widget.geometry_height).value =
        Math.round(height);
      definition.controls.get(definition.widget.geometry_x).value =
        Math.round(anchorX);
      definition.controls.get(definition.widget.geometry_y).value =
        Math.round(anchorY);
    },
  };
}

function beginLayoutResize(event) {
  const widget = event.currentTarget.dataset.widget;
  const definition = resizableDefinition(widget);
  if (!definition) return;
  event.stopPropagation();
  event.preventDefault();
  selectLayoutWidget(widget);
  const rect = widgetLogicalRect(widget);
  layoutResize = {
    widget, definition, x: rect.x, y: rect.y,
    centerX: rect.x + rect.width / 2,
    centerY: rect.y + rect.height / 2,
    anchored: anchoredLayoutWidgets.has(widget),
    changed: false,
  };
  event.currentTarget.setPointerCapture(event.pointerId);
}

function moveLayoutResize(event) {
  if (!layoutResize) return;
  const pointer = pointerLogicalPosition(event);
  let width = layoutResize.anchored
    ? Math.abs(pointer.x - layoutResize.centerX) * 2
    : pointer.x - layoutResize.x;
  let height = layoutResize.anchored
    ? Math.abs(pointer.y - layoutResize.centerY) * 2
    : pointer.y - layoutResize.y;
  if (elements.layoutSnap.checked) {
    width = Math.round(width / 10) * 10;
    height = Math.round(height / 10) * 10;
  }
  const maximumWidth = layoutResize.anchored
    ? 2 * Math.min(layoutResize.centerX, LOGICAL_WIDTH - layoutResize.centerX)
    : LOGICAL_WIDTH - layoutResize.x;
  const maximumHeight = layoutResize.anchored
    ? 2 * Math.min(layoutResize.centerY, LOGICAL_HEIGHT - layoutResize.centerY)
    : LOGICAL_HEIGHT - layoutResize.y;
  width = Math.min(Math.max(width, layoutResize.definition.minimumWidth),
    maximumWidth);
  height = Math.min(Math.max(height, layoutResize.definition.minimumHeight),
    maximumHeight);
  if (layoutResize.definition.lockAspect) {
    const size = Math.min(Math.max(width, height), maximumWidth, maximumHeight);
    width = size;
    height = size;
  }
  const anchorX = layoutResize.anchored
    ? layoutResize.centerX - width / 2 : layoutResize.x;
  const anchorY = layoutResize.anchored
    ? layoutResize.centerY - height / 2 : layoutResize.y;
  layoutResize.definition.writeSize(
    width, height, anchorX, anchorY,
  );
  layoutResize.changed = true;
  if (elements.profileInfo.textContent !== "Not loaded") {
    elements.profileInfo.textContent = "Unsaved layout changes";
  }
  refreshLayout();
}

function endLayoutResize(event) {
  if (!layoutResize) return;
  const changed = layoutResize.changed;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  layoutResize = null;
  if (changed) saveCompletedLayoutChange();
}

function moveSelectedWithKeyboard(event) {
  const widget = event.currentTarget.dataset.widget;
  const directions = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    ArrowUp: [0, -1], ArrowDown: [0, 1],
  };
  if (!directions[event.key] ||
      event.currentTarget.classList.contains("disabled") ||
      anchoredLayoutWidgets.has(widget)) return;
  selectLayoutWidget(widget);
  const rect = widgetLogicalRect(widget);
  const step = event.shiftKey ? 10 : 1;
  setWidgetLogicalPosition(widget, rect.x + directions[event.key][0] * step,
    rect.y + directions[event.key][1] * step);
  event.preventDefault();
}

function setStatus(message, level = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.level = level;
}

function setConnected(connected) {
  if (elements.connect) {
    elements.connect.textContent = connected ? "Disconnect" : "Connect FC";
    elements.connect.disabled = false;
  }
  if (elements.load) elements.load.disabled = !connected;
  if (elements.apply) elements.apply.disabled = !connected || capabilities.length === 0;
  if (elements.loadProfile) elements.loadProfile.disabled = !connected || !widgetProfileSupported;
  if (elements.applyProfile) elements.applyProfile.disabled = !connected || !widgetProfileSupported;
}

function stopStreamStats() {
  streamStatsGeneration += 1;
  if (streamStatsTimer !== null) clearTimeout(streamStatsTimer);
  streamStatsTimer = null;
  streamStatsPrevious = null;
  elements.streamRate.textContent = "—";
  elements.streamRate.removeAttribute("title");
}

function counterDelta(current, previous) {
  return (current - previous) >>> 0;
}

function startStreamStats() {
  stopStreamStats();
  const generation = streamStatsGeneration;
  const poll = async () => {
    if (generation !== streamStatsGeneration || !ghostApi) return;
    try {
      const current = await ghostApi.getStreamStats();
      if (streamStatsPrevious) {
        const elapsedMs = counterDelta(current.sampleTimeMs, streamStatsPrevious.sampleTimeMs);
        if (elapsedMs > 0) {
          const totalBytes = counterDelta(current.wireBytes, streamStatsPrevious.wireBytes);
          const fieldBytes = counterDelta(current.ghostFieldWireBytes,
            streamStatsPrevious.ghostFieldWireBytes);
          const profileBytes = counterDelta(current.ghostProfileWireBytes,
            streamStatsPrevious.ghostProfileWireBytes);
          const frames = counterDelta(current.frames, streamStatsPrevious.frames);
          const kbps = (bytes) => bytes * 8 / elapsedMs;
          const otherBytes = Math.max(0, totalBytes - fieldBytes - profileBytes);
          elements.streamRate.textContent = `${kbps(totalBytes).toFixed(1)} kbps`;
          elements.streamRate.title = `Legacy/other ${kbps(otherBytes).toFixed(1)} kbps · ` +
            `GHOST fields ${kbps(fieldBytes).toFixed(1)} kbps · ` +
            `profile ${kbps(profileBytes).toFixed(1)} kbps · ` +
            `${(frames * 1000 / elapsedMs).toFixed(1)} frames/s`;
        }
      }
      streamStatsPrevious = current;
    } catch (error) {
      elements.streamRate.textContent = "Unavailable";
      elements.streamRate.title = error.message;
    }
    if (generation === streamStatsGeneration) streamStatsTimer = setTimeout(poll, 1000);
  };
  poll();
}

function renderFields() {
  elements.fields.replaceChildren();
  for (const capability of capabilities) {
    const current = configured.get(capability.name);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input class="enabled" type="checkbox" ${current ? "checked" : ""} aria-label="Enable ${capability.name}"></td>
      <td><span class="field-name">${capability.name}</span><small>ID ${capability.id}</small></td>
      <td><input class="rate" type="number" min="1" max="${capability.maxHz}" value="${current?.rateHz ?? Math.min(10, capability.maxHz)}"><span>Hz</span></td>
      <td>${capability.maxHz} Hz</td>`;
    row.dataset.name = capability.name;
    const onCheckbox = row.querySelector(".enabled");
    onCheckbox.addEventListener("change", () => {
      if (!onCheckbox.checked && requiredWidgetFields().has(row.dataset.name.toUpperCase())) {
        onCheckbox.checked = true;
        setStatus(`${row.dataset.name} must remain On while it is required by an enabled widget.`, "neutral");
      }
      updateSummary();
    });
    row.querySelector(".rate").addEventListener("change", updateSummary);
    elements.fields.append(row);
  }
  enableRequiredWidgetFields();
}

function selectedFields() {
  return [...elements.fields.querySelectorAll("tr")]
    .filter((row) => row.querySelector(".enabled")?.checked)
    .map((row, index) => ({
      slot: index + 1,
      name: row.dataset.name,
      rateHz: Number(row.querySelector(".rate").value),
    }));
}

function updateSummary() {
  const selected = selectedFields();
  elements.selection.textContent = `${selected.length} field${selected.length === 1 ? "" : "s"} enabled`;
  for (const row of elements.fields.querySelectorAll("tr")) {
    const onCheckbox = row.querySelector(".enabled");
    row.classList.toggle("field-filtered",
      Boolean(onCheckbox && elements.hideInactive.checked && !onCheckbox.checked));
  }
}

function requiredWidgetFields() {
  const required = new Set();
  const add = (id) => {
    const name = elements[id].value.trim().toUpperCase();
    if (name) required.add(name);
  };
  if (elements.ahiVisible.checked) {
    add("ahiPitch");
    add("ahiRoll");
  }
  if (elements.sticksVisible.checked) {
    add("sticksRoll");
    add("sticksPitch");
    add("sticksYaw");
    add("sticksThrottle");
  }
  for (const definition of manifestWidgets.values()) {
    if (!definition.visibleControl.checked) continue;
    for (const [key, option] of definition.options) {
      if (option.type !== "field") continue;
      const raw = definition.controls.get(key)?.value.trim().toUpperCase();
      if (!raw) continue;
      const numericId = Number(raw);
      const capability = Number.isInteger(numericId)
        ? capabilities.find((field) => field.id === numericId)
        : capabilities.find((field) => field.name.toUpperCase() === raw);
      required.add(capability?.name.toUpperCase() ?? raw);
    }
  }
  return required;
}

function manifestRequiredFieldRates() {
  const rates = new Map();
  for (const definition of manifestWidgets.values()) {
    if (!definition.visibleControl.checked) continue;
    for (const [key, option] of definition.options) {
      if (option.type !== "field" || option.default_hz === undefined) continue;
      const raw = definition.controls.get(key)?.value.trim().toUpperCase();
      const numericId = Number(raw);
      const capability = Number.isInteger(numericId)
        ? capabilities.find((field) => field.id === numericId)
        : capabilities.find((field) => field.name.toUpperCase() === raw);
      if (capability) rates.set(capability.name.toUpperCase(), Number(option.default_hz));
    }
  }
  return rates;
}

function enableRequiredWidgetFields(notify = false) {
  const required = requiredWidgetFields();
  const requestedRates = manifestRequiredFieldRates();
  const enabled = [];
  const available = new Set();
  for (const row of elements.fields.querySelectorAll("tr[data-name]")) {
    const name = row.dataset.name.toUpperCase();
    available.add(name);
    const onCheckbox = row.querySelector(".enabled");
    if (required.has(name) && !onCheckbox.checked) {
      onCheckbox.checked = true;
      const requestedRate = requestedRates.get(name);
      if (requestedRate) {
        row.querySelector(".rate").value =
          Math.min(requestedRate, Number(row.querySelector(".rate").max));
      }
      enabled.push(row.dataset.name);
    }
  }
  updateSummary();
  if (notify && enabled.length) {
    setStatus(`Enabled required field${enabled.length === 1 ? "" : "s"}: ${enabled.join(", ")}. Save widget & fields to persist.`, "good");
  }
  const unavailable = [...required].filter((name) => !available.has(name));
  if (notify && capabilities.length && unavailable.length) {
    setStatus(`Required field${unavailable.length === 1 ? "" : "s"} unavailable: ${unavailable.join(", ")}.`, "bad");
  }
  return enabled;
}

async function connect() {
  try {
    session = new SerialSession();
    setStatus("Choose the flight-controller serial port…");
    await session.connect();
    setConnected(true);
    setStatus("Reading flight-controller identity…");

    const variant = decodeAscii(await session.requestMsp(MSP.FC_VARIANT));
    const version = await session.requestMsp(MSP.FC_VERSION);
    const board = decodeAscii(await session.requestMsp(MSP.BOARD_INFO));
    const versionText = version.length >= 3 ? `${version[0]}.${version[1]}.${version[2]}` : "unknown";
    elements.fcIdentity.textContent = `${variant} ${versionText}`;
    elements.boardIdentity.textContent = board.slice(0, 4) || "Unknown board";

    if (variant !== "BTFL") {
      throw new Error(`POC CLI adapter supports BTFL; detected ${variant || "an unknown FC"}`);
    }
    ghostApi = new GhostMspApi(session);
    let streamStatsSupported = false;
    try {
      const api = await ghostApi.getCapabilities();
      widgetProfileSupported = Boolean(api.flags & 0x08);
      streamStatsSupported = Boolean(api.flags & 0x10);
      elements.interfaceIdentity.textContent = `GHOST MSPv2 ${api.major}.${api.minor}`;
      setConnected(true);
      setStatus("Connected using the transactional GHOST MSPv2 API.", "good");
    } catch (_) {
      ghostApi = null;
      widgetProfileSupported = false;
      stopStreamStats();
      elements.interfaceIdentity.textContent = "Legacy CLI fallback";
      setStatus("Connected. This firmware will use the legacy CLI adapter.", "good");
    }
    if (window.confirm("Load the saved GHOST configuration from this flight controller?")) {
      if (ghostApi && widgetProfileSupported) await loadProfile();
      await loadFields();
    }
    if (ghostApi && streamStatsSupported) startStreamStats();
  } catch (error) {
    setStatus(error.message, "bad");
    if (session?.port) await session.close().catch(() => {});
    session = null;
    setConnected(false);
  }
}

function parseIni(text) {
  const sections = new Map();
  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) {
      section = {};
      sections.set(heading[1], section);
      continue;
    }
    const equals = line.indexOf("=");
    if (section && equals > 0) section[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return sections;
}

function parseWidgetManifest(text, source) {
  const sections = parseIni(text);
  const widget = sections.get("widget");
  if (!widget || widget.schema_version !== "1" ||
      !/^[A-Za-z0-9_-]+$/.test(widget.id ?? "") ||
      !/^[A-Za-z0-9_.-]+$/.test(widget.section ?? "")) {
    throw new Error(`Invalid widget manifest: ${source}`);
  }
  const options = new Map();
  for (const [section, values] of sections) {
    if (section.startsWith("option.")) options.set(section.slice(7), values);
  }
  const visible = [...options].find(([, option]) => option.role === "visible");
  if (!visible || visible[1].type !== "boolean") {
    throw new Error(`Widget ${widget.id} has no visibility option.`);
  }
  return { widget, options, visibleKey: visible[0] };
}

function createManifestControl(definition, key, option) {
  const input = document.createElement("input");
  input.dataset.manifestWidget = definition.widget.id;
  input.dataset.manifestOption = key;
  if (option.type === "boolean") {
    input.type = "checkbox";
    input.checked = truthy(option.default);
  } else {
    input.type = ["integer", "number", "logical_x", "logical_y",
      "logical_width", "logical_height", "logical_size"].includes(option.type)
      ? "number" : "text";
    input.value = option.default ?? "";
    if (option.min !== undefined) input.min = option.min;
    if (option.max !== undefined) input.max = option.max;
    if (option.step !== undefined) input.step = option.step;
  }
  definition.controls.set(key, input);
  return input;
}

function attachManifestPreview(definition) {
  const widgetKey = `manifest:${definition.widget.id}`;
  const preview = document.createElement("div");
  preview.className = `layout-widget manifest-widget ${definition.widget.preview ?? ""}`;
  preview.dataset.widget = widgetKey;
  preview.tabIndex = 0;
  const label = document.createElement("span");
  label.textContent = definition.widget.preview === "logo"
    ? "G" : definition.widget.title;
  preview.append(label);
  if (definition.widget.geometry_width && definition.widget.geometry_height) {
    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.className = "layout-anchor-toggle";
    anchor.dataset.widget = widgetKey;
    anchor.setAttribute(
      "aria-label",
      `Lock ${definition.widget.title} position and resize from centre`,
    );
    anchor.setAttribute("aria-pressed", "false");
    anchor.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="3" y="11" width="18" height="10" rx="2"></rect>' +
      '<path class="lock-closed" d="M7 11V7a5 5 0 0 1 10 0v4"></path>' +
      '<path class="lock-open" d="M7 11V7a5 5 0 0 1 9.8-1.4"></path>' +
      "</svg>";
    anchor.title = "Lock position and resize from centre";
    anchor.addEventListener("pointerdown", (event) => event.stopPropagation());
    anchor.addEventListener("click", toggleLayoutAnchor);
    preview.append(anchor);
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "layout-resize-handle";
    handle.dataset.widget = widgetKey;
    handle.setAttribute("aria-label", `Resize ${definition.widget.title}`);
    handle.addEventListener("pointerdown", beginLayoutResize);
    preview.append(handle);
  }
  preview.addEventListener("pointerdown", beginLayoutDrag);
  preview.addEventListener("pointermove", moveLayoutDrag);
  preview.addEventListener("pointerup", endLayoutDrag);
  preview.addEventListener("pointercancel", endLayoutDrag);
  preview.addEventListener("keydown", moveSelectedWithKeyboard);
  preview.addEventListener("focus", () => selectLayoutWidget(widgetKey));
  elements.layoutManifestWidgets.append(preview);
  definition.preview = preview;
}

function renderManifestWidget(parsed) {
  const definition = { ...parsed, controls: new Map(), preview: null };
  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  const visibleControl = createManifestControl(
    definition, definition.visibleKey,
    definition.options.get(definition.visibleKey),
  );
  definition.visibleControl = visibleControl;
  legend.append(visibleControl, ` ${definition.widget.title}`);
  fieldset.append(legend);
  if (definition.widget.description) {
    const description = document.createElement("p");
    description.className = "widget-description";
    description.textContent = definition.widget.description;
    fieldset.append(description);
  }
  for (const [key, option] of definition.options) {
    if (key === definition.visibleKey) continue;
    const control = createManifestControl(definition, key, option);
    if (option.hidden === "true") continue;
    const label = document.createElement("label");
    if (option.type === "boolean") label.className = "check";
    label.append(control, ` ${option.label ?? key}`);
    fieldset.append(label);
    control.addEventListener("input", refreshLayout);
    control.addEventListener("change", () => {
      refreshLayout();
      if (option.type === "field") enableRequiredWidgetFields(true);
    });
  }
  visibleControl.addEventListener("change", () => {
    refreshLayout();
    enableRequiredWidgetFields(true);
    if (!session || !ghostApi || !widgetProfileSupported) {
      setStatus("Connect a compatible flight controller before changing widget enable state.", "bad");
      return;
    }
    queueProfileSave();
  });
  elements.manifestWidgets.append(fieldset);
  manifestWidgets.set(definition.widget.id, definition);
  if (definition.widget.geometry_x && definition.widget.geometry_y &&
      definition.widget.geometry_width && definition.widget.geometry_height) {
    attachManifestPreview(definition);
  }
  if (lastProfileSections) populateManifestProfiles(lastProfileSections);
}

async function loadWidgetManifests() {
  try {
    const catalogUrl = new URL("./widgets/catalog.json", location.href);
    const response = await fetch(catalogUrl);
    if (!response.ok) throw new Error(`Widget catalog HTTP ${response.status}`);
    const catalog = await response.json();
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.manifests)) {
      throw new Error("Unsupported widget catalog.");
    }
    const parsed = await Promise.all(catalog.manifests.map(async (path) => {
      const url = new URL(path, catalogUrl);
      const manifestResponse = await fetch(url);
      if (!manifestResponse.ok) throw new Error(`${path}: HTTP ${manifestResponse.status}`);
      return parseWidgetManifest(await manifestResponse.text(), path);
    }));
    parsed.sort((a, b) => Number(a.widget.order ?? 100) - Number(b.widget.order ?? 100));
    for (const manifest of parsed) renderManifestWidget(manifest);
    refreshLayout();
  } catch (error) {
    setStatus(`Built-in widgets are available; package catalog failed: ${error.message}`, "bad");
  }
}

const truthy = (value) => /^(1|true|yes|on)$/i.test(value ?? "");
function setValue(id, value) { if (value !== undefined) elements[id].value = value; }

function populateManifestProfiles(sections) {
  for (const definition of manifestWidgets.values()) {
    const profile = sections.get(definition.widget.section);
    for (const [key, option] of definition.options) {
      const control = definition.controls.get(key);
      const value = profile?.[key] ?? option.default;
      if (control.type === "checkbox") control.checked = truthy(value);
      else if (value !== undefined) control.value = value;
    }
  }
}

function populateProfile(text) {
  const sections = parseIni(text);
  lastProfileSections = sections;
  const ahi = sections.get("ahi.0");
  if (ahi) {
    elements.ahiVisible.checked = truthy(ahi.visible);
    setValue("ahiPitch", ahi.pitch_field); setValue("ahiRoll", ahi.roll_field);
    setValue("ahiX", ahi.center_x); setValue("ahiY", ahi.center_y);
    setValue("ahiWidth", ahi.width); setValue("ahiHeight", ahi.height ?? "5000");
    setValue("ahiPitchScale", ahi.pitch_scale ?? "1.0");
    setValue("ahiSmoothing", ahi.smoothing);
    setValue("ahiFps", ahi.max_fps);
    elements.ahiReversePitch.checked = truthy(ahi.reverse_pitch);
    elements.ahiReverseRoll.checked = truthy(ahi.reverse_roll);
  }
  const sticks = sections.get("sticks.0");
  if (sticks) {
    elements.sticksVisible.checked = truthy(sticks.visible);
    setValue("sticksMode", sticks.mode); setValue("sticksRoll", sticks.roll_field);
    setValue("sticksPitch", sticks.pitch_field); setValue("sticksYaw", sticks.yaw_field);
    setValue("sticksThrottle", sticks.throttle_field); setValue("sticksX", sticks.position_x);
    setValue("sticksY", sticks.position_y); setValue("sticksSize", sticks.size_percent);
    setValue("sticksFps", sticks.max_fps);
  }
  const status = sections.get("status.0");
  if (status) {
    elements.statusVisible.checked = truthy(status.visible);
    elements.statusVtxTemperature.checked = truthy(status.show_vtx_temperature);
    elements.statusGogglesTemperature.checked = truthy(status.show_goggles_temperature);
    elements.statusVtxVoltage.checked = truthy(status.show_vtx_voltage);
    elements.statusGogglesVoltage.checked = truthy(status.show_goggles_voltage);
    setValue("statusX", status.position_x); setValue("statusY", status.position_y);
    setValue("statusSize", status.size_percent); setValue("statusFps", status.max_fps);
    setValue("statusOpacity", status.background_opacity);
    setValue("statusStale", status.stale_timeout_ms);
  }
  populateManifestProfiles(sections);
  enableRequiredWidgetFields();
  refreshLayout();
}

function fieldName(id) {
  const value = elements[id].value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(value)) throw new Error(`${id} is not a valid field name`);
  return value;
}

function numberValue(id, minimum, maximum) {
  const value = Number(elements[id].value);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${id} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function manifestOptionValue(definition, key, option) {
  const control = definition.controls.get(key);
  if (option.type === "boolean") return String(control.checked);
  let value = control.value.trim();
  if (option.type === "field") {
    const numericId = Number(value);
    if (!Number.isInteger(numericId)) {
      const capability = capabilities.find(
        (field) => field.name.toUpperCase() === value.toUpperCase(),
      );
      if (!capability) {
        throw new Error(`${definition.widget.title}: unknown field ${value}`);
      }
      value = String(capability.id);
    }
    if (Number(value) < 1 || Number(value) > 255) {
      throw new Error(`${definition.widget.title}: ${key} must be a field ID from 1 to 255.`);
    }
    return value;
  }
  if (["integer", "number", "logical_x", "logical_y",
    "logical_width", "logical_height", "logical_size"].includes(option.type)) {
    const number = Number(value);
    const integerType = option.type !== "number";
    if (!Number.isFinite(number) || (integerType && !Number.isInteger(number)) ||
        (option.min !== undefined && number < Number(option.min)) ||
        (option.max !== undefined && number > Number(option.max))) {
      throw new Error(`${definition.widget.title}: ${key} is outside its allowed range.`);
    }
    return value;
  }
  if (!value || /[\r\n\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${definition.widget.title}: ${key} is invalid.`);
  }
  return value;
}

function buildProfile() {
  const statusMetricIds = ["statusVtxTemperature", "statusGogglesTemperature",
    "statusVtxVoltage", "statusGogglesVoltage"];
  if (elements.statusVisible.checked &&
      !statusMetricIds.some((id) => elements[id].checked)) {
    throw new Error("Enable at least one system-status metric.");
  }
  const lines = [
    "; GHOST widget profile v1", "[display]",
    "reference_width=1920", "reference_height=1080", "", "[ahi.0]",
    `pitch_field=${fieldName("ahiPitch")}`, `roll_field=${fieldName("ahiRoll")}`,
    `center_x=${numberValue("ahiX", 0, 10000)}`, `center_y=${numberValue("ahiY", 0, 10000)}`,
    `width=${numberValue("ahiWidth", 1, 10000)}`,
    `height=${numberValue("ahiHeight", 1, 10000)}`,
    `pitch_scale=${numberValue("ahiPitchScale", 0.1, 10)}`,
    `visible=${elements.ahiVisible.checked}`, `reverse_pitch=${elements.ahiReversePitch.checked}`,
    `reverse_roll=${elements.ahiReverseRoll.checked}`,
    `smoothing=${numberValue("ahiSmoothing", 0, 10)}`,
    `max_fps=${numberValue("ahiFps", 1, 60)}`, "stale_timeout_ms=0", "", "[sticks.0]",
    `mode=${numberValue("sticksMode", 1, 2)}`, `visible=${elements.sticksVisible.checked}`,
    `roll_field=${fieldName("sticksRoll")}`, `pitch_field=${fieldName("sticksPitch")}`,
    `yaw_field=${fieldName("sticksYaw")}`, `throttle_field=${fieldName("sticksThrottle")}`,
    "reverse_roll=false", "reverse_pitch=false", "reverse_yaw=false", "reverse_throttle=false",
    `position_x=${numberValue("sticksX", -4096, 4096)}`, `position_y=${numberValue("sticksY", -4096, 4096)}`,
    `size_percent=${numberValue("sticksSize", 20, 300)}`,
    `max_fps=${numberValue("sticksFps", 1, 60)}`, "stale_timeout_ms=500", "", "[status.0]",
    `visible=${elements.statusVisible.checked}`,
    `show_vtx_temperature=${elements.statusVtxTemperature.checked}`,
    `show_goggles_temperature=${elements.statusGogglesTemperature.checked}`,
    `show_vtx_voltage=${elements.statusVtxVoltage.checked}`,
    `show_goggles_voltage=${elements.statusGogglesVoltage.checked}`,
    `position_x=${numberValue("statusX", 0, 1919)}`,
    `position_y=${numberValue("statusY", 0, 1079)}`,
    `size_percent=${numberValue("statusSize", 50, 200)}`,
    `max_fps=${numberValue("statusFps", 1, 30)}`,
    `background_opacity=${numberValue("statusOpacity", 0, 255)}`,
    `stale_timeout_ms=${numberValue("statusStale", 0, 60000)}`, "",
  ];
  for (const definition of manifestWidgets.values()) {
    lines.push(`[${definition.widget.section}]`);
    for (const [key, option] of definition.options) {
      lines.push(`${key}=${manifestOptionValue(definition, key, option)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function loadProfile() {
  try {
    setStatus("Reading widget profile from the flight controller…");
    const profile = await ghostApi.readProfile();
    if (profile.length) populateProfile(profile.text);
    elements.profileInfo.textContent = `Revision ${profile.revision} · ${profile.length} bytes`;
    setStatus(profile.length ? "Widget profile loaded from FC." : "FC has no widget profile; showing defaults.", "good");
  } catch (error) { setStatus(error.message, "bad"); }
}

async function applyProfile() {
  try {
    if (!capabilities.length) await loadFields();
    enableRequiredWidgetFields(true);
    const text = buildProfile();
    const selected = validateSelectedFields();
    elements.applyProfile.disabled = true;
    elements.apply.disabled = true;
    setStatus("Storing field subscriptions and widget profile on the flight controller…");
    await persistMspFieldSubscriptions(selected);
    const result = await ghostApi.uploadProfile(text);
    elements.profileInfo.textContent = `Revision ${result.revision} · ${result.length} bytes`;
    setStatus("Widget profile and field subscriptions persisted. The FC will deliver them over DisplayPort.", "good");
  } catch (error) { setStatus(error.message, "bad"); }
  finally {
    elements.applyProfile.disabled = !widgetProfileSupported;
    elements.apply.disabled = capabilities.length === 0;
  }
}

function queueProfileSave() {
  profileSaveQueue = profileSaveQueue.catch(() => {}).then(() => applyProfile());
  return profileSaveQueue;
}

async function loadFields() {
  try {
    if (ghostApi) {
      setStatus("Reading GHOST MSPv2 field catalog and subscriptions…");
      capabilities = await ghostApi.getFieldCatalog();
      const subscriptions = await ghostApi.getSubscriptions();
      const names = new Map(capabilities.map((field) => [field.id, field.name]));
      configured = new Map(subscriptions.records.map((field) => {
        const name = names.get(field.fieldId) ?? `FIELD_${field.fieldId}`;
        return [name, { ...field, name }];
      }));
    } else {
      setStatus("Entering CLI and reading GHOST capabilities…");
      await session.enterCli();
      const capabilityText = await session.runCli("ghost_field list");
      const configuredText = await session.runCli("ghost_field");
      capabilities = parseCapabilities(capabilityText);
      configured = new Map(parseConfiguredFields(configuredText).map((field) => [field.name, field]));
    }
    if (capabilities.length === 0) {
      throw new Error("This firmware did not return any GHOST fields. Confirm it includes the GHOST field patch.");
    }
    renderFields();
    elements.apply.disabled = false;
    setStatus(`Loaded ${capabilities.length} supported fields.`, "good");
  } catch (error) {
    setStatus(error.message, "bad");
  }
}

function validateSelectedFields() {
  const selected = selectedFields();
  const available = new Set(capabilities.map((field) => field.name.toUpperCase()));
  const missing = [...requiredWidgetFields()].filter((name) => !available.has(name));
  if (missing.length) {
    throw new Error(`Required field${missing.length === 1 ? "" : "s"} unavailable: ${missing.join(", ")}`);
  }
  for (const field of selected) {
    const capability = capabilities.find((candidate) => candidate.name === field.name);
    if (!Number.isInteger(field.rateHz) || field.rateHz < 1 || field.rateHz > capability.maxHz) {
      throw new Error(`${field.name} must be between 1 and ${capability.maxHz} Hz.`);
    }
  }
  return selected;
}

async function persistMspFieldSubscriptions(selected) {
  const byName = new Map(capabilities.map((field) => [field.name, field]));
  const records = selected.map((field, index) => ({
    slot: index, id: byName.get(field.name).id, rateHz: field.rateHz,
  }));
  const readback = await ghostApi.replaceSubscriptions(records);
  const matches = readback.records.length === records.length && records.every((record, index) => {
    const actual = readback.records[index];
    return actual.slot === record.slot && actual.fieldId === record.id && actual.rateHz === record.rateHz;
  });
  if (!matches) throw new Error("FC field read-back does not match the requested configuration");
  configured = new Map(selected.map((field) => [field.name, field]));
}

async function applyFields() {
  try {
    enableRequiredWidgetFields(true);
    const selected = validateSelectedFields();
    elements.apply.disabled = true;
    setStatus("Writing configuration…");
    if (ghostApi) {
      await persistMspFieldSubscriptions(selected);
      setStatus("Configuration committed, persisted, and verified without rebooting.", "good");
      elements.apply.disabled = false;
      return;
    }
    await session.runCli("ghost_field clear all");
    for (const field of selected) {
      await session.runCli(`ghost_field set ${field.slot} ${field.name} ${field.rateHz}`);
    }
    setStatus("Saving and rebooting the flight controller…");
    await session.runCli("save", 1500).catch(() => {}); // save reboots before another prompt
    await session.close().catch(() => {});
    session = null;
    setConnected(false);
    configured = new Map(selected.map((field) => [field.name, field]));
    setStatus("Configuration saved; flight controller is rebooting.", "good");
  } catch (error) {
    setStatus(error.message, "bad");
    elements.apply.disabled = false;
  }
}

async function disconnect() {
  stopStreamStats();
  if (session) {
    setStatus(ghostApi ? "Disconnecting…" : "Exiting CLI and rebooting…");
    await session.close({ reboot: true }).catch(() => {});
    session = null;
  }
  capabilities = [];
  ghostApi = null;
  widgetProfileSupported = false;
  configured.clear();
  elements.fields.replaceChildren();
  elements.fcIdentity.textContent = "Not connected";
  elements.boardIdentity.textContent = "—";
  elements.interfaceIdentity.textContent = "—";
  elements.selection.textContent = "0 fields enabled";
  setConnected(false);
  setStatus("Disconnected.");
}

elements.connect.addEventListener("click", async () => {
  elements.connect.disabled = true;
  try {
    if (session) await disconnect();
    else await connect();
  } finally {
    elements.connect.disabled = false;
  }
});
elements.load.addEventListener("click", loadFields);
elements.apply.addEventListener("click", applyFields);
elements.hideInactive.addEventListener("change", updateSummary);
elements.loadProfile.addEventListener("click", loadProfile);
elements.applyProfile.addEventListener("click", queueProfileSave);
for (const id of ["ahiPitch", "ahiRoll", "sticksRoll", "sticksPitch", "sticksYaw",
  "sticksThrottle"]) {
  elements[id].addEventListener("change", () => enableRequiredWidgetFields(true));
}
for (const id of ["ahiVisible", "sticksVisible", "statusVisible"]) {
  elements[id].addEventListener("change", () => {
    refreshLayout();
    enableRequiredWidgetFields(true);
    if (!session || !ghostApi || !widgetProfileSupported) {
      setStatus("Connect a compatible flight controller before changing widget enable state.", "bad");
      return;
    }
    queueProfileSave();
  });
}
for (const widget of ["ahi", "sticks", "status"]) {
  const preview = layoutElement(widget);
  preview.addEventListener("pointerdown", beginLayoutDrag);
  preview.addEventListener("pointermove", moveLayoutDrag);
  preview.addEventListener("pointerup", endLayoutDrag);
  preview.addEventListener("pointercancel", endLayoutDrag);
  preview.addEventListener("keydown", moveSelectedWithKeyboard);
  preview.addEventListener("focus", () => selectLayoutWidget(widget));
}
for (const handle of elements.layoutCanvas.querySelectorAll(
  ".layout-resize-handle[data-widget]",
)) {
  handle.addEventListener("pointerdown", beginLayoutResize);
}
for (const anchor of elements.layoutCanvas.querySelectorAll(
  ".layout-anchor-toggle[data-widget]",
)) {
  anchor.title = "Lock position and resize from centre";
  anchor.addEventListener("pointerdown", (event) => event.stopPropagation());
  anchor.addEventListener("click", toggleLayoutAnchor);
}
window.addEventListener("pointermove", moveLayoutResize);
window.addEventListener("pointerup", endLayoutResize);
window.addEventListener("pointercancel", endLayoutResize);
for (const id of ["ahiX", "ahiY", "ahiWidth", "ahiHeight",
  "sticksX", "sticksY",
  "sticksSize", "statusX", "statusY", "statusSize",
  "statusVtxTemperature", "statusGogglesTemperature",
  "statusVtxVoltage", "statusGogglesVoltage"]) {
  elements[id].addEventListener("input", refreshLayout);
  elements[id].addEventListener("change", refreshLayout);
}
elements.layoutResolution.addEventListener("change", refreshLayout);
elements.layoutSnap.addEventListener("change", refreshLayout);

setConnected(false);
refreshLayout();
loadWidgetManifests();
if (!("serial" in navigator)) {
  setStatus("Web Serial is unavailable in this browser. Use desktop Chrome, Edge, or Chromium.", "bad");
}
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js?v=27").catch(() => {});
}
