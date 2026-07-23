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

export function parseManifestDependencies(sections, options) {
  const dependencies = [];
  for (const [section, values] of sections) {
    const match = /^dependency\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(section);
    if (!match) continue;
    const [, selector, selectedValue] = match;
    const selectorOption = options.get(selector);
    const fields = String(values.fields ?? "").split(",")
      .map((field) => field.trim()).filter(Boolean);
    const rateOption = values.rate_option;
    if (!selectorOption || selectorOption.type !== "select" || !fields.length ||
        fields.some((field) => !/^(?:[1-9][0-9]{0,4}|[A-Z][A-Z0-9_]{0,31})$/.test(field)) ||
        (rateOption && !options.has(rateOption))) {
      throw new Error(`Invalid widget dependency: ${section}`);
    }
    dependencies.push({ selector, selectedValue, fields, rateOption });
  }
  return dependencies;
}

export function resolveManifestDependencies(dependencies, valueFor, capabilities) {
  const resolved = [];
  for (const dependency of dependencies) {
    if (String(valueFor(dependency.selector)).toUpperCase() !==
        dependency.selectedValue.toUpperCase()) continue;
    const rateHz = dependency.rateOption
      ? Number(valueFor(dependency.rateOption)) : undefined;
    for (const field of dependency.fields) {
      const numericId = Number(field);
      const capability = Number.isInteger(numericId)
        ? capabilities.find((candidate) => candidate.id === numericId)
        : capabilities.find((candidate) =>
          candidate.name.toUpperCase() === field.toUpperCase());
      resolved.push({
        name: capability?.name.toUpperCase() ?? field.toUpperCase(),
        rateHz: Number.isFinite(rateHz) && rateHz > 0 ? rateHz : undefined,
      });
    }
  }
  return resolved;
}
