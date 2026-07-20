const trueValues = new Set(["1", "true", "yes", "on"]);

function isTrue(value) {
  return trueValues.has(String(value).trim().toLowerCase());
}

function matchesDefault(value, option) {
  if (option.default === undefined) return false;
  if (option.type === "boolean") {
    return isTrue(value) === isTrue(option.default);
  }
  if (["integer", "number", "logical_x", "logical_y",
    "logical_width", "logical_height", "logical_size", "field"].includes(option.type)) {
    return Number(value) === Number(option.default);
  }
  return String(value) === String(option.default);
}

export function compactManifestOptions(options, visibleKey, valueFor) {
  const visible = valueFor(visibleKey, options.get(visibleKey));
  if (!isTrue(visible)) return null;

  const values = [[visibleKey, "true"]];
  for (const [key, option] of options) {
    if (key === visibleKey) continue;
    const value = valueFor(key, option);
    if (!matchesDefault(value, option)) values.push([key, value]);
  }
  return values;
}
