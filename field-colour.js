const UNIT_NAMES = new Map([
  [0, "raw"], [1, "°"], [2, "m"], [3, "m/s"], [4, "V"],
  [5, "A"], [6, "mAh"], [7, "s"], [8, "%"], [9, "Hz"],
  [10, "count"], [11, "°/s"], [12, "Wh"],
]);

export function isNumericField(field) {
  return Number.isInteger(field?.type) && field.type >= 1 && field.type <= 10;
}

export function thresholdPresentation(field) {
  const exponent = Number.isInteger(field?.scaleExponent) ? field.scaleExponent : 0;
  if (field?.unit === 6) {
    return { unit: "mAh", decimals: Math.max(0, -(exponent + 3)),
      step: 10 ** (exponent + 3) };
  }
  if (field?.unit === 7 && exponent === -6) {
    return { unit: "µs", decimals: 0, step: 1 };
  }
  return {
    unit: UNIT_NAMES.get(field?.unit) ?? "raw",
    decimals: Math.max(0, -exponent),
    step: 10 ** exponent,
  };
}

export function validateColourPolicy(policy) {
  if (!policy?.enabled) return { valid: true, message: "" };
  const greenSet = Number.isFinite(policy.green);
  const amberSet = Number.isFinite(policy.amber);
  const redSet = Number.isFinite(policy.red);
  if (!greenSet && !amberSet && !redSet)
    return { valid: false, message: "Enter at least one threshold." };
  if (policy.direction === "low") {
    const ordered = (!greenSet || !amberSet || policy.green > policy.amber) &&
      (!amberSet || !redSet || policy.amber > policy.red) &&
      (!greenSet || !redSet || policy.green > policy.red);
    return ordered
      ? { valid: true, message: "" }
      : { valid: false, message: "Low-is-bad thresholds must descend Green > Amber > Red." };
  }
  if (policy.direction === "high") {
    const ordered = (!greenSet || !amberSet || policy.green < policy.amber) &&
      (!amberSet || !redSet || policy.amber < policy.red) &&
      (!greenSet || !redSet || policy.green < policy.red);
    return ordered
      ? { valid: true, message: "" }
      : { valid: false, message: "High-is-bad thresholds must ascend Green < Amber < Red." };
  }
  return { valid: false, message: "Choose a threshold direction." };
}