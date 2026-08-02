import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("AHI exposes and serializes line thickness", async () => {
  const [html, app, profile] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("app.js", root), "utf8"),
    readFile(new URL("widgets/default.ini", root), "utf8"),
  ]);
  assert.match(html, /id="ahiLineWidth"[^>]*min="1"[^>]*max="12"/);
  assert.match(html, /id="ahiTestMode"[^>]*type="checkbox"/);
  assert.match(html, /id="ahiPrediction"[^>]*type="checkbox"[^>]*checked/);
  assert.match(app, /setValue\("ahiLineWidth", ahi\.line_width \?\? "3"\)/);
  assert.match(app, /elements\.ahiTestMode\.checked = truthy\(ahi\.test_mode\)/);
  assert.match(app, /line_width=\$\{numberValue\("ahiLineWidth", 1, 12\)\}/);
  assert.match(app, /test_mode=\$\{elements\.ahiTestMode\.checked\}/);
  assert.match(app, /prediction=\$\{elements\.ahiPrediction\.checked\}/);
  assert.match(profile, /^vertical_range_degrees=90$/m);
  assert.match(profile, /^line_width=3$/m);
  assert.match(profile, /^test_mode=false$/m);
  assert.match(profile, /^prediction=true$/m);
  assert.doesNotMatch(profile, /^pitch_scale=/m);
});
