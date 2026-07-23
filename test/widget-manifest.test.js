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
    "./manifests/compass.widget.ini",
    "./manifests/rotating_logo.widget.ini",
    "./manifests/link_status.widget.ini",
    "./manifests/vrx_status_bar.widget.ini",
    "./manifests/head_tracking.widget.ini",
    "./manifests/antenna_tracker.widget.ini",
    "./manifests/pid_scope.widget.ini",
    "./manifests/ghost_dp_stats.widget.ini",
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

test("compass package declares heading and home-bearing inputs", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/compass.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "compass");
  assert.equal(widget.field_shm, "true");
  assert.equal(widget.geometry_lock_aspect, "true");
  assert.equal(sections.get("option.heading_field").default, "3");
  assert.equal(sections.get("option.home_bearing_field").default, "12");
  assert.equal(sections.get("option.heading_valid_field").default, "13");
  assert.equal(sections.get("option.gps_fix_field").default, "14");
  assert.equal(sections.get("option.home_valid_field").default, "15");
  assert.equal(sections.get("option.test_mode").default, "false");
  assert.equal(sections.get("option.test_mode").arg, "--test-mode");
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
  assert.equal(sections.get("option.suppress_text").default, "false");
  assert.equal(sections.get("option.suppress_text").arg, "--suppress-text");
  assert.equal(sections.get("option.pan_axis").group, "Pan");
  assert.equal(sections.get("option.pan_reference_deg").group, "Pan");
  assert.equal(sections.get("option.tilt_axis").group, "Tilt");
  assert.equal(sections.get("option.vertical_range_deg").group, "Tilt");
  assert.equal(sections.get("option.test_mode").group, "Test");
  assert.equal(sections.get("option.test_distance_m").group, "Test");
  assert.equal(sections.get("option.test_altitude_m").group, "Test");
  assert.equal(sections.get("option.test_bearing_deg").group, "Test");
});

test("GHOST_DP statistics package exposes managed diagnostic geometry", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/ghost_dp_stats.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "ghost_dp_stats");
  assert.equal(widget.section, "ghost_dp_stats.0");
  assert.equal(widget.binary, "/record/GHOST_DP/bin/ghost_dp_widget_stats");
  assert.equal(widget.geometry_lock_aspect, "true");
  assert.equal(sections.get("option.refresh_hz").default, "4");
  assert.equal(sections.get("option.text_size_px").default, "17");
  assert.equal(sections.get("option.text_size_px").min, "10");
  assert.equal(sections.get("option.text_size_px").max, "36");
  assert.equal(sections.get("option.background_opacity").default, "176");
  assert.equal(sections.get("option.background_opacity").min, "0");
  assert.equal(sections.get("option.background_opacity").max, "255");
  assert.equal(sections.get("option.width").default, "360");
  assert.equal(sections.get("option.height").default, "224");
  assert.equal(sections.get("option.height").hidden, "true");
});

test("PID scope package requests one complete Betaflight axis", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/pid_scope.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "pid_scope");
  assert.equal(widget.binary, "/record/GHOST_DP/bin/ghost_dp_widget_pid_scope");
  assert.equal(widget.geometry_lock_aspect, "false");
  assert.equal(sections.get("option.axis").type, "select");
  assert.equal(sections.get("option.axis").default, "ROLL");
  assert.equal(sections.get("option.axis").values, "ROLL,PITCH,YAW");
  assert.equal(sections.get("option.text_size_px").default, "16");
  assert.equal(sections.get("option.text_size_px").min, "10");
  assert.equal(sections.get("option.text_size_px").max, "36");
  assert.equal(sections.get("option.data_hz").default, "40");
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
