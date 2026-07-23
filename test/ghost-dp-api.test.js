import test from "node:test";
import assert from "node:assert/strict";
import { GhostDpApi } from "../ghost-dp-api.js";

const u16 = (value) => [value & 255, value >> 8];
const u32 = (value) => [value & 255, (value >>> 8) & 255,
  (value >>> 16) & 255, value >>> 24];
const responseHeader = (type, session, exchange) =>
  [0x80, 0x10, type, 2, 1, 3, ...u16(session), ...u16(exchange)];

class NativeSession {
  constructor() { this.requests = []; }
  async requestMsp(command, payload) {
    this.requests.push({ command, payload: [...payload] });
    const exchange = payload[8] | (payload[9] << 8);
    if (payload[2] === 1) {
      return Uint8Array.of(...responseHeader(2, 0x1234, exchange), 0,
        ...u32(0xabcdef01), ...new Array(16).fill(0), ...u32(0x11223344),
        ...u32(0x43d), ...u16(192), ...u32(115200), 16, 5);
    }
    if (payload[2] === 3) {
      const name = [...new TextEncoder().encode("PITCH")];
      return Uint8Array.of(...responseHeader(4, 0x1234, exchange), 0,
        ...u32(0x11223344), ...u16(0), 1,
        13 + name.length, ...u16(1), 4, 1, 255, ...u16(12),
        ...u16(100), ...u16(100), 1, name.length, ...name);
    }
    throw new Error("Unexpected request");
  }
}

test("discovers the native GHOST DisplayPort catalogue", async () => {
  const session = new NativeSession();
  const api = new GhostDpApi(session);
  const hello = await api.getCapabilities();
  assert.equal(hello.flags, 0x43d);
  assert.equal(hello.maxStreamBps, 115200);
  assert.deepEqual(await api.getFieldCatalog(), [{
    id: 1, type: 4, unit: 1, scaleExponent: -1, flags: 12,
    maxHz: 100, nativeHz: 100, instanceCount: 1, name: "PITCH",
  }]);
  assert.deepEqual(session.requests.map((request) => request.command), [182, 182]);
  assert.equal(session.requests[0].payload[2], 1);
  assert.equal(session.requests[1].payload[2], 3);
  assert.deepEqual(session.requests[1].payload.slice(6, 8), [0x34, 0x12]);
});
