const MSP_DISPLAYPORT = 182;
const SUBCOMMAND = 0x80;
const VERSION = 0x10;
const REQUEST = 1 << 0;
const RESPONSE = 1 << 1;
const ENDPOINT_FC = 1;
const ENDPOINT_CONFIGURATOR = 3;
const HELLO_REQUEST = 0x01;
const HELLO_RESPONSE = 0x02;
const CATALOG_REQUEST = 0x03;
const CATALOG_RESPONSE = 0x04;

const readU16 = (data, offset) => data[offset] | (data[offset + 1] << 8);
const readU32 = (data, offset) => (data[offset] | (data[offset + 1] << 8) |
  (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;

export class GhostDpApi {
  constructor(session) {
    this.session = session;
    this.sessionId = 0;
    this.exchangeId = 0;
    this.hello = null;
  }

  nextExchange() {
    this.exchangeId = (this.exchangeId + 1) & 0xffff;
    if (this.exchangeId === 0) this.exchangeId = 1;
    return this.exchangeId;
  }

  makeRequest(messageType, body = new Uint8Array()) {
    const exchangeId = this.nextExchange();
    const data = new Uint8Array(10 + body.length);
    data.set([SUBCOMMAND, VERSION, messageType, REQUEST,
      ENDPOINT_CONFIGURATOR, ENDPOINT_FC,
      this.sessionId & 0xff, this.sessionId >> 8,
      exchangeId & 0xff, exchangeId >> 8]);
    data.set(body, 10);
    return { data, exchangeId };
  }

  async request(messageType, responseType, body = new Uint8Array()) {
    const { data, exchangeId } = this.makeRequest(messageType, body);
    const response = await this.session.requestMsp(MSP_DISPLAYPORT, data, 2000);
    if (response.length < 10 || response[0] !== SUBCOMMAND ||
        (response[1] >> 4) !== (VERSION >> 4) ||
        response[2] !== responseType || !(response[3] & RESPONSE) ||
        response[4] !== ENDPOINT_FC || response[5] !== ENDPOINT_CONFIGURATOR ||
        readU16(response, 8) !== exchangeId) {
      throw new Error("Invalid native GHOST DisplayPort response");
    }
    return response;
  }

  async getCapabilities() {
    const data = await this.request(HELLO_REQUEST, HELLO_RESPONSE);
    if (data.length < 47 || data[10] !== 0) {
      throw new Error(`Native GHOST DisplayPort HELLO failed (${data[10] ?? "truncated"})`);
    }
    this.sessionId = readU16(data, 6);
    if (this.sessionId === 0) throw new Error("Native GHOST DisplayPort returned session zero");
    this.hello = {
      major: data[1] >> 4,
      minor: data[1] & 0x0f,
      bootId: readU32(data, 11),
      catalogHash: readU32(data, 31),
      flags: readU32(data, 35),
      maxPayload: readU16(data, 39),
      maxStreamBps: readU32(data, 41),
      maxSlots: data[45],
      leaseSeconds: data[46],
    };
    return this.hello;
  }

  async getFieldCatalog() {
    if (!this.hello) await this.getCapabilities();
    const records = [];
    let start = 0;
    do {
      const body = Uint8Array.of(start & 0xff, start >> 8, 8);
      const data = await this.request(CATALOG_REQUEST, CATALOG_RESPONSE, body);
      if (data.length < 18 || data[10] !== 0) {
        throw new Error(`Native GHOST field catalogue failed (${data[10] ?? "truncated"})`);
      }
      const hash = readU32(data, 11);
      if (hash !== this.hello.catalogHash) throw new Error("GHOST field catalogue hash changed");
      const next = readU16(data, 15);
      const count = data[17];
      let offset = 18;
      for (let index = 0; index < count; index += 1) {
        if (offset >= data.length) throw new Error("Truncated native GHOST field record");
        const length = data[offset++];
        const end = offset + length;
        if (length < 13 || end > data.length) throw new Error("Invalid native GHOST field record");
        const id = readU16(data, offset); offset += 2;
        const type = data[offset++];
        const unit = data[offset++];
        const scaleExponent = data[offset++] << 24 >> 24;
        const flags = readU16(data, offset); offset += 2;
        const maxHz = readU16(data, offset); offset += 2;
        const nativeHz = readU16(data, offset); offset += 2;
        const instanceCount = data[offset++];
        const nameLength = data[offset++];
        if (offset + nameLength !== end) throw new Error("Invalid native GHOST field name");
        const name = new TextDecoder().decode(data.slice(offset, end));
        records.push({ id, type, unit, scaleExponent, flags, maxHz,
          nativeHz, instanceCount, name });
        offset = end;
      }
      if (offset !== data.length) throw new Error("Trailing native GHOST catalogue data");
      start = next;
    } while (start !== 0);
    return records;
  }
}
