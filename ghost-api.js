const COMMAND = Object.freeze({
  CAPABILITIES: 0x4f00,
  FIELD_CATALOG: 0x4f01,
  SUBSCRIPTIONS: 0x4f02,
  CONFIG_BEGIN: 0x4f03,
  CONFIG_SET: 0x4f04,
  CONFIG_CLEAR: 0x4f05,
  CONFIG_VALIDATE: 0x4f06,
  CONFIG_COMMIT: 0x4f07,
  CONFIG_ABORT: 0x4f08,
  PROFILE_INFO: 0x4f10,
  PROFILE_READ: 0x4f11,
  PROFILE_BEGIN: 0x4f12,
  PROFILE_CHUNK: 0x4f13,
  PROFILE_COMMIT: 0x4f14,
  PROFILE_ABORT: 0x4f15,
  STREAM_STATS: 0x4f20,
});

const STATUS = ["OK", "Bad request length", "FC is armed", "Invalid transaction",
  "Invalid slot", "Unsupported field", "Invalid rate", "Stale configuration revision",
  "Invalid staged configuration", "Widget profile is too large", "Invalid profile offset",
  "Widget profile CRC mismatch"];

const readU16 = (data, offset) => data[offset] | (data[offset + 1] << 8);
const u16 = (value) => Uint8Array.of(value & 0xff, value >> 8);
const readU32 = (data, offset) => (data[offset] | (data[offset + 1] << 8) |
  (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
const u32 = (value) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff,
  (value >>> 16) & 0xff, value >>> 24);

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function check(response, minimumLength = 1) {
  if (response.length < minimumLength) throw new Error("Truncated GHOST MSPv2 response");
  if (response[0] !== 0) throw new Error(STATUS[response[0]] ?? `GHOST error ${response[0]}`);
  return response;
}

export class GhostMspApi {
  constructor(session) {
    this.session = session;
    this.capabilities = null;
  }

  async getCapabilities() {
    const data = check(await this.session.requestMsp(COMMAND.CAPABILITIES), 9);
    const result = {
      major: data[1], minor: data[2], flags: readU16(data, 3), maxSlots: data[5],
      maxHz: data[6], revision: readU16(data, 7),
    };
    if (result.major !== 1) throw new Error(`Unsupported GHOST MSPv2 major version ${result.major}`);
    this.capabilities = result;
    return result;
  }

  async getFieldCatalog() {
    const records = [];
    let start = 1;
    do {
      const data = check(await this.session.requestMsp(COMMAND.FIELD_CATALOG, Uint8Array.of(start, 16)), 4);
      const next = data[2];
      const count = data[3];
      let offset = 4;
      for (let index = 0; index < count; index += 1) {
        if (offset + 5 > data.length) throw new Error("Truncated GHOST field descriptor");
        const id = data[offset++];
        const type = data[offset++];
        const unit = data[offset++];
        const maxHz = data[offset++];
        const nameLength = data[offset++];
        if (offset + nameLength > data.length) throw new Error("Truncated GHOST field name");
        const name = new TextDecoder().decode(data.slice(offset, offset + nameLength));
        offset += nameLength;
        records.push({ id, type, unit, maxHz, name });
      }
      start = next;
    } while (start !== 0);
    return records;
  }

  async getSubscriptions() {
    const records = [];
    let start = 0;
    let revision = this.capabilities?.revision ?? 0;
    do {
      const data = check(await this.session.requestMsp(COMMAND.SUBSCRIPTIONS, Uint8Array.of(start, 64)), 6);
      revision = readU16(data, 1);
      const next = data[4];
      const count = data[5];
      let offset = 6;
      for (let index = 0; index < count; index += 1) {
        if (offset + 3 > data.length) throw new Error("Truncated GHOST subscription");
        records.push({ slot: data[offset++], fieldId: data[offset++], rateHz: data[offset++] });
      }
      start = next;
    } while (start !== 0xff);
    if (this.capabilities) this.capabilities.revision = revision;
    return { revision, records };
  }

  async replaceSubscriptions(fields) {
    if (!this.capabilities) await this.getCapabilities();
    const begin = check(await this.session.requestMsp(COMMAND.CONFIG_BEGIN, u16(this.capabilities.revision)), 4);
    const transactionId = begin[1];
    try {
      check(await this.session.requestMsp(COMMAND.CONFIG_CLEAR, Uint8Array.of(transactionId, 0xff)));
      for (const field of fields) {
        check(await this.session.requestMsp(COMMAND.CONFIG_SET,
          Uint8Array.of(transactionId, field.slot, field.id, field.rateHz)));
      }
      check(await this.session.requestMsp(COMMAND.CONFIG_VALIDATE, Uint8Array.of(transactionId)));
      const committed = check(await this.session.requestMsp(COMMAND.CONFIG_COMMIT,
        Uint8Array.of(transactionId, 1), 5000), 3);
      this.capabilities.revision = readU16(committed, 1);
      return this.getSubscriptions();
    } catch (error) {
      await this.session.requestMsp(COMMAND.CONFIG_ABORT, Uint8Array.of(transactionId)).catch(() => {});
      throw error;
    }
  }

  async getProfileInfo() {
    const data = check(await this.session.requestMsp(COMMAND.PROFILE_INFO), 13);
    return { formatMajor: data[1], formatMinor: data[2], maxLength: readU16(data, 3),
      revision: readU16(data, 5), length: readU16(data, 7), crc32: readU32(data, 9) };
  }

  async readProfile() {
    const info = await this.getProfileInfo();
    const profile = new Uint8Array(info.length);
    let offset = 0;
    while (offset < info.length) {
      const request = new Uint8Array([...u16(offset), Math.min(128, info.length - offset)]);
      const data = check(await this.session.requestMsp(COMMAND.PROFILE_READ, request), 12);
      const returnedOffset = readU16(data, 9);
      const length = data[11];
      if (returnedOffset !== offset || data.length !== 12 + length || length === 0) {
        throw new Error("Invalid widget profile read response");
      }
      profile.set(data.slice(12), offset);
      offset += length;
    }
    if (crc32(profile) !== info.crc32) throw new Error("FC widget profile failed CRC verification");
    return { ...info, text: new TextDecoder().decode(profile) };
  }

  async uploadProfile(text) {
    const bytes = new TextEncoder().encode(text);
    const info = await this.getProfileInfo();
    if (bytes.length === 0 || bytes.length > info.maxLength) {
      throw new Error(`Widget profile is ${bytes.length} bytes; FC limit is ${info.maxLength}`);
    }
    let revision = (info.revision + 1) & 0xffff;
    if (revision === 0) revision = 1;
    const checksum = crc32(bytes);
    const beginPayload = new Uint8Array([
      ...u16(info.revision), ...u16(revision), ...u16(bytes.length), ...u32(checksum),
    ]);
    const begin = check(await this.session.requestMsp(COMMAND.PROFILE_BEGIN, beginPayload), 4);
    const transactionId = begin[1];
    try {
      for (let offset = 0; offset < bytes.length; offset += 128) {
        const chunk = bytes.slice(offset, offset + 128);
        const payload = new Uint8Array(3 + chunk.length);
        payload[0] = transactionId;
        payload.set(u16(offset), 1);
        payload.set(chunk, 3);
        check(await this.session.requestMsp(COMMAND.PROFILE_CHUNK, payload), 3);
      }
      const committed = check(await this.session.requestMsp(COMMAND.PROFILE_COMMIT,
        Uint8Array.of(transactionId, 1), 5000), 9);
      return { revision: readU16(committed, 1), length: readU16(committed, 3),
        crc32: readU32(committed, 5) };
    } catch (error) {
      await this.session.requestMsp(COMMAND.PROFILE_ABORT, Uint8Array.of(transactionId)).catch(() => {});
      throw error;
    }
  }

  async getStreamStats() {
    const data = check(await this.session.requestMsp(COMMAND.STREAM_STATS), 21);
    return {
      sampleTimeMs: readU32(data, 1),
      wireBytes: readU32(data, 5),
      frames: readU32(data, 9),
      ghostFieldWireBytes: readU32(data, 13),
      ghostProfileWireBytes: readU32(data, 17),
    };
  }
}
