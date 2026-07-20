import assert from "node:assert/strict";
import test from "node:test";

import { compactManifestOptions } from "../profile.js";

const options = new Map([
  ["visible", { type: "boolean", default: "false" }],
  ["position_x", { type: "logical_x", default: "24" }],
  ["refresh_hz", { type: "integer", default: "4" }],
  ["source", { type: "string", default: "/dev/shm/info" }],
]);

test("disabled manifest widgets are omitted from the FC profile", () => {
  const values = new Map([["visible", "false"]]);
  assert.equal(compactManifestOptions(options, "visible", (key) => values.get(key)), null);
});

test("enabled manifest widgets store visibility and non-default values only", () => {
  const values = new Map([
    ["visible", "true"],
    ["position_x", "24"],
    ["refresh_hz", "8"],
    ["source", "/dev/shm/info"],
  ]);
  assert.deepEqual(
    compactManifestOptions(options, "visible", (key) => values.get(key)),
    [["visible", "true"], ["refresh_hz", "8"]],
  );
});
