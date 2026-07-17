import { MSP, decodeAscii, parseCapabilities, parseConfiguredFields } from "./protocol.js";
import { SerialSession } from "./serial.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);

let session = null;
let capabilities = [];
let configured = new Map();
let demoMode = false;

function setStatus(message, level = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.level = level;
}

function setConnected(connected) {
  elements.connect.disabled = connected;
  elements.demo.disabled = connected;
  elements.load.disabled = !connected;
  elements.apply.disabled = !connected || capabilities.length === 0;
  elements.disconnect.disabled = !connected;
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
    .filter((row) => row.querySelector(".enabled").checked)
    .map((row, index) => ({
      slot: index + 1,
      name: row.dataset.name,
      rateHz: Number(row.querySelector(".rate").value),
    }));
}

function updateSummary() {
  const selected = selectedFields();
  elements.selection.textContent = `${selected.length} field${selected.length === 1 ? "" : "s"} enabled`;
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
    setStatus("Connected. Load GHOST fields to begin.", "good");
  } catch (error) {
    setStatus(error.message, "bad");
    if (session?.port) await session.close().catch(() => {});
    session = null;
    setConnected(false);
  }
}

async function loadFields() {
  try {
    setStatus("Entering CLI and reading GHOST capabilities…");
    await session.enterCli();
    const capabilityText = await session.runCli("ghost_field list");
    const configuredText = await session.runCli("ghost_field");
    capabilities = parseCapabilities(capabilityText);
    configured = new Map(parseConfiguredFields(configuredText).map((field) => [field.name, field]));
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
    if (!demoMode) {
      await session.runCli("ghost_field clear all");
      for (const field of selected) {
        await session.runCli(`ghost_field set ${field.slot} ${field.name} ${field.rateHz}`);
      }
      setStatus("Saving and rebooting the flight controller…");
      await session.runCli("save", 1500).catch(() => {}); // save reboots before another prompt
      await session.close().catch(() => {});
      session = null;
      setConnected(false);
    }
    configured = new Map(selected.map((field) => [field.name, field]));
    setStatus(demoMode ? "Demo configuration applied." : "Configuration saved; flight controller is rebooting.", "good");
  } catch (error) {
    setStatus(error.message, "bad");
    elements.apply.disabled = false;
  }
}

function startDemo() {
  demoMode = true;
  capabilities = [
    { id: 1, name: "PITCH", maxHz: 50 }, { id: 2, name: "ROLL", maxHz: 50 },
    { id: 3, name: "HEADING", maxHz: 50 }, { id: 4, name: "LATITUDE", maxHz: 50 },
    { id: 5, name: "LONGITUDE", maxHz: 50 }, { id: 8, name: "BATTERY_VOLTAGE", maxHz: 50 },
    { id: 32, name: "RC1", maxHz: 50 }, { id: 33, name: "RC2", maxHz: 50 },
    { id: 34, name: "RC3", maxHz: 50 }, { id: 35, name: "RC4", maxHz: 50 },
  ];
  configured = new Map([
    ["PITCH", { name: "PITCH", rateHz: 20 }],
    ["ROLL", { name: "ROLL", rateHz: 20 }],
    ["BATTERY_VOLTAGE", { name: "BATTERY_VOLTAGE", rateHz: 1 }],
  ]);
  elements.fcIdentity.textContent = "BTFL 4.x (demo)";
  elements.boardIdentity.textContent = "MATEKF405SE";
  renderFields();
  setConnected(true);
  elements.load.disabled = true;
  elements.apply.disabled = false;
  setStatus("Demo mode: no serial data will be sent.", "good");
}

async function disconnect() {
  if (demoMode) {
    demoMode = false;
  } else if (session) {
    setStatus("Exiting CLI and rebooting…");
    await session.close({ reboot: true }).catch(() => {});
    session = null;
  }
  capabilities = [];
  configured.clear();
  elements.fields.replaceChildren();
  elements.fcIdentity.textContent = "Not connected";
  elements.boardIdentity.textContent = "—";
  elements.selection.textContent = "0 fields enabled";
  setConnected(false);
  setStatus("Disconnected.");
}

elements.connect.addEventListener("click", connect);
elements.demo.addEventListener("click", startDemo);
elements.load.addEventListener("click", loadFields);
elements.apply.addEventListener("click", applyFields);
elements.disconnect.addEventListener("click", disconnect);

setConnected(false);
if (!("serial" in navigator)) {
  setStatus("Web Serial is unavailable in this browser. Use desktop Chrome, Edge, or Chromium.", "bad");
}
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
