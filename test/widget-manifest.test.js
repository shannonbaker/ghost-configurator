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
    "./manifests/rotating_logo.widget.ini",
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
