import { crc32 } from "./ghost-api.js";

const MSP_DISPLAYPORT = 182;
const HEADER_SIZE = 10;
const SUBCOMMAND = 0x80;
const VERSION = 0x10;
const REQUEST = 1;
const RESPONSE = 2;
const ENDPOINT_FC = 1;
const ENDPOINT_VRX = 2;
const ENDPOINT_CONFIGURATOR = 3;
const INVENTORY_GET = 0x30;
const INVENTORY_RESULT = 0x31;
const PROFILE_GET = 0x32;
const PROFILE_RESULT = 0x33;
const PROFILE_BEGIN = 0x34;
const PROFILE_BEGIN_RESULT = 0x35;
const PROFILE_CHUNK = 0x36;
const PROFILE_CHUNK_RESULT = 0x37;
const PROFILE_COMMIT = 0x38;
const PROFILE_COMMIT_RESULT = 0x39;
const PROFILE_ABORT = 0x3a;
const PROFILE_ABORT_RESULT = 0x3b;
const RELAY_POLL = 0x40;
const RELAY_POLL_RESULT = 0x41;
const readU16 = (data, offset) => data[offset] | (data[offset + 1] << 8);
const readU32 = (data, offset) => (data[offset] | (data[offset + 1] << 8) |
  (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
const u16 = (value) => Uint8Array.of(value & 0xff, value >> 8);
const u32 = (value) => Uint8Array.of(value & 0xff, value >>> 8,
  value >>> 16, value >>> 24);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class VrxApi {
  constructor(baseUrl = globalThis.location?.hostname === "localhost" &&
      globalThis.location?.port === "8000"
    ? `${globalThis.location.origin}/ghost-dp`
    : "http://127.0.0.1:48182/ghost-dp") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      cache: "no-store",
      targetAddressSpace: "local",
      ...options,
    });
    let value;
    try { value = await response.json(); }
    catch (_) { throw new Error(`VRX bridge returned HTTP ${response.status}`); }
    if (!response.ok) throw new Error(value.error ?? `VRX bridge returned HTTP ${response.status}`);
    return value;
  }

  status() { return this.request("/status"); }
  inventory() { return this.request("/inventory"); }
  readProfile() { return this.request("/profile"); }
  uploadProfile(text) {
    return this.request("/profile", {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text.endsWith("\n") ? text : `${text}\n`,
    });
  }

  async requestMsp(command, payload) {
    if (command !== MSP_DISPLAYPORT) throw new Error("VRX bridge only relays MSP DisplayPort");
    let binary = "";
    for (const value of payload) binary += String.fromCharCode(value);
    const result = await this.request("/fc/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: btoa(binary) }),
    });
    const decoded = atob(result.payload ?? "");
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
}

export class FcRoutedVrxApi {
  constructor(session) {
    this.session = session;
    this.exchangeId = 0;
    this.lastTransactionAt = 0;
    this.minimumTransactionIntervalMs = 100;
  }

  nextExchange() {
    this.exchangeId = (this.exchangeId + 1) & 0xffff;
    if (!this.exchangeId) this.exchangeId = 1;
    return this.exchangeId;
  }

  envelope(type, destination, exchangeId, body = new Uint8Array()) {
    const output = new Uint8Array(HEADER_SIZE + body.length);
    output.set([SUBCOMMAND, VERSION, type, REQUEST, ENDPOINT_CONFIGURATOR,
      destination, 0, 0, exchangeId & 0xff, exchangeId >> 8]);
    output.set(body, HEADER_SIZE);
    return output;
  }

  validate(response, type, exchangeId) {
    if (response.length < HEADER_SIZE || response[0] !== SUBCOMMAND ||
        response[1] !== VERSION || response[2] !== type ||
        !(response[3] & RESPONSE) || response[4] !== ENDPOINT_VRX ||
        response[5] !== ENDPOINT_CONFIGURATOR || readU16(response, 8) !== exchangeId) {
      throw new Error("Invalid FC-routed VRX response");
    }
    const body = response.slice(HEADER_SIZE);
    if (!body.length || body[0] !== 0) throw new Error(`VRX rejected request (${body[0] ?? "truncated"})`);
    return body;
  }

  async transact(requestType, responseType, body = new Uint8Array(), timeoutMs = 3000) {
    const spacing = this.minimumTransactionIntervalMs -
      (performance.now() - this.lastTransactionAt);
    if (spacing > 0) await delay(spacing);
    const exchangeId = this.nextExchange();
    const accepted = await this.session.requestMsp(MSP_DISPLAYPORT,
      this.envelope(requestType, ENDPOINT_VRX, exchangeId, body), 1500);
    if (accepted.length !== 2 || readU16(accepted, 0) !== exchangeId) {
      throw new Error("FC does not support VRX relay transport");
    }
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      await delay(40);
      const pollId = this.nextExchange();
      const response = await this.session.requestMsp(MSP_DISPLAYPORT,
        this.envelope(RELAY_POLL, ENDPOINT_FC, pollId, u16(exchangeId)), 1200);
      if (response.length >= HEADER_SIZE && response[2] === RELAY_POLL_RESULT) continue;
      const result = this.validate(response, responseType, exchangeId);
      this.lastTransactionAt = performance.now();
      return result;
    }
    throw new Error("Timed out waiting for the VRX through the FC");
  }

  status() { return this.inventory().then(() => ({ ready: true, transport: "FC_USB" })); }

  async inventory() {
    let offset = 0;
    let total = null;
    let revision = null;
    const output = [];
    while (total === null || offset < total) {
      const body = await this.transact(INVENTORY_GET, INVENTORY_RESULT,
        new Uint8Array([...u16(offset), ...u16(160)]));
      if (body.length < 9) throw new Error("Truncated VRX inventory chunk");
      const currentRevision = readU16(body, 1);
      const currentTotal = readU16(body, 3);
      const currentOffset = readU16(body, 5);
      const length = readU16(body, 7);
      if (body.length !== 9 + length || currentOffset !== offset || !length && offset < currentTotal) {
        throw new Error("Invalid VRX inventory chunk");
      }
      if (revision === null) { revision = currentRevision; total = currentTotal; }
      else if (revision !== currentRevision || total !== currentTotal) throw new Error("VRX inventory changed during read");
      output.push(...body.slice(9));
      offset += length;
    }
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(output)));
  }

  async readProfile() {
    let offset = 0, revision = null, total = null, checksum = null;
    const output = [];
    while (total === null || offset < total) {
      const body = await this.transact(PROFILE_GET, PROFILE_RESULT,
        new Uint8Array([...u16(offset), ...u16(160)]));
      if (body.length < 15) throw new Error("Truncated VRX profile chunk");
      const values = [readU32(body, 1), readU16(body, 5), readU32(body, 7)];
      const currentOffset = readU16(body, 11), length = readU16(body, 13);
      if (body.length !== 15 + length || currentOffset !== offset) throw new Error("Invalid VRX profile chunk");
      if (revision === null) [revision, total, checksum] = values;
      else if (revision !== values[0] || total !== values[1] || checksum !== values[2]) throw new Error("VRX profile changed during read");
      output.push(...body.slice(15)); offset += length;
      if (!length && offset < total) throw new Error("VRX profile read did not advance");
    }
    const bytes = Uint8Array.from(output);
    if (crc32(bytes) !== checksum) throw new Error("VRX profile CRC mismatch");
    return { revision, length: total, crc32: checksum, text: new TextDecoder().decode(bytes) };
  }

  async uploadProfile(text) {
    let bytes = new TextEncoder().encode(text.endsWith("\n") ? text : `${text}\n`);
    if (!bytes.length || bytes.length > 4096) throw new Error("VRX profile must contain 1 to 4096 bytes");
    const begin = await this.transact(PROFILE_BEGIN, PROFILE_BEGIN_RESULT,
      new Uint8Array([...u16(bytes.length), ...u32(crc32(bytes))]));
    const transaction = readU16(begin, 1);
    try {
      let offset = readU16(begin, 3);
      while (offset < bytes.length) {
        const chunk = bytes.slice(offset, offset + 160);
        const body = await this.transact(PROFILE_CHUNK, PROFILE_CHUNK_RESULT,
          new Uint8Array([...u16(transaction), ...u16(offset), chunk.length, ...chunk]));
        if (readU16(body, 1) !== transaction || readU16(body, 3) !== offset + chunk.length) {
          throw new Error("VRX profile write did not advance");
        }
        offset += chunk.length;
      }
      const committed = await this.transact(PROFILE_COMMIT, PROFILE_COMMIT_RESULT, u16(transaction));
      return { revision: readU32(committed, 1), length: readU16(committed, 5), crc32: readU32(committed, 7) };
    } catch (error) {
      await this.transact(PROFILE_ABORT, PROFILE_ABORT_RESULT, u16(transaction)).catch(() => {});
      throw error;
    }
  }
}
