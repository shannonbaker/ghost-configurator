import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ahiCenterFromPosition, ahiRect, clampPosition, logicalToPhysical,
  outputSize, statusRect, sticksRect,
} from "../layout.js";

test("maps the 1080p logical workspace to 720p", () => {
  const output = outputSize("1280x720");
  assert.deepEqual(output, { width: 1280, height: 720 });
  assert.equal(logicalToPhysical(1340, output.width, 1920), 893);
  assert.equal(logicalToPhysical(700, output.height, 1080), 467);
});

test("AHI drag round-trips through centre coordinates", () => {
  const original = ahiRect({ centerX: 5000, centerY: 5000, width: 1500 });
  const center = ahiCenterFromPosition(
    original.x, original.y, original.width, original.height,
  );
  assert.deepEqual(center, { centerX: 5000, centerY: 5000 });
});

test("widget geometry and boundary clamping use logical pixels", () => {
  assert.deepEqual(sticksRect({ x: 1340, y: 700, sizePercent: 100 }), {
    x: 1340, y: 700, width: 560, height: 300,
  });
  assert.deepEqual(clampPosition(1800, 1000, 560, 300), { x: 1360, y: 780 });
  assert.deepEqual(statusRect({
    x: 16, y: 12, sizePercent: 100,
    showVtxTemperature: true, showVrxTemperature: true,
    showVtxVoltage: true, showVrxVoltage: true,
  }), { x: 16, y: 12, width: 260, height: 80 });
});

test("default profile declares its logical reference resolution", async () => {
  const profile = await readFile(
    new URL("../widgets/default.ini", import.meta.url), "utf8",
  );
  assert.match(profile, /\[display\]\s+reference_width=1920\s+reference_height=1080/);
});
