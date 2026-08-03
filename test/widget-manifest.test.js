import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  parseManifestDependencies, resolveManifestDependencies,
} from "../profile.js";

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

test("VRX widget IDs resolve directly to matching schemas", async () => {
  for (const id of ["ahi", "sticks", "rc_menu", "mini_map",
    "ghost_dp_stats", "msp_dp_osd"]) {
    const sections = parseIni(await readFile(
      new URL(`../widgets/manifests/${id}.widget.ini`, import.meta.url), "utf8",
    ));
    assert.equal(sections.get("widget").id, id);
  }
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

test("GHOST data statistics uses automatic content geometry", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/ghost_dp_stats.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "ghost_dp_stats");
  assert.equal(widget.geometry_width, undefined);
  assert.equal(widget.geometry_height, undefined);
  assert.equal(sections.has("option.width"), false);
  assert.equal(sections.has("option.height"), false);
});

test("VRX status bar package uses independent width and height", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/vrx_status_bar.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "vrx_status_bar");
  assert.equal(widget.geometry_lock_aspect, "false");
  assert.equal(sections.get("option.width").default, "1000");
  assert.equal(sections.get("option.height").default, "70");
  for (const option of [
    "show_vtx_voltage", "show_vrx_voltage",
    "show_vtx_temperature", "show_vrx_temperature",
    "show_bitrate", "show_latency", "show_distance", "show_signal",
  ]) {
    assert.equal(sections.get("option." + option).default, "true");
    assert.equal(sections.get("option." + option).type, "boolean");
  }
  assert.equal(sections.get("option.elements_configured").hidden, "true");
  assert.equal(sections.get("option.text_px").default, "20");
  assert.equal(sections.get("option.text_px").min, "10");
  assert.equal(sections.get("option.text_px").max, "40");
  assert.equal(sections.get("option.text_px").arg, "--text-px");
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
  assert.equal(sections.get("option.background_opacity").default, "69");
  assert.equal(sections.get("option.background_opacity").min, "0");
  assert.equal(sections.get("option.background_opacity").max, "100");
  assert.equal(sections.get("option.background_opacity").unit, "%");
  assert.equal(sections.get("option.background_opacity").transform, "percent_to_alpha");
  assert.equal(sections.get("option.width").default, "360");
  assert.equal(sections.get("option.height").default, "224");
  assert.equal(sections.get("option.height").hidden, "true");
});

test("VTX temperature package exposes compact scalable geometry", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/vtx_temperature.widget.ini", import.meta.url),
    "utf8",
  ));
  const widget = sections.get("widget");
  assert.equal(widget.id, "vtx_temperature");
  assert.equal(widget.binary,
    "/record/GHOST_DP/bin/ghost_dp_widget_vtx_temperature");
  assert.equal(widget.field_shm, "false");
  assert.equal(widget.display_scale, "true");
  assert.equal(widget.geometry_lock_aspect, "false");
  assert.equal(sections.get("option.background_opacity").min, "0");
  assert.equal(sections.get("option.background_opacity").max, "100");
  assert.equal(sections.get("option.background_opacity").transform,
    "percent_to_alpha");
  assert.equal(sections.get("option.refresh_hz").default, "4");
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
  assert.equal(sections.get("dependency.axis.ROLL").fields,
    "19,16,32768,32769,32770,32771,32772");
  assert.equal(sections.get("dependency.axis.PITCH").fields,
    "20,17,32784,32785,32786,32787,32788");
  assert.equal(sections.get("dependency.axis.YAW").fields,
    "21,18,32800,32801,32802,32803,32804");
  const options = new Map([...sections]
    .filter(([section]) => section.startsWith("option."))
    .map(([section, values]) => [section.slice(7), values]));
  const dependencies = parseManifestDependencies(sections, options);
  const values = new Map([["axis", "PITCH"], ["data_hz", "30"]]);
  const capabilities = [
    { id: 20, name: "RATE_SETPOINT_PITCH" },
    { id: 17, name: "ANGULAR_RATE_PITCH" },
    { id: 32784, name: "BF_PID_P_PITCH" },
    { id: 32785, name: "BF_PID_I_PITCH" },
    { id: 32786, name: "BF_PID_D_PITCH" },
    { id: 32787, name: "BF_PID_F_PITCH" },
    { id: 32788, name: "BF_PID_SUM_PITCH" },
  ];
  assert.deepEqual(resolveManifestDependencies(
    dependencies, (key) => values.get(key), capabilities,
  ), capabilities.map((field) => ({ name: field.name, rateHz: 30 })));
});

test("widget binary is constrained to the managed Goggles X directory", async () => {
  const sections = parseIni(await readFile(
    new URL("../widgets/manifests/rotating_logo.widget.ini", import.meta.url),
    "utf8",
  ));
  assert.match(
    sections.get("widget").binary,
    /^\/record\/GHOST_DP\/bin\/ghost_widget_[A-Za-z0-9_-]+$/,
  );
});

test("every user-facing option declares its RC stick-menu policy", async () => {
  const directory = new URL("../widgets/manifests/", import.meta.url);
  const manifests = (await readdir(directory))
    .filter((name) => name.endsWith(".widget.ini"));
  const policies = new Set(["default", "optional", "never"]);
  for (const path of manifests) {
    const sections = parseIni(await readFile(
      new URL(path, directory), "utf8",
    ));
    for (const [section, option] of sections) {
      if (!section.startsWith("option.")) continue;
      assert.ok(policies.has(option.stick_menu),
        path + ": " + section + " has no valid stick_menu policy");
      if (option.role === "visible" || option.type === "field" ||
          option.type === "string") {
        assert.equal(option.stick_menu, "never",
          path + ": technical options must remain configurator-only");
      }
    }
  }
});

test("built-in widget manifests bind stick-menu choices to existing controls", async () => {
  for (const name of ["ahi", "sticks", "status"]) {
    const sections = parseIni(await readFile(
      new URL("../widgets/manifests/" + name + ".widget.ini", import.meta.url),
      "utf8",
    ));
    assert.equal(sections.get("widget").builtin, "true");
    const configurable = [...sections]
      .filter(([section, option]) => section.startsWith("option.") &&
        option.role !== "visible" && option.stick_menu !== "never");
    assert.ok(configurable.length > 0);
    for (const [section, option] of configurable) {
      assert.ok(option.control, name + ": " + section + " has no control binding");
    }
  }
});

test("built-in sticks and status expose logical stick-menu positioning", async () => {
  for (const name of ["sticks.widget.ini", "status.widget.ini"]) {
    const sections = parseIni(await readFile(
      new URL("../widgets/manifests/" + name, import.meta.url), "utf8",
    ));
    const widget = sections.get("widget");
    assert.equal(widget.geometry_owner, "manager");
    assert.equal(widget.geometry_x, "position_x");
    assert.equal(widget.geometry_y, "position_y");
    if (name === "sticks.widget.ini") {
      assert.equal(widget.placement_base_width, "512");
      assert.equal(widget.placement_base_height, "220");
      assert.equal(widget.placement_scale, "size_percent");
    }
  }
});
