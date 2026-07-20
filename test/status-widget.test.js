import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("default profile defines all local system-status metrics", async () => {
  const profile = await readFile(
    new URL("../widgets/default.ini", import.meta.url), "utf8",
  );
  assert.match(profile, /\[status\.0\]/);
  assert.match(profile, /show_vtx_temperature=true/);
  assert.match(profile, /show_goggles_temperature=true/);
  assert.match(profile, /show_vtx_voltage=true/);
  assert.match(profile, /show_goggles_voltage=true/);
});

test("status controls referenced by app.js exist in index.html", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);
  for (const id of [
    "statusVisible", "statusVtxTemperature", "statusGogglesTemperature",
    "statusVtxVoltage", "statusGogglesVoltage", "statusX", "statusY",
    "statusSize", "statusFps", "statusOpacity", "statusStale",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(app, new RegExp(`(?:elements\\.|")${id}`));
  }
  assert.match(html, /> VRX temperature</);
  assert.match(html, /> VRX voltage</);
  assert.doesNotMatch(html, /> Goggles (?:temperature|voltage)</);
});
