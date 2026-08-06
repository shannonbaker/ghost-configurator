import test from "node:test";
import assert from "node:assert/strict";
import { validateMission } from "../mission-editor.js";

test("validates mission coordinate ranges and maximum item count", () => {
  const valid = [{ latitude: -37.8, longitude: 144.8, altitude: 30 }];
  assert.deepEqual(validateMission(valid, 30), []);
  assert.equal(validateMission([{ ...valid[0], latitude: 91 }], 30).length, 1);
  assert.equal(validateMission([{ ...valid[0], longitude: -181 }], 30).length, 1);
  assert.equal(validateMission([valid[0], valid[0]], 1)[0],
    "Plan has 2 items; FC maximum is 1.");
});
