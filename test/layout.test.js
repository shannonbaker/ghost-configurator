import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ahiCenterFromPosition, ahiRect, ahiSizeFromPixels, aspectConstrainedSize,
  clampPosition,
  logicalToPhysical,
  outputSize, statusRect, sticksRect,
} from "../layout.js";

test("text widget resize preserves a non-square aspect ratio", () => {
  const size = aspectConstrainedSize(580, 350, 650 / 150,
    320, 100, 1200, 500);
  assert.ok(Math.abs(size.width / size.height - 650 / 150) < 0.000001);
  assert.ok(size.width >= 320 && size.height >= 100);
});

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

test("AHI resize round-trips width and height profile units", () => {
  const original = ahiRect({
    centerX: 5000, centerY: 5000, width: 4000, height: 3000,
  });
  assert.deepEqual(ahiSizeFromPixels(original.width, original.height), {
    width: 4000, height: 3000,
  });
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

test("layout editor exposes built-in resize and anchor controls", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="ahiHeight"/);
  assert.match(html, /class="layout-resize-handle" data-widget="ahi"/);
  assert.match(html, /class="layout-resize-handle" data-widget="sticks"/);
  assert.match(html, /class="layout-anchor-toggle" data-widget="sticks"/);
  assert.match(app, /height=\$\{numberValue\("ahiHeight", 1, 10000\)\}/);
  assert.match(app, /const resizableWidgets = \{/);
  assert.match(app, /sticks:\s*\{\s*lockAspect: true,/);
  assert.match(app, /uniformScale: true/);
  assert.match(app, /elements\.sticksSize\.value = Math\.round\(width \/ 560 \* 100\)/);
  assert.match(app, /size_percent=\$\{numberValue\("sticksSize", 25, 200\)\}/);
  assert.match(app, /elements\.sticksSize\.addEventListener\("change"/);
  assert.equal(app.match(/stale_timeout_ms=2500/g)?.length, 2);
  assert.match(html, /styles\.css\?v=36/);
  assert.match(html, /app\.js\?v=44/);
});

test("completed drag and resize operations automatically persist layout", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /function saveCompletedLayoutChange\(\)/);
  assert.equal(
    app.match(/if \(changed\) saveCompletedLayoutChange\(\);/g)?.length, 2,
  );
  assert.match(app, /setStatus\("Applying widget layout to the flight controller…"\)/);
});

test("resizable widgets support centre-anchored sizing", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /class="layout-anchor-toggle" data-widget="ahi"/);
  assert.match(app, /const anchoredLayoutWidgets = new Set\(\)/);
  assert.match(app, /Math\.abs\(pointer\.x - layoutResize\.centerX\) \* 2/);
  assert.match(app, /layoutResize\.centerX - width \/ 2/);
  assert.match(app, /Math\.abs\(widthScale - 1\) >= Math\.abs\(heightScale - 1\)/);
  assert.match(styles, /\.layout-widget\.anchored \{ cursor:not-allowed; \}/);
});

test("widget settings cards start collapsed and layout selection expands them", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.equal(html.match(/class="widget-card collapsed"/g)?.length, 3);
  assert.equal(html.match(/class="widget-collapse-toggle"/g)?.length, 3);
  assert.match(app, /fieldset\.className = "widget-card collapsed"/);
  assert.match(app, /setWidgetCardExpanded\(widgetCard\(widget\), true\)/);
  assert.match(styles, /\.widget-card\.collapsed \.widget-card-body \{ display:none; \}/);
});
