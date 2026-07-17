import test from "node:test";
import assert from "node:assert/strict";
import { encodeMspV1, MspV1Parser, parseCapabilities, parseConfiguredFields } from "../protocol.js";

test("encodes an MSPv1 request", () => {
  assert.deepEqual([...encodeMspV1(2)], [0x24, 0x4d, 0x3c, 0, 2, 2]);
});

test("parses a fragmented MSPv1 response", () => {
  const payload = Uint8Array.from([0x42, 0x54, 0x46, 0x4c]);
  const response = Uint8Array.from([0x24, 0x4d, 0x3e, 4, 2, ...payload, 4 ^ 2 ^ 0x42 ^ 0x54 ^ 0x46 ^ 0x4c]);
  const parser = new MspV1Parser();
  assert.deepEqual(parser.push(response.slice(0, 4)), []);
  const frames = parser.push(response.slice(4));
  assert.equal(frames[0].command, 2);
  assert.deepEqual([...frames[0].payload], [...payload]);
});

test("parses GHOST CLI capability and configuration output", () => {
  const capabilities = parseCapabilities("ID NAME MAX_HZ\r\n1 PITCH 50\r\n32 RC1 50\r\n# ");
  assert.deepEqual(capabilities, [{ id: 1, name: "PITCH", maxHz: 50 }, { id: 32, name: "RC1", maxHz: 50 }]);
  const configured = parseConfiguredFields("ghost_field set 1 PITCH 20\r\nghost_field set 2 RC1 10\r\n# ");
  assert.deepEqual(configured, [{ slot: 1, name: "PITCH", rateHz: 20 }, { slot: 2, name: "RC1", rateHz: 10 }]);
});
