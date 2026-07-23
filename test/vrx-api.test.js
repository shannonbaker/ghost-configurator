import assert from "node:assert/strict";
import test from "node:test";

import { VrxApi } from "../vrx-api.js";

test("reads VRX inventory and profile through the loopback bridge", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const value = url.endsWith("/inventory")
      ? { schemaVersion: 1, widgets: [{ id: "ahi" }] }
      : { revision: 7, length: 6, text: "x=true" };
    return { ok: true, status: 200, json: async () => value };
  };
  const api = new VrxApi();
  assert.equal((await api.inventory()).widgets[0].id, "ahi");
  assert.equal((await api.readProfile()).revision, 7);
  assert.match(calls[0].url, /127\.0\.0\.1:48182\/ghost-dp\/inventory$/);
});

test("uploads a newline-terminated VRX profile", async () => {
  let request;
  globalThis.fetch = async (_url, options) => {
    request = options;
    return { ok: true, status: 200,
      json: async () => ({ revision: 8, length: options.body.length }) };
  };
  const result = await new VrxApi().uploadProfile("[ahi.0]\nvisible=true");
  assert.equal(request.method, "PUT");
  assert.ok(request.body.endsWith("\n"));
  assert.equal(result.revision, 8);
});
