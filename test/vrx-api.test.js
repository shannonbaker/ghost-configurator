import assert from "node:assert/strict";
import test from "node:test";

import { FcRoutedVrxApi, VrxApi } from "../vrx-api.js";

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

test("reads chunked VRX inventory through the FC relay", async () => {
  const inventory = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, widgets: [{ id: "ahi" }],
  }));
  let pendingExchange = 0;
  const session = {
    async requestMsp(_command, payload) {
      const type = payload[2];
      if (type === 0x30) {
        pendingExchange = payload[8] | (payload[9] << 8);
        return Uint8Array.of(pendingExchange & 0xff, pendingExchange >> 8);
      }
      const response = new Uint8Array(19 + inventory.length);
      response.set([0x80, 0x10, 0x31, 0x02, 0x02, 0x03, 0, 0,
        pendingExchange & 0xff, pendingExchange >> 8, 0, 1, 0,
        inventory.length, 0, 0, 0, inventory.length, 0]);
      response.set(inventory, 19);
      return response;
    },
  };
  const result = await new FcRoutedVrxApi(session).inventory();
  assert.equal(result.widgets[0].id, "ahi");
});
