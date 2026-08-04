import test from "node:test";
import assert from "node:assert/strict";
import { isNumericField, thresholdPresentation, validateColourPolicy } from "../field-colour.js";

test("numeric field types exclude bool and variable data", () => {
  assert.equal(isNumericField({ type: 1 }), true);
  assert.equal(isNumericField({ type: 10 }), true);
  assert.equal(isNumericField({ type: 11 }), false);
  assert.equal(isNumericField({ type: 12 }), false);
});

test("threshold presentation uses widget-facing units", () => {
  assert.deepEqual(thresholdPresentation({ unit: 4, scaleExponent: -3 }),
    { unit: "V", decimals: 3, step: 0.001 });
  assert.deepEqual(thresholdPresentation({ unit: 6, scaleExponent: -3 }),
    { unit: "mAh", decimals: 0, step: 1 });
  assert.deepEqual(thresholdPresentation({ unit: 7, scaleExponent: -6 }),
    { unit: "µs", decimals: 0, step: 1 });
});

test("threshold ordering validates both directions", () => {
  assert.equal(validateColourPolicy({ enabled: true, direction: "low",
    green: 3.7, amber: 3.5, red: 3.3 }).valid, true);
  assert.equal(validateColourPolicy({ enabled: true, direction: "high",
    green: 20, amber: 30, red: 40 }).valid, true);
  assert.equal(validateColourPolicy({ enabled: true, direction: "low",
    green: 3.3, amber: 3.5, red: 3.7 }).valid, false);
});

test("threshold colours are independently optional", () => {
  assert.equal(validateColourPolicy({ enabled: true, direction: "low",
    green: NaN, amber: 3.5, red: 3.3 }).valid, true);
  assert.equal(validateColourPolicy({ enabled: true, direction: "high",
    green: NaN, amber: 60, red: NaN }).valid, true);
  assert.equal(validateColourPolicy({ enabled: true, direction: "low",
    green: NaN, amber: NaN, red: NaN }).valid, false);
  assert.equal(validateColourPolicy({ enabled: true, direction: "low",
    green: NaN, amber: 3.3, red: 3.5 }).valid, false);
});
