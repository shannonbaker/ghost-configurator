import assert from "node:assert/strict";
import test from "node:test";

import { decodeMavlinkHeartbeat, MavlinkParser } from "../serial.js";

function heartbeatV1({ autopilot = 3, vehicleType = 2 } = {}) {
  const payload = Uint8Array.of(0, 0, 0, 0, vehicleType, autopilot, 0x51, 4, 3);
  return Uint8Array.of(0xfe, payload.length, 7, 1, 1, 0, ...payload, 0, 0);
}

function heartbeatV2({ autopilot = 3, vehicleType = 1 } = {}) {
  const payload = Uint8Array.of(0, 0, 0, 0, vehicleType, autopilot, 0x51, 4, 3);
  return Uint8Array.of(0xfd, payload.length, 0, 0, 8, 2, 1, 0, 0, 0,
    ...payload, 0, 0);
}

test("recognises a fragmented ArduPilot MAVLink 1 heartbeat", () => {
  const parser = new MavlinkParser();
  const frame = heartbeatV1();
  assert.deepEqual(parser.push(frame.slice(0, 5)), []);
  const messages = parser.push(frame.slice(5));
  assert.equal(messages.length, 1);
  assert.deepEqual(decodeMavlinkHeartbeat(messages[0]), {
    ...messages[0], vehicleType: 2, autopilot: 3, baseMode: 0x51,
    systemStatus: 4, isArduPilot: true,
  });
});

test("recognises MAVLink 2 and distinguishes a non-ArduPilot heartbeat", () => {
  const [message] = new MavlinkParser().push(heartbeatV2({ autopilot: 12 }));
  const heartbeat = decodeMavlinkHeartbeat(message);
  assert.equal(heartbeat.version, 2);
  assert.equal(heartbeat.vehicleType, 1);
  assert.equal(heartbeat.isArduPilot, false);
});

test("ignores non-heartbeat MAVLink messages", () => {
  const frame = heartbeatV1();
  frame[5] = 30;
  const [message] = new MavlinkParser().push(frame);
  assert.equal(decodeMavlinkHeartbeat(message), null);
});
