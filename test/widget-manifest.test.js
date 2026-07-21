import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function parseIni(text) {
  const sections = new Map();
  let section;
  for (const source of text.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) {
      section = {};
      sections.set(heading[1], section);
      continue;
    }
    const separator = line.indexOf("=");
    assert.ok(section && separator > 0, `malformed line: ${line}`);
    section[line.slice(0, separator).trim()] =
      line.slice(separator + 1).trim();
  }
  return sections;
}

test("catalog exposes a valid rotating-logo package", async () => {
  const catalog = JSON.parse(await readFile(
    new URL("../widgets/catalog.json", import.meta.url), "utf8",
  ));
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(catalog.manifests, [
    "./manifests/rotating_logo.widget.ini",
    "./manifests/link_status.widget.ini",
    "./manifests/vrx_status_bar.widget.ini",
    "./manifests/head_tracking.widget.ini",
    "./manifests/antenna_tracker.widget.ini",
  ]);

  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/rotating_logo.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "rotating_logo");
  assert.equal(widget.section, "rotating_logo.0");
  assert.equal(widget.geometry_owner, "widget");
  assert.equal(widget.geometry_width, "size");
  assert.equal(widget.geometry_height, "size");
  assert.equal(sections.get("option.visible").role, "visible");
  assert.equal(sections.get("option.size").type, "logical_size");
});

test("link-status package exposes resizable diagnostic geometry", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/link_status.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "link_status");
  assert.equal(widget.geometry_width, "width");
  assert.equal(widget.geometry_height, "height");
  assert.equal(widget.geometry_lock_aspect, "true");
  assert.equal(sections.get("option.refresh_hz").default, "4");
  assert.equal(sections.get("option.info_file").hidden, "true");
});

test("VRX status bar package is horizontal and aspect locked", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/vrx_status_bar.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "vrx_status_bar");
  assert.equal(widget.geometry_lock_aspect, "true");
  assert.equal(sections.get("option.width").default, "1000");
  assert.equal(sections.get("option.height").default, "70");
});

test("head-tracking package exposes three-axis mapping and geometry", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/head_tracking.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "head_tracking");
  assert.equal(widget.section, "head_tracking.0");
  assert.equal(widget.geometry_owner, "manager");
  assert.equal(widget.geometry_lock_aspect, "true");
  assert.equal(sections.get("option.roll_axis").default, "0");
  assert.equal(sections.get("option.pan_axis").default, "2");
  assert.equal(sections.get("option.tilt_axis").default, "1");
  assert.equal(sections.get("option.ring_file").hidden, "true");
});

test("antenna-tracker package declares GPS inputs and test vector", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/antenna_tracker.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "antenna_tracker");
  assert.equal(widget.field_shm, "true");
  assert.equal(sections.get("option.latitude_field").default, "4");
  assert.equal(sections.get("option.longitude_field").default, "5");
  assert.equal(sections.get("option.altitude_field").default, "6");
  assert.equal(sections.get("option.test_distance_m").default, "200");
  assert.equal(sections.get("option.test_altitude_m").default, "75");
  assert.equal(sections.get("option.test_mode").default, "false");
  assert.equal(sections.get("option.expo").default, "3");
  assert.equal(sections.get("option.expo").max, "10");
  assert.equal(sections.get("option.pan_axis").group, "Pan");
  assert.equal(sections.get("option.pan_reference_deg").group, "Pan");
  assert.equal(sections.get("option.tilt_axis").group, "Tilt");
  assert.equal(sections.get("option.vertical_range_deg").group, "Tilt");
});

test("widget binary is constrained to the managed Goggles X directory", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/rotating_logo.widget.ini", import.meta.url),
    "utf8",
  ));
  assert.match(
    sections.get("widget").binary,
    /^\/record\/GHOST\/gogglesx\/bin\/ghost_widget_[A-Za-z0-9_-]+$/,
  );
});
