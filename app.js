import { MSP, decodeAscii, parseCapabilities, parseConfiguredFields } from "./protocol.js";
import { SerialSession } from "./serial.js";
import { GhostMspApi } from "./ghost-api.js";
import {
  GhostDpApi, deadbandPresentation, displayDeadband, rawDeadband,
} from "./ghost-dp-api.js";
import { thresholdPresentation, validateColourPolicy } from "./field-colour.js";
import {
  compactManifestOptions, parseManifestDependencies,
  resolveManifestDependencies,
} from "./profile.js";
import { VrxApi } from "./vrx-api.js";
import {
  LOGICAL_WIDTH, LOGICAL_HEIGHT, ahiCenterFromPosition, ahiRect,
  ahiSizeFromPixels, aspectConstrainedSize,
  clampPosition, logicalToPhysical, outputSize, statusRect, sticksRect,
} from "./layout.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);

let session = null;
let capabilities = readCachedFieldCatalogue();
let configured = new Map();
let ghostApi = null;
let ghostDpApi = null;
let widgetProfileSupported = false;
let streamStatsTimer = null;
let streamStatsPrevious = null;
let streamStatsGeneration = 0;
let profileSaveQueue = Promise.resolve();
let widgetReloadToken = 0;
let selectedLayoutWidget = null;
let layoutDrag = null;
let layoutResize = null;
const anchoredLayoutWidgets = new Set();
const manifestWidgets = new Map();
const builtInMenuWidgets = new Map();
const fieldDeadbands = new Map();
const videoColourPolicies = new Map();
const VIDEO_SYSTEM_FIELDS = [
  { id: 65001, key: "vtx_temperature", name: "VTX temperature", source: "VTX", unit: "\u00b0C", step: 0.1, direction: "high" },
  { id: 65002, key: "vrx_temperature", name: "VRX temperature", source: "VRX", unit: "\u00b0C", step: 0.1, direction: "high" },
  { id: 65003, key: "vtx_voltage", name: "VTX voltage", source: "VTX", unit: "V", step: 0.01, direction: "low" },
  { id: 65004, key: "vrx_voltage", name: "VRX voltage", source: "VRX", unit: "V", step: 0.01, direction: "low" },
  { id: 65005, key: "vtx_rf_power", name: "VTX RF power", source: "VTX", unit: "dBm", step: 1, direction: "low" },
  { id: 65006, key: "vrx_rf_power", name: "VRX RF power", source: "VRX", unit: "dBm", step: 1, direction: "low" },
  { id: 65007, key: "vtx_snr", name: "VTX SNR", source: "VTX", unit: "SNR", step: 0.1, direction: "low" },
  { id: 65008, key: "vrx_snr", name: "VRX SNR", source: "VRX", unit: "SNR", step: 0.1, direction: "low" },
  { id: 65009, key: "bitrate", name: "Link bitrate", source: "Video link", unit: "Mbps", step: 0.1, direction: "low" },
  { id: 65010, key: "latency", name: "Link latency", source: "Video link", unit: "ms", step: 0.1, direction: "high" },
  { id: 65011, key: "distance", name: "Link distance", source: "Video link", unit: "m", step: 1, direction: "high" },
  { id: 65012, key: "signal", name: "Signal bars", source: "Video link", unit: "bars", step: 1, direction: "low" },
];

let lastProfileSections = null;
let vrxApi = null;
let vrxInventory = null;

const profileAvailable = () => Boolean(vrxApi || (session && ghostApi && widgetProfileSupported));

function readCachedFieldCatalogue() {
  try {
    const parsed = JSON.parse(localStorage.getItem("ghost-field-catalogue") || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((field) => Number.isInteger(field?.id) && field.id > 0 &&
      typeof field.name === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(field.name));
  } catch (_) { return []; }
}

function cacheFieldCatalogue() {
  try { localStorage.setItem("ghost-field-catalogue", JSON.stringify(capabilities)); }
  catch (_) {}
}

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
    const automaticSize = definition.widget.preview_size === "field_table"
      ? fieldTablePreviewSize(definition) : null;
    const placementScale = definition.widget.placement_scale
      ? value(definition.widget.placement_scale, 100) / 100 : 1;
    const placementWidth = Number(
      definition.widget.placement_base_width ?? 100) * placementScale;
    const placementHeight = Number(
      definition.widget.placement_base_height ?? 100) * placementScale;
    return {
      x: value(definition.widget.geometry_x, 0),
      y: value(definition.widget.geometry_y, 0),
      width: value(definition.widget.geometry_width,
        automaticSize?.width ?? placementWidth),
      height: value(definition.widget.geometry_height,
        automaticSize?.height ?? placementHeight),
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

function fieldTablePreviewSize(definition) {
  const textOption = definition.widget.preview_text_option ?? "text_size_px";
  const textPx = Math.max(10, Math.min(36,
    Number(definition.controls.get(textOption)?.value ?? 17)));
  const activeRows = [...elements.fields.querySelectorAll("tr[data-name]")]
    .filter((row) => row.querySelector(".enabled")?.checked);
  const fieldNames = activeRows.length
    ? activeRows.map((row) => row.dataset.name)
    : [...configured.values()].map((field) => field.name).filter(Boolean);
  const baseColumns = Number(definition.widget.preview_columns ?? 48);
  const longestField = Math.max(5, ...fieldNames.map((name) => name.length));
  const columns = Math.max(baseColumns, longestField + 20);
  const width = Math.max(120, Math.min(1900,
    Math.ceil(columns * textPx * 0.62) + 24));
  const rowHeight = Math.ceil(textPx *
    Number(definition.widget.preview_row_height ?? 1.2)) + 5;
  const baseRows = Number(definition.widget.preview_base_rows ?? 6);
  const height = Math.max(rowHeight + 16, Math.min(1060,
    (baseRows + fieldNames.length) * rowHeight + 16));
  return { width, height };
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
  if (!profileAvailable()) {
    setStatus("Layout updated locally. Connect the VRX bridge or a compatible flight controller to apply it.", "neutral");
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
  updateWidgetCardSummaries();
  updateLayoutReadout();
}

function widgetCard(widget) {
  if (widget.startsWith("manifest:")) {
    return manifestWidgets.get(widget.slice(9))?.card ?? null;
  }
  return document.querySelector(`[data-widget-card="${widget}"]`);
}

function setWidgetCardExpanded(card, expanded) {
  if (!card) return;
  card.classList.toggle("collapsed", !expanded);
  const toggle = card.querySelector(".widget-collapse-toggle");
  if (!toggle) return;
  toggle.setAttribute("aria-expanded", String(expanded));
  const title = card.dataset.widgetTitle ?? "widget";
  toggle.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${title} settings`);
}

function initializeWidgetCard(card) {
  const toggle = card.querySelector(".widget-collapse-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setWidgetCardExpanded(card, card.classList.contains("collapsed"));
  });
  setWidgetCardExpanded(card, false);
}

function updateWidgetCardSummaries() {
  const builtIns = [
    ["ahi", elements.ahiVisible, elements.ahiFps],
    ["sticks", elements.sticksVisible, elements.sticksFps],
    ["status", elements.statusVisible, elements.statusFps],
  ];
  for (const [widget, visible, rate] of builtIns) {
    const summary = widgetCard(widget)?.querySelector(".widget-summary");
    if (summary) summary.textContent = `${visible.checked ? "Enabled" : "Disabled"} · ${rate.value} FPS`;
  }
  for (const definition of manifestWidgets.values()) {
    if (!definition.summary) continue;
    const parts = [definition.visibleControl.checked ? "Enabled" : "Disabled"];
    const rate = definition.controls.get("refresh_hz") ?? definition.controls.get("fps");
    if (rate) parts.push(`${rate.value} ${definition.controls.has("refresh_hz") ? "Hz" : "FPS"}`);
    if (definition.controls.get("test_mode")?.checked) parts.push("Test mode");
    definition.summary.textContent = parts.join(" · ");
  }
}

function selectLayoutWidget(widget) {
  selectedLayoutWidget = widget;
  setWidgetCardExpanded(widgetCard(widget), true);
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
  sticks: {
    lockAspect: true,
    uniformScale: true,
    aspectRatio: 560 / 300,
    minimumWidth: 560 * 0.25,
    minimumHeight: 300 * 0.25,
    writeSize(width, _height, anchorX, anchorY) {
      elements.sticksSize.value = Math.round(width / 560 * 100);
      elements.sticksX.value = Math.round(anchorX);
      elements.sticksY.value = Math.round(anchorY);
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
  const scaleWidthKey = definition?.widget.size_width;
  const scaleHeightKey = definition?.widget.size_height;
  if (scaleWidthKey && scaleHeightKey) {
    const scaleOption = definition.options.get(scaleWidthKey);
    const baseWidth = Number(definition.widget.placement_base_width ?? 100);
    const baseHeight = Number(definition.widget.placement_base_height ?? 100);
    const minimumScale = Number(scaleOption?.min ?? 25) / 100;
    return {
      lockAspect: true,
      uniformScale: true,
      aspectRatio: baseWidth / baseHeight,
      minimumWidth: baseWidth * minimumScale,
      minimumHeight: baseHeight * minimumScale,
      writeSize(width, _height, anchorX, anchorY) {
        const percent = Math.round(width / baseWidth * 100);
        definition.controls.get(scaleWidthKey).value = percent;
        if (scaleHeightKey !== scaleWidthKey) {
          definition.controls.get(scaleHeightKey).value = percent;
        }
        definition.controls.get(definition.widget.geometry_x).value =
          Math.round(anchorX);
        definition.controls.get(definition.widget.geometry_y).value =
          Math.round(anchorY);
      },
    };
  }
  if (!definition?.widget.geometry_width ||
      !definition?.widget.geometry_height) return null;
  const widthOption = definition.options.get(definition.widget.geometry_width);
  const heightOption = definition.options.get(definition.widget.geometry_height);
  return {
    lockAspect: definition.widget.geometry_lock_aspect === "true",
    aspectRatio: Number(widthOption?.default ?? 1) /
      Number(heightOption?.default ?? 1),
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
    width: rect.width, height: rect.height,
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
  if (layoutResize.definition.uniformScale) {
    const widthScale = width / layoutResize.width;
    const heightScale = height / layoutResize.height;
    const requestedScale = Math.abs(widthScale - 1) >= Math.abs(heightScale - 1)
      ? widthScale : heightScale;
    const minimumScale = Math.max(
      layoutResize.definition.minimumWidth / layoutResize.width,
      layoutResize.definition.minimumHeight / layoutResize.height,
    );
    const maximumScale = Math.min(
      maximumWidth / layoutResize.width,
      maximumHeight / layoutResize.height,
    );
    const scale = Math.min(Math.max(requestedScale, minimumScale), maximumScale);
    width = layoutResize.width * scale;
    height = layoutResize.height * scale;
  } else {
    width = Math.min(Math.max(width, layoutResize.definition.minimumWidth),
      maximumWidth);
    height = Math.min(Math.max(height, layoutResize.definition.minimumHeight),
      maximumHeight);
  }
  if (layoutResize.definition.lockAspect &&
      !layoutResize.definition.uniformScale) {
    ({ width, height } = aspectConstrainedSize(
      width, height, layoutResize.definition.aspectRatio,
      layoutResize.definition.minimumWidth,
      layoutResize.definition.minimumHeight,
      maximumWidth, maximumHeight,
    ));
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
    if (!elements.sidebarFcState)
      elements.connect.textContent = connected ? "Disconnect" : "Connect FC";
    else
      elements.connect.title = connected ? "Disconnect flight controller" : "Connect flight controller";
    elements.connect.disabled = false;
  }
  if (elements.load) elements.load.disabled = !connected;
  if (elements.apply) elements.apply.disabled = !connected || capabilities.length === 0;
  const profileReady = profileAvailable();
  if (elements.loadProfile) elements.loadProfile.disabled = !profileReady;
  if (elements.reloadWidgets) elements.reloadWidgets.disabled = !profileReady;
  if (elements.applyProfile) elements.applyProfile.disabled = !profileReady;
  if (elements.connectVrx) {
    if (!elements.sidebarVrxState)
      elements.connectVrx.textContent = vrxApi ? "Disconnect VRX" : "Connect VRX";
    else
      elements.connectVrx.title = vrxApi ? "Disconnect video receiver" : "Connect video receiver";
  }
  if (elements.sidebarFcState) elements.sidebarFcState.textContent = connected ? "Connected" : "Disconnected";
  if (elements.sidebarVrxState) elements.sidebarVrxState.textContent = vrxApi ? "Connected" : "Disconnected";
  elements.connect?.classList.toggle("connected", connected);
  elements.connectVrx?.classList.toggle("connected", Boolean(vrxApi));
  for (const button of document.querySelectorAll(".widget-save"))
    button.disabled = !profileReady;
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

function fieldGroupName(name) {
  if (/^RC(?:[1-9]|1[0-8])$/.test(name)) return "rc";
  if (/^(PITCH|ROLL|HEADING|ANGULAR_|BF_PID_)/.test(name)) return "attitude";
  if (/(GPS|LATITUDE|LONGITUDE|HOME|ALTITUDE|SPEED|COURSE|DISTANCE)/.test(name)) return "gps";
  if (/(BATTERY|VOLTAGE|CURRENT|MAH|POWER|CELL)/.test(name)) return "power";
  return "state";
}

function fieldOwners(capability) {
  if (!vrxInventory) return [];
  const name = capability.name.toUpperCase();
  const owners = [];
  const add = (owner) => { if (!owners.includes(owner)) owners.push(owner); };
  const selected = (control) => catalogueFieldName(control?.value) === name;
  if (elements.ahiVisible.checked &&
      (selected(elements.ahiPitch) || selected(elements.ahiRoll))) add("AHI");
  if (elements.sticksVisible.checked && [elements.sticksRoll, elements.sticksPitch,
      elements.sticksYaw, elements.sticksThrottle].some(selected)) add("RC Sticks");
  for (const definition of manifestWidgets.values()) {
    if (!definition.visibleControl.checked) continue;
    for (const [key, option] of definition.options) {
      if (option.type !== "field") continue;
      if (catalogueFieldName(definition.controls.get(key)?.value) !== name) continue;
      add(option.subscription === "runtime"
        ? `${definition.widget.title} · on demand` : definition.widget.title);
    }
  }
  return owners;
}

function renderFields() {
  elements.fields.replaceChildren();
  const required = requiredWidgetFields();
  for (const capability of capabilities) {
    const current = configured.get(capability.name);
    const isRequired = required.has(capability.name.toUpperCase());
    const owners = fieldOwners(capability);
    const defaultDeadband = /^RC(?:[1-9]|1[0-8])$/.test(capability.name)
      ? 3 : (["PITCH", "ROLL"].includes(capability.name) ? 2 : 0);
    const deadband = fieldDeadbands.has(capability.id)
      ? fieldDeadbands.get(capability.id) : defaultDeadband;
    const presentation = deadbandPresentation(capability);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input class="enabled" type="checkbox" ${isRequired ? "checked" : ""} disabled hidden aria-label="${capability.name} ${isRequired ? "required by an enabled widget" : "not required by enabled widgets"}"><span class="field-state ${isRequired ? "active" : "available"}">${isRequired ? "Active" : "Available"}</span></td>
      <td><span class="field-name">${capability.name}</span></td>
      <td class="field-id">${capability.id}</td>
      <td class="field-owners">${owners.length ? owners.map((owner) => `<span>${owner}</span>`).join("") : '<span class="muted">None</span>'}</td>
      <td><input class="rate" type="hidden" min="1" max="${capability.maxHz}" value="${current?.rateHz ?? Math.min(10, capability.maxHz)}"><strong class="rate-value">${isRequired ? `${current?.rateHz ?? Math.min(10, capability.maxHz)} Hz` : "—"}</strong></td>
      <td>${capability.maxHz} Hz</td>
      <td><div class="deadband-control"><div><input class="deadband" type="number" min="0" max="${displayDeadband(255, presentation)}" step="${displayDeadband(1, presentation)}" value="${displayDeadband(deadband, presentation)}"><span>${presentation.unit}</span></div></div></td>
      <td class="deadband-range"><span>0–${displayDeadband(255, presentation)} ${presentation.unit}</span><small>step ${displayDeadband(1, presentation)} ${presentation.unit}</small></td>`;
    row.dataset.name = capability.name;
    row.dataset.id = capability.id;
    row.dataset.group = fieldGroupName(capability.name);
    row.dataset.deadbandFactor = presentation.factor;
    row.dataset.deadbandDecimals = presentation.decimals;
    const deadbandInput = row.querySelector(".deadband");
    const validateDeadband = () => {
      const raw = rawDeadband(deadbandInput.value, presentation);
      deadbandInput.setCustomValidity(raw === null
        ? `Use increments of ${displayDeadband(1, presentation)} ${presentation.unit}` : "");
      return raw;
    };
    deadbandInput.addEventListener("input", validateDeadband);
    deadbandInput.addEventListener("change", () => {
      const raw = validateDeadband();
      if (raw === null) return;
      deadbandInput.value = displayDeadband(raw, presentation);
      fieldDeadbands.set(capability.id, raw);
      if (profileAvailable()) queueProfileSave();
    });
    elements.fields.append(row);

  }
  refreshManifestFieldControls();
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
  elements.selection.textContent = `${selected.length} field${selected.length === 1 ? "" : "s"} required`;
  elements.fieldActiveCount.textContent = selected.length;
  elements.fieldCatalogueCount.textContent = capabilities.length;
  elements.fieldRequestTotal.textContent =
    `${selected.reduce((sum, field) => sum + field.rateHz, 0)} Hz`;
  elements.fieldConnectionState.textContent = session
    ? elements.fcIdentity.textContent : "Offline";
  const search = elements.fieldSearch.value.trim().toUpperCase();
  const scope = elements.fieldScope.value;
  const group = elements.fieldGroup.value;
  for (const row of elements.fields.querySelectorAll("tr[data-id]")) {
    const onCheckbox = row.querySelector(".enabled");
    const active = Boolean(onCheckbox?.checked);
    const matchesScope = scope === "all" || (scope === "active" && active) ||
      (scope === "available" && !active);
    const matchesGroup = group === "all" || row.dataset.group === group;
    const matchesSearch = !search || row.dataset.name.toUpperCase().includes(search) ||
      row.dataset.id.includes(search);
    const filtered = !(matchesScope && matchesGroup && matchesSearch);
    row.classList.toggle("field-filtered", filtered);
    row._colourRow?.classList.toggle("field-filtered", filtered);
  }
}

function renderVideoSystemFields() {
  elements.videoSystemFields.replaceChildren();
  const thresholdValue = (value) => Number.isFinite(value) ? String(value) : "";
  for (const field of VIDEO_SYSTEM_FIELDS) {
    const policy = videoColourPolicies.get(field.key) ?? {
      enabled: false, direction: field.direction,
      green: NaN, amber: NaN, red: NaN,
      flashOnRed: false,
    };
    const row = document.createElement("tr");
    row.innerHTML = '<td><span class="field-name">' + field.name +
      '</span><small>' + field.key + '</small></td><td>' + field.source +
      '</td><td>' + field.unit +
      '</td><td><button class="field-colour-toggle" type="button" aria-expanded="false">Colour thresholds</button></td>';
    const colourRow = document.createElement("tr");
    colourRow.className = "field-colour-row";
    colourRow.hidden = true;
    colourRow.innerHTML = '<td colspan="4"><div class="field-colour-controls">' +
      '<label class="check"><input class="colour-enabled" type="checkbox"' +
      (policy.enabled ? ' checked' : '') + '> Enable colour thresholds</label>' +
      '<label>Direction<select class="colour-direction"><option value="low"' +
      (policy.direction === "low" ? ' selected' : '') +
      '>Low is bad</option><option value="high"' +
      (policy.direction === "high" ? ' selected' : '') +
      '>High is bad</option></select></label>' +
      '<label class="threshold green">Green<input class="colour-green" type="number" step="' +
      field.step + '" value="' + thresholdValue(policy.green) + '"><span>' +
      field.unit + '</span></label>' +
      '<label class="threshold amber">Amber<input class="colour-amber" type="number" step="' +
      field.step + '" value="' + thresholdValue(policy.amber) + '"><span>' +
      field.unit + '</span></label>' +
      '<label class="threshold red">Red<input class="colour-red" type="number" step="' +
      field.step + '" value="' + thresholdValue(policy.red) + '"><span>' +
      field.unit + '</span></label>' +
      '<label class="check"><input class="colour-flash-red" type="checkbox"' +
      (policy.flashOnRed ? ' checked' : '') + '> Flash on red (500 ms)</label><small class="colour-policy-message"></small></div></td>';
    const toggle = row.querySelector(".field-colour-toggle");
    toggle.addEventListener("click", () => {
      colourRow.hidden = !colourRow.hidden;
      toggle.setAttribute("aria-expanded", String(!colourRow.hidden));
    });
    const enabled = colourRow.querySelector(".colour-enabled");
    const direction = colourRow.querySelector(".colour-direction");
    const green = colourRow.querySelector(".colour-green");
    const amber = colourRow.querySelector(".colour-amber");
    const red = colourRow.querySelector(".colour-red");
    const flashOnRed = colourRow.querySelector(".colour-flash-red");
    const message = colourRow.querySelector(".colour-policy-message");
    const thresholdNumber = (input) =>
      input.value.trim() === "" ? NaN : Number(input.value);
    const readPolicy = () => ({
      enabled: enabled.checked, direction: direction.value,
      green: thresholdNumber(green), amber: thresholdNumber(amber),
      red: thresholdNumber(red), flashOnRed: flashOnRed.checked,
    });
    const validate = () => {
      const next = readPolicy();
      const result = validateColourPolicy(next);
      for (const input of [green, amber, red])
        input.setCustomValidity(result.message);
      message.textContent = result.message;
      return result.valid ? next : null;
    };
    const save = () => {
      const next = validate();
      if (!next) return;
      if (next.enabled) videoColourPolicies.set(field.key, next);
      else videoColourPolicies.delete(field.key);
      if (profileAvailable()) queueProfileSave();
    };
    for (const control of [enabled, direction, green, amber, red, flashOnRed]) {
      control.addEventListener("input", validate);
      control.addEventListener("change", save);
    }
    validate();
    elements.videoSystemFields.append(row, colourRow);
  }
}
function catalogueFieldName(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  const numericId = Number(raw);
  const capability = Number.isInteger(numericId)
    ? capabilities.find((field) => field.id === numericId)
    : capabilities.find((field) => field.name.toUpperCase() === raw);
  return capability?.name.toUpperCase() ?? raw;
}

function requiredWidgetFields() {
  const required = new Set();
  if (!vrxInventory) return required;
  const add = (id) => {
    const name = catalogueFieldName(elements[id].value);
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
      if (option.type !== "field" || option.subscription === "runtime") continue;
      const raw = definition.controls.get(key)?.value.trim().toUpperCase();
      if (!raw) continue;
      const numericId = Number(raw);
      const capability = Number.isInteger(numericId)
        ? capabilities.find((field) => field.id === numericId)
        : capabilities.find((field) => field.name.toUpperCase() === raw);
      required.add(capability?.name.toUpperCase() ?? raw);
    }
    for (const dependency of resolveManifestDependencies(
      definition.dependencies,
      (key) => definition.controls.get(key)?.value ?? "",
      capabilities,
    )) required.add(dependency.name);
  }
  return required;
}

function manifestRequiredFieldRates() {
  const rates = new Map();
  if (!vrxInventory) return rates;
  const setRate = (name, rate) => {
    const numericRate = Number(rate);
    if (!Number.isFinite(numericRate) || numericRate <= 0) return;
    rates.set(name, Math.max(rates.get(name) ?? 0, numericRate));
  };
  const setControlRate = (fieldControl, rateControl) => {
    const name = catalogueFieldName(elements[fieldControl].value);
    if (name) setRate(name, elements[rateControl].value);
  };
  if (elements.ahiVisible.checked) {
    setControlRate("ahiPitch", "ahiDataHz");
    setControlRate("ahiRoll", "ahiDataHz");
  }
  if (elements.sticksVisible.checked) {
    setControlRate("sticksRoll", "sticksDataHz");
    setControlRate("sticksPitch", "sticksDataHz");
    setControlRate("sticksYaw", "sticksDataHz");
    setControlRate("sticksThrottle", "sticksDataHz");
  }
  for (const definition of manifestWidgets.values()) {
    if (!definition.visibleControl.checked) continue;
    for (const [key, option] of definition.options) {
      if (option.type !== "field" || option.subscription === "runtime" ||
          (option.required_hz === undefined && option.default_hz === undefined)) continue;
      const raw = definition.controls.get(key)?.value.trim().toUpperCase();
      const numericId = Number(raw);
      const capability = Number.isInteger(numericId)
        ? capabilities.find((field) => field.id === numericId)
        : capabilities.find((field) => field.name.toUpperCase() === raw);
      if (capability) setRate(capability.name.toUpperCase(),
        option.required_hz ?? option.default_hz);
    }
    for (const dependency of resolveManifestDependencies(
      definition.dependencies,
      (key) => definition.controls.get(key)?.value ?? "",
      capabilities,
    )) setRate(dependency.name, dependency.rateHz);
  }
  return rates;
}

function enableRequiredWidgetFields(notify = false) {
  const required = requiredWidgetFields();
  const requestedRates = manifestRequiredFieldRates();
  const enabled = [];
  const disabled = [];
  const available = new Set();
  for (const row of elements.fields.querySelectorAll("tr[data-name]")) {
    const name = row.dataset.name.toUpperCase();
    available.add(name);
    const onCheckbox = row.querySelector(".enabled");
    const shouldBeEnabled = required.has(name);
    if (onCheckbox.checked !== shouldBeEnabled) {
      onCheckbox.checked = shouldBeEnabled;
      (shouldBeEnabled ? enabled : disabled).push(row.dataset.name);
    }
    onCheckbox.setAttribute("aria-label", `${row.dataset.name} ${shouldBeEnabled
      ? "required by an enabled widget" : "not required by enabled widgets"}`);
    const capability = capabilities.find((field) => field.id === Number(row.dataset.id));
    const ownerCell = row.querySelector(".field-owners");
    if (capability && ownerCell) {
      const owners = fieldOwners(capability);
      ownerCell.replaceChildren();
      for (const owner of owners.length ? owners : ["None"]) {
        const label = document.createElement("span");
        label.textContent = owner;
        if (!owners.length) label.className = "muted";
        ownerCell.append(label);
      }
    }
    const state = row.querySelector(".field-state");
    if (state) {
      state.textContent = shouldBeEnabled ? "Active" : "Available";
      state.className = `field-state ${shouldBeEnabled ? "active" : "available"}`;
    }
    if (shouldBeEnabled) {
      let changed = false;
      const requestedRate = requestedRates.get(name);
      if (requestedRate) {
        const rate = row.querySelector(".rate");
        const requiredRate = Math.min(requestedRate, Number(rate.max));
        row.querySelector(".rate-value").textContent = `${requiredRate} Hz`;
        if (Number(rate.value) !== requiredRate) {
          rate.value = requiredRate;
          changed = true;
        }
      }
      if (changed && !enabled.includes(row.dataset.name)) enabled.push(row.dataset.name);
    } else {
      row.querySelector(".rate-value").textContent = "—";
    }
  }
  updateSummary();
  refreshLayout();
  if (notify && (enabled.length || disabled.length)) {
    const changes = [];
    if (enabled.length) changes.push(`On: ${enabled.join(", ")}`);
    if (disabled.length) changes.push(`Off: ${disabled.join(", ")}`);
    setStatus(`Synchronized widget-required fields — ${changes.join(" · ")}. Save widget & fields to persist.`, "good");
  }
  const unavailable = [...required].filter((name) => !available.has(name));
  if (notify && capabilities.length && unavailable.length) {
    setStatus(`Required field${unavailable.length === 1 ? "" : "s"} unavailable: ${unavailable.join(", ")}.`, "bad");
  }
  return { enabled, disabled };
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
      try {
        ghostDpApi = new GhostDpApi(session);
        const api = await ghostDpApi.getCapabilities();
        elements.interfaceIdentity.textContent =
          `Native GHOST_DP ${api.major}.${api.minor}`;
        setStatus("Connected using native GHOST DisplayPort discovery.", "good");
      } catch (_) {
        ghostDpApi = null;
        elements.interfaceIdentity.textContent = "Legacy CLI fallback";
        setStatus("Connected. This firmware will use the legacy CLI adapter.", "good");
      }
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
  const dependencies = parseManifestDependencies(sections, options);
  return { widget, options, dependencies, visibleKey: visible[0] };
}

function stickMenuPolicy(option) {
  const declared = option.stick_menu;
  const policy = String(declared ?? "").toLowerCase();
  if (policy === "default" || policy === "optional" || policy === "never") {
    return {
      allowed: policy === "default" || policy === "optional",
      selectedByDefault: policy === "default",
    };
  }
  const configuratorOnly = option.role === "visible" ||
    option.type === "field" || option.type === "string";
  return { allowed: !configuratorOnly, selectedByDefault: false };
}

function attachStickMenuToggle(definition, key, option, label) {
  const policy = stickMenuPolicy(option);
  const row = document.createElement("div");
  row.className = "widget-option-row";
  label.parentNode.insertBefore(row, label);
  row.append(label);
  const menuLabel = document.createElement("label");
  menuLabel.className = "stick-menu-choice";
  menuLabel.title = policy.allowed
    ? "Include this setting in the RC stick menu"
    : "This setting is configurator-only";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = policy.selectedByDefault;
  toggle.disabled = !policy.allowed;
  toggle.dataset.stickMenuWidget = definition.widget.id;
  toggle.dataset.stickMenuOption = key;
  toggle.setAttribute("aria-label",
    `Include ${option.label ?? key} in the RC stick menu`);
  toggle.addEventListener("change", () => {
    if (!vrxApi) {
      setStatus("Connect the VRX before changing stick-menu selections.", "bad");
      return;
    }
    setStatus("Saving stick-menu selection to the VRX...");
    queueStickMenuSave();
  });
  menuLabel.append(toggle);
  row.append(menuLabel);
  const body = row.parentElement;
  if (body && !body.querySelector(":scope > .widget-option-header")) {
    const header = document.createElement("div");
    header.className = "widget-option-header";
    header.innerHTML = "<span>Setting</span><span>Stick menu</span>";
    body.prepend(header);
  }
  definition.menuControls.set(key, toggle);
}

function attachWidgetSaveButton(definition) {
  const body = definition.card?.querySelector(".widget-card-body");
  if (!body || body.querySelector(":scope > .widget-card-actions")) return;
  const actions = document.createElement("div");
  actions.className = "widget-card-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "widget-save";
  button.textContent = "Save";
  button.title = `Save ${definition.widget.title} configuration`;
  button.disabled = !profileAvailable();
  button.addEventListener("click", async () => {
    if (!profileAvailable()) {
      setStatus("Connect the VRX before saving widget configuration.", "bad");
      return;
    }
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await queueProfileSave();
      button.textContent = "Saved";
      setTimeout(() => { button.textContent = "Save"; }, 1200);
    } finally {
      button.disabled = !profileAvailable();
      if (button.textContent === "Saving…") button.textContent = "Save";
    }
  });
  actions.append(button);
  body.append(actions);
}

function bindBuiltInMenuWidget(parsed) {
  const definition = { ...parsed, controls: new Map(), menuControls: new Map() };
  definition.card = document.querySelector(
    `[data-widget-card="${definition.widget.id}"]`,
  );
  for (const [key, option] of definition.options) {
    if (key === definition.visibleKey || option.hidden === "true") continue;
    const control = elements[option.control];
    const label = control?.closest("label");
    if (!control || !label) continue;
    definition.controls.set(key, control);
    attachStickMenuToggle(definition, key, option, label);
  }
  attachWidgetSaveButton(definition);
  builtInMenuWidgets.set(definition.widget.id, definition);
}

function createManifestControl(definition, key, option) {
  const input = document.createElement(
    option.type === "select" || option.type === "field" ? "select" : "input",
  );
  input.dataset.manifestWidget = definition.widget.id;
  input.dataset.manifestOption = key;
  if (option.type === "field") {
    const choice = document.createElement("option");
    choice.value = option.default ?? "";
    const numericId = Number(choice.value);
    choice.textContent = Number.isInteger(numericId) && numericId >= 32 && numericId <= 49
      ? `RC${numericId - 31}` : String(choice.value);
    input.append(choice);
    input.value = choice.value;
  } else if (option.type === "select") {
    const values = (option.values ?? "").split(",")
      .map((value) => value.trim()).filter(Boolean);
    if (!values.length) {
      throw new Error(`${definition.widget.title}: ${key} has no select values.`);
    }
    for (const value of values) {
      const choice = document.createElement("option");
      choice.value = value;
      choice.textContent = value;
      input.append(choice);
    }
    input.value = option.default ?? values[0];
  } else if (option.type === "boolean") {
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

function refreshManifestFieldControls() {
  if (!capabilities.length) return;
  for (const definition of [...manifestWidgets.values(), ...builtInMenuWidgets.values()]) {
    for (const [key, option] of definition.options) {
      if (option.type !== "field") continue;
      const control = definition.controls.get(key);
      if (!control) continue;
      const stored = lastProfileSections
        ?.get(definition.widget.section)?.[key];
      const previous = control.value.trim() || String(stored ?? "").trim();
      const numericId = Number(previous);
      const selected = Number.isInteger(numericId)
        ? capabilities.find((field) => field.id === numericId)
        : capabilities.find((field) => field.name.toUpperCase() === previous.toUpperCase());
      control.replaceChildren();
      for (const field of capabilities) {
        const choice = document.createElement("option");
        choice.value = String(field.id);
        choice.textContent = field.name;
        control.append(choice);
      }
      if (selected) {
        control.value = String(selected.id);
      } else if (previous) {
        const unavailable = document.createElement("option");
        unavailable.value = previous;
        unavailable.textContent = `${previous} (unavailable)`;
        control.prepend(unavailable);
        control.value = previous;
      }
    }
  }
}

function attachManifestPreview(definition) {
  const widgetKey = `manifest:${definition.widget.id}`;
  const preview = document.createElement("div");
  preview.className = `layout-widget manifest-widget ${definition.widget.preview ?? ""}`;
  preview.dataset.widget = widgetKey;
  preview.tabIndex = 0;
  const label = document.createElement("span");
  label.textContent = definition.widget.preview_label ?? definition.widget.title;
  preview.append(label);
  if ((definition.widget.geometry_width && definition.widget.geometry_height) ||
      (definition.widget.size_width && definition.widget.size_height)) {
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
  const definition = {
    ...parsed, controls: new Map(), menuControls: new Map(), preview: null,
  };
  const fieldset = document.createElement("fieldset");
  fieldset.className = "widget-card collapsed";
  fieldset.dataset.widgetCard = `manifest:${definition.widget.id}`;
  fieldset.dataset.widgetTitle = definition.widget.title;
  definition.card = fieldset;
  const legend = document.createElement("legend");
  const visibleControl = createManifestControl(
    definition, definition.visibleKey,
    definition.options.get(definition.visibleKey),
  );
  definition.visibleControl = visibleControl;
  const enable = document.createElement("label");
  enable.className = "widget-enable";
  enable.append(visibleControl, ` ${definition.widget.title}`);
  const summary = document.createElement("span");
  summary.className = "widget-summary";
  definition.summary = summary;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "widget-collapse-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", `Show ${definition.widget.title} settings`);
  const bodyId = `widgetCardBody-${definition.widget.id}`;
  toggle.setAttribute("aria-controls", bodyId);
  legend.append(enable, summary, toggle);
  fieldset.append(legend);
  const body = document.createElement("div");
  body.id = bodyId;
  body.className = "widget-card-body";
  fieldset.append(body);
  if (definition.widget.description) {
    const description = document.createElement("p");
    description.className = "widget-description";
    description.textContent = definition.widget.description;
    body.append(description);
  }
  let currentGroup = null;
  for (const [key, option] of definition.options) {
    if (key === definition.visibleKey) continue;
    const control = createManifestControl(definition, key, option);
    if (option.hidden === "true") continue;
    if (option.group && option.group !== currentGroup) {
      const group = document.createElement("h3");
      group.className = "widget-option-group";
      group.textContent = option.group;
      body.append(group);
      currentGroup = option.group;
    } else if (!option.group) {
      currentGroup = null;
    }
    const label = document.createElement("label");
    if (option.type === "boolean") label.className = "check";
    label.append(control, ` ${option.label ?? key}${option.unit ? ` (${option.unit})` : ""}`);
    body.append(label);
    attachStickMenuToggle(definition, key, option, label);
    control.addEventListener("input", refreshLayout);
    control.addEventListener("change", () => {
      refreshLayout();
      if (option.type === "field" ||
          definition.dependencies.some((dependency) => dependency.selector === key ||
            dependency.rateOption === key)) {
        enableRequiredWidgetFields(true);
      }
    });
  }
  visibleControl.addEventListener("change", () => {
    refreshLayout();
    enableRequiredWidgetFields(true);
    if (!profileAvailable()) {
      setStatus("Connect the VRX bridge or a compatible flight controller before changing widget enable state.", "bad");
      return;
    }
    queueProfileSave();
  });
  attachWidgetSaveButton(definition);
  elements.manifestWidgets.append(fieldset);
  manifestWidgets.set(definition.widget.id, definition);
  initializeWidgetCard(fieldset);
  if (definition.widget.geometry_x && definition.widget.geometry_y) {
    attachManifestPreview(definition);
  }
  if (lastProfileSections) populateManifestProfiles(lastProfileSections);
}

async function loadWidgetManifests(inventory) {
  try {
    const ids = inventory.map((widget) => widget.id)
      .filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
      .filter((id) => !manifestWidgets.has(id) && !builtInMenuWidgets.has(id));
    const parsed = (await Promise.all(ids.map(async (id) => {
      const path = `./widgets/manifests/${id}.widget.ini`;
      const url = new URL(path, location.href);
      const manifestResponse = await fetch(url, { cache: "no-store" });
      if (manifestResponse.status === 404) return null;
      if (!manifestResponse.ok) throw new Error(`${path}: HTTP ${manifestResponse.status}`);
      return parseWidgetManifest(await manifestResponse.text(), path);
    }))).filter(Boolean);
    parsed.sort((a, b) => Number(a.widget.order ?? 100) - Number(b.widget.order ?? 100));
    for (const manifest of parsed) {
      if (truthy(manifest.widget.builtin)) bindBuiltInMenuWidget(manifest);
      else renderManifestWidget(manifest);
    }
    refreshManifestFieldControls();
    applyVrxInventory();
    refreshLayout();
  } catch (error) {
    setStatus(`VRX widget schemas failed to load: ${error.message}`, "bad");
  }
}

function applyVrxInventory() {
  const installed = new Set(
    vrxInventory?.widgets.map((widget) => widget.id) ?? [],
  );
  elements.layoutEmptyState.hidden = Boolean(vrxInventory);
  elements.layoutBps.hidden = !vrxInventory;
  for (const id of ["ahi", "sticks", "status"]) {
    const card = document.querySelector(`[data-widget-card="${id}"]`);
    if (card) card.hidden = !installed.has(id);
    const preview = layoutElement(id);
    if (preview) preview.hidden = !installed.has(id);
  }
  for (const definition of manifestWidgets.values()) {
    const available = installed.has(definition.widget.id);
    definition.card.hidden = !available;
    if (definition.preview) definition.preview.hidden = !available;
  }
  if (capabilities.length) enableRequiredWidgetFields();
  refreshLayout();
}

async function connectVrx() {
  if (vrxApi) {
    vrxApi = null;
    vrxInventory = null;
    applyVrxInventory();
    setConnected(Boolean(session));
    setStatus("VRX bridge disconnected.");
    return;
  }
  elements.connectVrx.disabled = true;
  try {
    const api = new VrxApi();
    await api.status();
    const inventory = await api.inventory();
    if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.widgets))
      throw new Error("VRX returned an unsupported widget inventory.");
    vrxApi = api;
    vrxInventory = inventory;
    await loadWidgetManifests(inventory.widgets);
    applyVrxInventory();
    setConnected(Boolean(session));
    await loadProfile();
    setStatus(`Connected to VRX · ${inventory.widgets.length} installed widgets.`, "good");
  } catch (error) {
    vrxApi = null;
    vrxInventory = null;
    setStatus(`VRX bridge: ${error.message}`, "bad");
  } finally {
    elements.connectVrx.disabled = false;
    setConnected(Boolean(session));
  }
}

const truthy = (value) => /^(1|true|yes|on)$/i.test(value ?? "");
function setValue(id, value) { if (value !== undefined) elements[id].value = value; }

function stickMenuDefinitions() {
  return [...builtInMenuWidgets.values(), ...manifestWidgets.values()];
}

function populateStickMenuProfiles(sections) {
  const selection = sections.get("stick_menu");
  for (const definition of stickMenuDefinitions()) {
    const stored = selection &&
      Object.prototype.hasOwnProperty.call(selection, definition.widget.section);
    const selected = new Set(stored
      ? String(selection[definition.widget.section]).split(",")
        .map((key) => key.trim()).filter(Boolean)
      : []);
    for (const [key, option] of definition.options) {
      const toggle = definition.menuControls.get(key);
      if (!toggle) continue;
      const policy = stickMenuPolicy(option);
      toggle.checked = policy.allowed &&
        (stored ? selected.has(key) : policy.selectedByDefault);
      toggle.disabled = !policy.allowed;
    }
  }
}

function profileOptionValue(value, option) {
  if (option.transform !== "percent_to_alpha") return value;
  const number = Number(value);
  if (Number.isFinite(number) && number > 100 && number <= 255) {
    return String(Math.round(number * 100 / 255));
  }
  return value;
}

function populateManifestProfiles(sections) {
  for (const definition of manifestWidgets.values()) {
    const profile = sections.get(definition.widget.section);
    for (const [key, option] of definition.options) {
      const control = definition.controls.get(key);
      const value = profileOptionValue(profile?.[key] ?? option.default, option);
      if (control.type === "checkbox") control.checked = truthy(value);
      else if (value !== undefined) {
        if (option.type === "field" && control.tagName === "SELECT" &&
            ![...control.options].some((choice) => choice.value === String(value))) {
          const choice = document.createElement("option");
          choice.value = String(value);
          const numericId = Number(value);
          const capability = Number.isInteger(numericId)
            ? capabilities.find((field) => field.id === numericId) : null;
          choice.textContent = capability?.name ??
            (numericId >= 32 && numericId <= 49 ? `RC${numericId - 31}` : String(value));
          control.append(choice);
        }
        control.value = value;
      }
    }
  }
  populateStickMenuProfiles(sections);
}

function populateProfile(text) {
  const sections = parseIni(text);
  lastProfileSections = sections;
  fieldDeadbands.clear();
  videoColourPolicies.clear();
  for (const [section, values] of sections) {
    const match = /^field_policy\.(\d+)$/.exec(section);
    if (!match) continue;
    const fieldId = Number(match[1]);
    const hasColour = values.colour_enabled !== undefined ||
      values.green_threshold !== undefined || values.amber_threshold !== undefined ||
      values.red_threshold !== undefined;
    const videoField = VIDEO_SYSTEM_FIELDS.find(({ id }) => id === fieldId);
    if (videoField) {
      if (hasColour) {
        videoColourPolicies.set(videoField.key, {
          enabled: truthy(values.colour_enabled),
          direction: values.colour_direction === "high" ? "high" : "low",
          green: Number(values.green_threshold),
          amber: Number(values.amber_threshold),
          red: Number(values.red_threshold),
          flashOnRed: truthy(values.flash_on_red),
        });
      }
      continue;
    }

    const deadband = Number(values.deadband_raw ?? 0);
    if (fieldId > 0 && Number.isInteger(deadband) && deadband >= 0)
      fieldDeadbands.set(fieldId, deadband);
  }
  const parsedReloadToken = Number(sections.get("display")?.r ?? 0);
  widgetReloadToken = Number.isInteger(parsedReloadToken) &&
    parsedReloadToken >= 0 && parsedReloadToken <= 65535 ? parsedReloadToken : 0;
  const ahi = sections.get("ahi.0");
  if (ahi) {
    elements.ahiVisible.checked = truthy(ahi.visible);
    setValue("ahiPitch", ahi.pitch_field); setValue("ahiRoll", ahi.roll_field);
    setValue("ahiX", ahi.center_x); setValue("ahiY", ahi.center_y);
    setValue("ahiWidth", ahi.width); setValue("ahiHeight", ahi.height ?? "5000");
    setValue("ahiPitchScale", ahi.vertical_range_degrees ?? "90");
    setValue("ahiLineWidth", ahi.line_width ?? "3");
    setValue("ahiSmoothing", ahi.smoothing);
    setValue("ahiFps", ahi.max_fps);
    setValue("ahiMinimumDataHz", ahi.minimum_data_hz ?? "20");
    setValue("ahiDataHz", ahi.data_hz ?? "30");
    setValue("ahiStale", ahi.stale_timeout_ms ?? "2500");
    elements.ahiReversePitch.checked = truthy(ahi.reverse_pitch);
    elements.ahiReverseRoll.checked = truthy(ahi.reverse_roll);
    elements.ahiPrediction.checked = ahi.prediction === undefined || truthy(ahi.prediction);
    elements.ahiTestMode.checked = truthy(ahi.test_mode);
  }
  const sticks = sections.get("sticks.0");
  if (sticks) {
    elements.sticksVisible.checked = truthy(sticks.visible);
    setValue("sticksMode", sticks.mode); setValue("sticksRoll", sticks.roll_field);
    setValue("sticksPitch", sticks.pitch_field); setValue("sticksYaw", sticks.yaw_field);
    setValue("sticksThrottle", sticks.throttle_field); setValue("sticksX", sticks.position_x);
    setValue("sticksY", sticks.position_y); setValue("sticksSize", sticks.size_percent);
    setValue("sticksBackgroundOpacity", sticks.background_opacity ?? "50");
    setValue("sticksFps", sticks.max_fps);
    setValue("sticksMinimumDataHz", sticks.minimum_data_hz ?? "10");
    setValue("sticksDataHz", sticks.data_hz ?? "20");
    setValue("sticksStale", sticks.stale_timeout_ms ?? "2500");
    elements.sticksReverseRoll.checked = truthy(sticks.reverse_roll);
    elements.sticksReversePitch.checked = truthy(sticks.reverse_pitch);
    elements.sticksReverseYaw.checked = truthy(sticks.reverse_yaw);
    elements.sticksReverseThrottle.checked = truthy(sticks.reverse_throttle);
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
    setValue("statusOpacity", profileOptionValue(status.background_opacity, { transform: "percent_to_alpha" }));
    setValue("statusStale", status.stale_timeout_ms);
  }
  populateManifestProfiles(sections);
  if (capabilities.length) renderFields();
  renderVideoSystemFields();
  enableRequiredWidgetFields();
  refreshLayout();
}

function fieldName(id) {
  let value = elements[id].value.trim().toUpperCase();
  const numericId = Number(value);
  if (Number.isInteger(numericId)) {
    const capability = capabilities.find((field) => field.id === numericId);
    if (capability) value = capability.name.toUpperCase();
  }
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
    if (Number(value) < 1 || Number(value) > 65535) {
      throw new Error(`${definition.widget.title}: ${key} must be a field ID from 1 to 65535.`);
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
  if (numeric("ahiMinimumDataHz") > numeric("ahiDataHz") ||
      numeric("sticksMinimumDataHz") > numeric("sticksDataHz")) {
    throw new Error("A widget minimum data rate cannot exceed its preferred data rate.");
  }
  const lines = [
    "; GHOST widget profile v1", "[display]",
    "reference_width=1920", "reference_height=1080", `r=${widgetReloadToken}`, "", "[ahi.0]",
    `pitch_field=${fieldName("ahiPitch")}`, `roll_field=${fieldName("ahiRoll")}`,
    `center_x=${numberValue("ahiX", 0, 10000)}`, `center_y=${numberValue("ahiY", 0, 10000)}`,
    `width=${numberValue("ahiWidth", 1, 10000)}`,
    `height=${numberValue("ahiHeight", 1, 10000)}`,
    `vertical_range_degrees=${numberValue("ahiPitchScale", 20, 180)}`,
    `line_width=${numberValue("ahiLineWidth", 1, 12)}`,
    `visible=${elements.ahiVisible.checked}`, `reverse_pitch=${elements.ahiReversePitch.checked}`,
    `reverse_roll=${elements.ahiReverseRoll.checked}`,
    `prediction=${elements.ahiPrediction.checked}`,
    `test_mode=${elements.ahiTestMode.checked}`,
    `smoothing=${numberValue("ahiSmoothing", 0, 10)}`,
    `max_fps=${numberValue("ahiFps", 1, 60)}`,
    `minimum_data_hz=${numberValue("ahiMinimumDataHz", 1, 1000)}`,
    `data_hz=${numberValue("ahiDataHz", 1, 1000)}`,
    `stale_timeout_ms=${numberValue("ahiStale", 1200, 10000)}`, "", "[sticks.0]",
    `mode=${numberValue("sticksMode", 1, 2)}`, `visible=${elements.sticksVisible.checked}`,
    `roll_field=${fieldName("sticksRoll")}`, `pitch_field=${fieldName("sticksPitch")}`,
    `yaw_field=${fieldName("sticksYaw")}`, `throttle_field=${fieldName("sticksThrottle")}`,
    `reverse_roll=${elements.sticksReverseRoll.checked}`, `reverse_pitch=${elements.sticksReversePitch.checked}`,
    `reverse_yaw=${elements.sticksReverseYaw.checked}`, `reverse_throttle=${elements.sticksReverseThrottle.checked}`,
    `position_x=${numberValue("sticksX", -4096, 4096)}`, `position_y=${numberValue("sticksY", -4096, 4096)}`,
    `size_percent=${numberValue("sticksSize", 25, 200)}`,
    `background_opacity=${numberValue("sticksBackgroundOpacity", 0, 100)}`,
    `max_fps=${numberValue("sticksFps", 1, 60)}`,
    `minimum_data_hz=${numberValue("sticksMinimumDataHz", 1, 1000)}`,
    `data_hz=${numberValue("sticksDataHz", 1, 1000)}`,
    `stale_timeout_ms=${numberValue("sticksStale", 1200, 10000)}`, "", "[status.0]",
    `visible=${elements.statusVisible.checked}`,
    `show_vtx_temperature=${elements.statusVtxTemperature.checked}`,
    `show_goggles_temperature=${elements.statusGogglesTemperature.checked}`,
    `show_vtx_voltage=${elements.statusVtxVoltage.checked}`,
    `show_goggles_voltage=${elements.statusGogglesVoltage.checked}`,
    `position_x=${numberValue("statusX", 0, 1919)}`,
    `position_y=${numberValue("statusY", 0, 1079)}`,
    `size_percent=${numberValue("statusSize", 50, 200)}`,
    `max_fps=${numberValue("statusFps", 1, 30)}`,
    `background_opacity=${numberValue("statusOpacity", 0, 100)}`,
    `stale_timeout_ms=${numberValue("statusStale", 0, 60000)}`, "",
  ];
  for (const definition of manifestWidgets.values()) {
    const values = compactManifestOptions(
      definition.options, definition.visibleKey,
      (key, option) => manifestOptionValue(definition, key, option),
    );
    if (!values) continue;
    lines.push(`[${definition.widget.section}]`);
    for (const [key, value] of values) lines.push(key + "=" + value);
    lines.push("");
  }
  const installedWidgets = vrxInventory
    ? new Set(vrxInventory.widgets.map((widget) => widget.id))
    : null;
  const stickMenuLines = [];
  for (const definition of stickMenuDefinitions()) {
    if (installedWidgets && !installedWidgets.has(definition.widget.id)) continue;
    const selected = [];
    for (const [key, option] of definition.options) {
      const policy = stickMenuPolicy(option);
      const toggle = definition.menuControls.get(key);
      if (policy.allowed && toggle?.checked) selected.push(key);
    }
    stickMenuLines.push(definition.widget.section + "=" + selected.join(","));
  }
  if (stickMenuLines.length) lines.push("[stick_menu]", ...stickMenuLines, "");
  for (const row of elements.fields.querySelectorAll("tr[data-id]")) {
    if (!row.querySelector(".enabled")?.checked) continue;
    const fieldId = Number(row.dataset.id);
    const presentation = {
      factor: Number(row.dataset.deadbandFactor ?? 1),
      decimals: Number(row.dataset.deadbandDecimals ?? 0),
    };
    const deadband = rawDeadband(row.querySelector(".deadband")?.value ?? 0,
      presentation);
    if (Number.isInteger(fieldId) && fieldId > 0 &&
        deadband !== null) {
      fieldDeadbands.set(fieldId, deadband);
    }
  }
  const policyFieldIds = new Set(
    [...fieldDeadbands.entries()]
      .filter(([, value]) => value > 0).map(([id]) => id),
  );
  for (const fieldId of [...policyFieldIds].sort((a, b) => a - b)) {
    lines.push(`[field_policy.${fieldId}]`);
    const deadband = fieldDeadbands.get(fieldId) ?? 0;
    if (deadband > 0) lines.push(`deadband_raw=${deadband}`);
    lines.push("");
  }
  for (const field of VIDEO_SYSTEM_FIELDS) {
    const colour = videoColourPolicies.get(field.key);
    if (!colour?.enabled) continue;
    lines.push("[field_policy." + field.id + "]",
      "colour_enabled=true",
      "colour_direction=" + colour.direction);
    if (Number.isFinite(colour.green)) lines.push("green_threshold=" + colour.green);
    if (Number.isFinite(colour.amber)) lines.push("amber_threshold=" + colour.amber);
    if (Number.isFinite(colour.red)) lines.push("red_threshold=" + colour.red);
    if (colour.flashOnRed) lines.push("flash_on_red=true");
    lines.push("");
  }
  return lines.join("\n");
}

async function loadProfile() {
  try {
    setStatus(vrxApi ? "Reading widget profile from the VRX..." :
      "Reading widget profile from the flight controller...");
    const profile = vrxApi ? await vrxApi.readProfile() : await ghostApi.readProfile();
    if (profile.length) populateProfile(profile.text);
    elements.profileInfo.textContent = `Revision ${profile.revision} | ${profile.length} bytes`;
    setStatus(profile.length ? `Widget profile loaded from ${vrxApi ? "VRX" : "FC"}.` :
      `${vrxApi ? "VRX" : "FC"} has no widget profile; showing defaults.`, "good");
  } catch (error) { setStatus(error.message, "bad"); }
}

async function applyProfile() {
  try {
    if (vrxApi) {
      const text = buildProfile();
      elements.applyProfile.disabled = true;
      setStatus("Storing the widget profile on the VRX...");
      const result = await vrxApi.uploadProfile(text);
      elements.profileInfo.textContent = `Revision ${result.revision} | ${result.length} bytes`;
      setStatus("VRX profile installed. The native manager is applying it now.", "good");
      return;
    }
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
    elements.applyProfile.disabled = !profileAvailable();
    elements.reloadWidgets.disabled = !profileAvailable();
    elements.apply.disabled = capabilities.length === 0;
  }
}

function queueProfileSave() {
  profileSaveQueue = profileSaveQueue.catch(() => {}).then(() => applyProfile());
  return profileSaveQueue;
}

function selectedStickMenuLines() {
  const installed = vrxInventory
    ? new Set(vrxInventory.widgets.map((widget) => widget.id))
    : null;
  const lines = [];
  for (const definition of stickMenuDefinitions()) {
    if (installed && !installed.has(definition.widget.id)) continue;
    const selected = [];
    for (const [key, option] of definition.options) {
      const policy = stickMenuPolicy(option);
      const toggle = definition.menuControls.get(key);
      if (policy.allowed && toggle?.checked) selected.push(key);
    }
    lines.push(definition.widget.section + "=" + selected.join(","));
  }
  return lines;
}

function replaceProfileSection(text, name, values) {
  const source = text.replace(/\r\n/g, "\n").split("\n");
  let start = source.findIndex((line) => line.trim() === "[" + name + "]");
  let end = source.length;
  if (start >= 0) {
    for (let index = start + 1; index < source.length; ++index) {
      if (/^\s*\[[^\]]+\]\s*$/.test(source[index])) {
        end = index;
        break;
      }
    }
  } else {
    while (source.length && !source[source.length - 1].trim()) source.pop();
    start = source.length;
    end = start;
  }
  const replacement = ["[" + name + "]", ...values, ""];
  source.splice(start, end - start, ...replacement);
  return source.join("\n").replace(/\n*$/, "\n");
}

async function applyStickMenuSelection() {
  try {
    if (!vrxApi) throw new Error("Connect the VRX before changing stick-menu selections.");
    const current = await vrxApi.readProfile();
    const text = replaceProfileSection(
      current.text, "stick_menu", selectedStickMenuLines(),
    );
    const result = await vrxApi.uploadProfile(text);
    const readback = await vrxApi.readProfile();
    if (readback.crc32 !== result.crc32 || readback.length !== result.length) {
      throw new Error("VRX stick-menu profile read-back did not match.");
    }
    lastProfileSections = parseIni(readback.text);
    elements.profileInfo.textContent =
      "Revision " + readback.revision + " | " + readback.length + " bytes";
    setStatus("Stick-menu selection saved and verified on the VRX.", "good");
  } catch (error) {
    setStatus(error.message, "bad");
    throw error;
  }
}

function queueStickMenuSave() {
  profileSaveQueue = profileSaveQueue.catch(() => {})
    .then(() => applyStickMenuSelection());
  return profileSaveQueue;
}

function reloadWidgets() {
  widgetReloadToken = (widgetReloadToken + 1) & 0xffff;
  elements.reloadWidgets.disabled = true;
  setStatus(`Saving widget reload request to the ${vrxApi ? "VRX" : "flight controller"}...`);
  return queueProfileSave();
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
    } else if (ghostDpApi) {
      setStatus("Reading the native GHOST DisplayPort field catalogue…");
      capabilities = await ghostDpApi.getFieldCatalog();
      configured = new Map();
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
    cacheFieldCatalogue();
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
    if (ghostDpApi) {
      if (!vrxApi) throw new Error("Connect the VRX before saving native GHOST_DP field policy.");
      await applyProfile();
      elements.apply.disabled = false;
      return;
    }
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
  capabilities = readCachedFieldCatalogue();
  ghostApi = null;
  ghostDpApi = null;
  widgetProfileSupported = false;
  configured.clear();
  refreshManifestFieldControls();
  elements.fields.replaceChildren();
  elements.fcIdentity.textContent = "Not connected";
  elements.boardIdentity.textContent = "—";
  elements.interfaceIdentity.textContent = "—";
  elements.selection.textContent = "0 fields required";
  updateSummary();
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
elements.fieldSearch.addEventListener("input", updateSummary);
elements.fieldScope.addEventListener("change", updateSummary);
elements.fieldGroup.addEventListener("change", updateSummary);
elements.loadProfile.addEventListener("click", loadProfile);
elements.connectVrx.addEventListener("click", connectVrx);
elements.reloadWidgets.addEventListener("click", reloadWidgets);
elements.applyProfile.addEventListener("click", queueProfileSave);
for (const id of ["ahiPitch", "ahiRoll", "sticksRoll", "sticksPitch", "sticksYaw",
  "sticksThrottle"]) {
  elements[id].addEventListener("change", () => enableRequiredWidgetFields(true));
}
for (const id of ["ahiDataHz", "sticksDataHz"]) {
  elements[id].addEventListener("change", () => enableRequiredWidgetFields(true));
}
for (const id of ["ahiVisible", "sticksVisible", "statusVisible"]) {
  elements[id].addEventListener("change", () => {
    refreshLayout();
    enableRequiredWidgetFields(true);
    if (!profileAvailable()) {
      setStatus("Connect the VRX bridge or a compatible flight controller before changing widget enable state.", "bad");
      return;
    }
    queueProfileSave();
  });
}
for (const card of document.querySelectorAll(".widget-card")) initializeWidgetCard(card);
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
  "ahiFps", "ahiMinimumDataHz", "ahiDataHz",
  "sticksFps", "sticksMinimumDataHz", "sticksDataHz", "statusFps",
  "sticksX", "sticksY",
  "sticksSize", "sticksBackgroundOpacity", "statusX", "statusY", "statusSize",
  "statusVtxTemperature", "statusGogglesTemperature",
  "statusVtxVoltage", "statusGogglesVoltage"]) {
  elements[id].addEventListener("input", refreshLayout);
  elements[id].addEventListener("change", refreshLayout);
}
elements.sticksSize.addEventListener("change", () => {
  if (profileAvailable()) queueProfileSave();
  else setStatus("Sticks size updated locally. Connect the VRX bridge to apply it.", "neutral");
});
elements.layoutResolution.addEventListener("change", refreshLayout);
elements.layoutSnap.addEventListener("change", refreshLayout);

function selectConfiguratorPage(name) {
  for (const page of document.querySelectorAll("[data-config-page]")) {
    page.classList.toggle("active", page.dataset.configPage === name);
  }
  for (const tab of document.querySelectorAll("[data-config-target]")) {
    const active = tab.dataset.configTarget === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-current", active ? "page" : "false");
  }
  try { localStorage.setItem("ghost-configurator-page", name); } catch (_) {}
}

function setConfiguratorMode(mode) {
  const selected = mode === "classic" ? "classic" : "modern";
  document.body.dataset.configMode = selected;
  elements.configuratorMode.value = selected;
  try { localStorage.setItem("ghost-configurator-mode", selected); } catch (_) {}
  refreshLayout();
}

for (const tab of document.querySelectorAll("[data-config-target]")) {
  tab.addEventListener("click", () => selectConfiguratorPage(tab.dataset.configTarget));
}
elements.configuratorMode.addEventListener("change", () =>
  setConfiguratorMode(elements.configuratorMode.value));
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  elements.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  elements.sidebarToggle.setAttribute("aria-label",
    collapsed ? "Expand sidebar" : "Collapse sidebar");
  try { localStorage.setItem("ghost-configurator-sidebar", collapsed ? "collapsed" : "expanded"); }
  catch (_) {}
  refreshLayout();
}
elements.sidebarToggle.addEventListener("click", () =>
  setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed")));
let initialPage = "dashboard";
let initialMode = "modern";
let initialSidebarCollapsed = false;
try {
  initialPage = localStorage.getItem("ghost-configurator-page") || initialPage;
  initialMode = localStorage.getItem("ghost-configurator-mode") || initialMode;
  initialSidebarCollapsed = localStorage.getItem("ghost-configurator-sidebar") === "collapsed";
} catch (_) {}
selectConfiguratorPage(initialPage);
setConfiguratorMode(initialMode);
setSidebarCollapsed(initialSidebarCollapsed);

setConnected(false);
refreshLayout();
applyVrxInventory();
if (!("serial" in navigator)) {
renderVideoSystemFields();
  setStatus("Web Serial is unavailable in this browser. Use desktop Chrome, Edge, or Chromium.", "bad");
}
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js?v=82").catch(() => {});
}
