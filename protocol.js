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

export class MspV1Parser {
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
        if (this.buffer[i] === 0x24 && this.buffer[i + 1] === 0x4d &&
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
