import test from "node:test";
import assert from "node:assert/strict";
import { GhostMspApi, crc32 } from "../ghost-api.js";

class MockSession {
  constructor(responses) { this.responses = responses; this.requests = []; }
  async requestMsp(command, payload = new Uint8Array()) {
    this.requests.push({ command, payload: [...payload] });
    const response = this.responses.get(command);
    if (!response) throw new Error(`No response for ${command.toString(16)}`);
    return typeof response === "function" ? response(payload, this.requests) : response;
  }
}

test("discovers capabilities, catalog, and subscriptions", async () => {
  const encoder = new TextEncoder();
  const descriptor = (id, type, unit, maxHz, name) => Uint8Array.of(id, type, unit, maxHz,
    name.length, ...encoder.encode(name));
  const session = new MockSession(new Map([
    [0x4f00, Uint8Array.of(0, 1, 0, 7, 0, 128, 50, 0x34, 0x12)],
    [0x4f01, Uint8Array.of(0, 2, 0, 2, ...descriptor(1, 2, 1, 50, "PITCH"), ...descriptor(2, 2, 1, 50, "ROLL"))],
    [0x4f02, Uint8Array.of(0, 0x34, 0x12, 2, 0xff, 2, 0, 1, 20, 1, 2, 20)],
  ]));
  const api = new GhostMspApi(session);
  assert.equal((await api.getCapabilities()).revision, 0x1234);
  assert.deepEqual((await api.getFieldCatalog()).map((field) => field.name), ["PITCH", "ROLL"]);
  assert.deepEqual((await api.getSubscriptions()).records,
    [{ slot: 0, fieldId: 1, rateHz: 20 }, { slot: 1, fieldId: 2, rateHz: 20 }]);
});

test("uploads an opaque widget profile transactionally", async () => {
  const text = "[ahi.0]\nvisible=true\n";
  const bytes = new TextEncoder().encode(text);
  const checksum = crc32(bytes);
  const responses = new Map([
    [0x4f10, Uint8Array.of(0, 1, 0, 0, 4, 7, 0, 0, 0, 0, 0, 0, 0)],
    [0x4f12, Uint8Array.of(0, 3, 7, 0)],
    [0x4f13, Uint8Array.of(0, bytes.length, 0)],
    [0x4f14, Uint8Array.of(0, 8, 0, bytes.length, 0, checksum & 255,
      (checksum >>> 8) & 255, (checksum >>> 16) & 255, checksum >>> 24)],
  ]);
  const session = new MockSession(responses);
  const result = await new GhostMspApi(session).uploadProfile(text);
  assert.deepEqual(result, { revision: 8, length: bytes.length, crc32: checksum });
  assert.deepEqual(session.requests.map((request) => request.command), [0x4f10, 0x4f12, 0x4f13, 0x4f14]);
  assert.equal(session.requests[2].payload[0], 3);
  assert.deepEqual(session.requests[2].payload.slice(3), [...bytes]);
});

test("CRC32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("performs clear, staged writes, validation, commit, and readback", async () => {
  const responses = new Map([
    [0x4f00, Uint8Array.of(0, 1, 0, 7, 0, 128, 50, 0x34, 0x12)],
    [0x4f03, Uint8Array.of(0, 9, 0x34, 0x12)],
    [0x4f05, Uint8Array.of(0)],
    [0x4f04, Uint8Array.of(0)],
    [0x4f06, Uint8Array.of(0)],
    [0x4f07, Uint8Array.of(0, 0x35, 0x12)],
    [0x4f02, Uint8Array.of(0, 0x35, 0x12, 1, 0xff, 1, 0, 1, 20)],
  ]);
  const session = new MockSession(responses);
  const api = new GhostMspApi(session);
  await api.getCapabilities();
  const result = await api.replaceSubscriptions([{ slot: 0, id: 1, rateHz: 20 }]);
  assert.equal(result.revision, 0x1235);
  assert.deepEqual(session.requests.map((request) => request.command),
    [0x4f00, 0x4f03, 0x4f05, 0x4f04, 0x4f06, 0x4f07, 0x4f02]);
});
