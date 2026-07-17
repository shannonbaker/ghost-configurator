export const MSP = Object.freeze({
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
});

export function encodeMspV1(command, payload = new Uint8Array()) {
  if (command < 0 || command > 254) {
    throw new RangeError("MSPv1 command must be between 0 and 254");
  }
  if (payload.length > 255) {
    throw new RangeError("MSPv1 payload cannot exceed 255 bytes");
  }

  const frame = new Uint8Array(payload.length + 6);
  frame.set([0x24, 0x4d, 0x3c, payload.length, command], 0); // $M<
  frame.set(payload, 5);
  let checksum = payload.length ^ command;
  for (const byte of payload) checksum ^= byte;
  frame[frame.length - 1] = checksum;
  return frame;
}

export function crc8DvbS2(crc, value) {
  crc ^= value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function encodeMspV2(command, payload = new Uint8Array()) {
  if (command < 0 || command > 0xffff) throw new RangeError("MSPv2 command must fit in 16 bits");
  if (payload.length > 0xffff) throw new RangeError("MSPv2 payload cannot exceed 65535 bytes");
  const frame = new Uint8Array(payload.length + 9);
  frame.set([0x24, 0x58, 0x3c, 0, command & 0xff, command >> 8,
    payload.length & 0xff, payload.length >> 8], 0); // $X<
  frame.set(payload, 8);
  let crc = 0;
  for (let index = 3; index < frame.length - 1; index += 1) crc = crc8DvbS2(crc, frame[index]);
  frame[frame.length - 1] = crc;
  return frame;
}

export class MspParser {
  constructor() {
    this.buffer = new Uint8Array();
  }

  push(chunk) {
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const frames = [];
    while (this.buffer.length >= 6) {
      let start = -1;
      for (let i = 0; i <= this.buffer.length - 3; i += 1) {
        if (this.buffer[i] === 0x24 && (this.buffer[i + 1] === 0x4d || this.buffer[i + 1] === 0x58) &&
            (this.buffer[i + 2] === 0x3e || this.buffer[i + 2] === 0x21)) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 2));
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 6) break;

      if (this.buffer[1] === 0x58) {
        if (this.buffer.length < 9) break;
        const command = this.buffer[4] | (this.buffer[5] << 8);
        const length = this.buffer[6] | (this.buffer[7] << 8);
        const frameLength = length + 9;
        if (this.buffer.length < frameLength) break;
        let crc = 0;
        for (let index = 3; index < frameLength - 1; index += 1) crc = crc8DvbS2(crc, this.buffer[index]);
        if (crc === this.buffer[frameLength - 1]) {
          frames.push({
            version: 2,
            command,
            payload: this.buffer.slice(8, 8 + length),
            error: this.buffer[2] === 0x21,
          });
        }
        this.buffer = this.buffer.slice(frameLength);
        continue;
      }

      const length = this.buffer[3];
      const frameLength = length + 6;
      if (this.buffer.length < frameLength) break;

      const command = this.buffer[4];
      const payload = this.buffer.slice(5, 5 + length);
      let checksum = length ^ command;
      for (const byte of payload) checksum ^= byte;
      const received = this.buffer[frameLength - 1];
      if (checksum === received) {
        frames.push({
          version: 1,
          command,
          payload,
          error: this.buffer[2] === 0x21,
        });
      }
      this.buffer = this.buffer.slice(frameLength);
    }
    return frames;
  }
}

export class MspV1Parser extends MspParser {}

export function parseCapabilities(text) {
  const result = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\d+)\s+([A-Z][A-Z0-9_]*)\s+(\d+)$/);
    if (!match) continue;
    result.push({
      id: Number(match[1]),
      name: match[2],
      maxHz: Number(match[3]),
    });
  }
  return result;
}

export function parseConfiguredFields(text) {
  const result = [];
  const expression = /^ghost_field set (\d+) ([A-Z0-9_]+) (\d+)$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.trim().match(expression);
    if (!match) continue;
    result.push({
      slot: Number(match[1]),
      name: match[2],
      rateHz: Number(match[3]),
    });
  }
  return result;
}

export function decodeAscii(payload) {
  return new TextDecoder().decode(payload).replace(/\0+$/, "");
}
