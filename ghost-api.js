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
});

const STATUS = ["OK", "Bad request length", "FC is armed", "Invalid transaction",
  "Invalid slot", "Unsupported field", "Invalid rate", "Stale configuration revision",
  "Invalid staged configuration"];

const readU16 = (data, offset) => data[offset] | (data[offset + 1] << 8);
const u16 = (value) => Uint8Array.of(value & 0xff, value >> 8);

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
}
