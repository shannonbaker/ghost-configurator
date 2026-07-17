import test from "node:test";
import assert from "node:assert/strict";
import { crc8DvbS2, encodeMspV1, encodeMspV2, MspV1Parser, MspParser, parseCapabilities, parseConfiguredFields } from "../protocol.js";

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

test("encodes and parses a fragmented native MSPv2 frame", () => {
  const request = encodeMspV2(0x4f00, Uint8Array.of(1, 2));
  assert.deepEqual([...request.slice(0, 8)], [0x24, 0x58, 0x3c, 0, 0, 0x4f, 2, 0]);

  const response = Uint8Array.from([0x24, 0x58, 0x3e, 0, 0, 0x4f, 2, 0, 7, 8, 0]);
  let crc = 0;
  for (let index = 3; index < response.length - 1; index += 1) crc = crc8DvbS2(crc, response[index]);
  response[response.length - 1] = crc;
  const parser = new MspParser();
  assert.deepEqual(parser.push(response.slice(0, 7)), []);
  const frames = parser.push(response.slice(7));
  assert.equal(frames[0].version, 2);
  assert.equal(frames[0].command, 0x4f00);
  assert.deepEqual([...frames[0].payload], [7, 8]);
});

test("parses GHOST CLI capability and configuration output", () => {
  const capabilities = parseCapabilities("ID NAME MAX_HZ\r\n1 PITCH 50\r\n32 RC1 50\r\n# ");
  assert.deepEqual(capabilities, [{ id: 1, name: "PITCH", maxHz: 50 }, { id: 32, name: "RC1", maxHz: 50 }]);
  const configured = parseConfiguredFields("ghost_field set 1 PITCH 20\r\nghost_field set 2 RC1 10\r\n# ");
  assert.deepEqual(configured, [{ slot: 1, name: "PITCH", rateHz: 20 }, { slot: 2, name: "RC1", rateHz: 10 }]);
});
