import { MSP, decodeAscii, parseCapabilities, parseConfiguredFields } from "./protocol.js";
import { SerialSession } from "./serial.js";
import { GhostMspApi } from "./ghost-api.js";

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
    row.querySelectorAll("input").forEach((input) => input.addEventListener("change", updateSummary));
    elements.fields.append(row);
  }
  updateSummary();
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

const truthy = (value) => /^(1|true|yes|on)$/i.test(value ?? "");
function setValue(id, value) { if (value !== undefined) elements[id].value = value; }

function populateProfile(text) {
  const sections = parseIni(text);
  const ahi = sections.get("ahi.0");
  if (ahi) {
    elements.ahiVisible.checked = truthy(ahi.visible);
    setValue("ahiPitch", ahi.pitch_field); setValue("ahiRoll", ahi.roll_field);
    setValue("ahiX", ahi.center_x); setValue("ahiY", ahi.center_y);
    setValue("ahiWidth", ahi.width); setValue("ahiSmoothing", ahi.smoothing);
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

function buildProfile() {
  const lines = [
    "; GHOST widget profile v1", "[ahi.0]",
    `pitch_field=${fieldName("ahiPitch")}`, `roll_field=${fieldName("ahiRoll")}`,
    `center_x=${numberValue("ahiX", 0, 10000)}`, `center_y=${numberValue("ahiY", 0, 10000)}`,
    `width=${numberValue("ahiWidth", 1, 10000)}`, "height=5000",
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
    `max_fps=${numberValue("sticksFps", 1, 60)}`, "stale_timeout_ms=500", "",
  ];
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
    const text = buildProfile();
    elements.applyProfile.disabled = true;
    setStatus("Storing widget profile on the flight controller…");
    const result = await ghostApi.uploadProfile(text);
    elements.profileInfo.textContent = `Revision ${result.revision} · ${result.length} bytes`;
    setStatus("Widget profile persisted. The FC will deliver it to the VRX over DisplayPort.", "good");
  } catch (error) { setStatus(error.message, "bad"); }
  finally { elements.applyProfile.disabled = !widgetProfileSupported; }
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

async function applyFields() {
  const selected = selectedFields();
  for (const field of selected) {
    const capability = capabilities.find((candidate) => candidate.name === field.name);
    if (!Number.isInteger(field.rateHz) || field.rateHz < 1 || field.rateHz > capability.maxHz) {
      setStatus(`${field.name} must be between 1 and ${capability.maxHz} Hz.`, "bad");
      return;
    }
  }

  try {
    elements.apply.disabled = true;
    setStatus("Writing configuration…");
    if (ghostApi) {
      const byName = new Map(capabilities.map((field) => [field.name, field]));
      const records = selected.map((field, index) => ({
        slot: index, id: byName.get(field.name).id, rateHz: field.rateHz,
      }));
      const readback = await ghostApi.replaceSubscriptions(records);
      const matches = readback.records.length === records.length && records.every((record, index) => {
        const actual = readback.records[index];
        return actual.slot === record.slot && actual.fieldId === record.id && actual.rateHz === record.rateHz;
      });
      if (!matches) throw new Error("FC read-back does not match the requested configuration");
      configured = new Map(selected.map((field) => [field.name, field]));
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
elements.applyProfile.addEventListener("click", applyProfile);

setConnected(false);
if (!("serial" in navigator)) {
  setStatus("Web Serial is unavailable in this browser. Use desktop Chrome, Edge, or Chromium.", "bad");
}
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js?v=12").catch(() => {});
}
