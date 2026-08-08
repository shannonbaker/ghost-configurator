import { encodeMspV1, encodeMspV2, MspParser } from "./protocol.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const MAVLINK_V1 = 0xfe;
const MAVLINK_V2 = 0xfd;
const MAVLINK_HEARTBEAT = 0;
const MAVLINK_AUTOPILOT_ARDUPILOTMEGA = 3;

// A small framing parser is sufficient here: identification is passive and the
// heartbeat's fixed fields give us an additional sanity check without needing
// to carry every MAVLink dialect's CRC-extra table in the configurator.
export class MavlinkParser {
  constructor() { this.buffer = new Uint8Array(); }

  push(chunk) {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    const messages = [];
    while (this.buffer.length) {
      const start = this.buffer.findIndex((byte) => byte === MAVLINK_V1 || byte === MAVLINK_V2);
      if (start < 0) { this.buffer = new Uint8Array(); break; }
      if (start) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 2) break;
      const v2 = this.buffer[0] === MAVLINK_V2;
      const headerLength = v2 ? 10 : 6;
      if (this.buffer.length < headerLength) break;
      const signed = v2 && Boolean(this.buffer[2] & 0x01);
      const frameLength = headerLength + this.buffer[1] + 2 + (signed ? 13 : 0);
      if (this.buffer.length < frameLength) break;
      const frame = this.buffer.slice(0, frameLength);
      this.buffer = this.buffer.slice(frameLength);
      const messageId = v2
        ? frame[7] | (frame[8] << 8) | (frame[9] << 16)
        : frame[5];
      const payload = frame.slice(headerLength, headerLength + frame[1]);
      messages.push({ version: v2 ? 2 : 1, messageId, systemId: frame[v2 ? 5 : 3],
        componentId: frame[v2 ? 6 : 4], payload });
    }
    return messages;
  }
}

export function decodeMavlinkHeartbeat(message) {
  if (message.messageId !== MAVLINK_HEARTBEAT || message.payload.length < 9 ||
      message.payload[8] < 3) return null;
  return {
    ...message,
    vehicleType: message.payload[4],
    autopilot: message.payload[5],
    baseMode: message.payload[6],
    systemStatus: message.payload[7],
    isArduPilot: message.payload[5] === MAVLINK_AUTOPILOT_ARDUPILOTMEGA,
  };
}

export class SerialSession extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.parser = new MspParser();
    this.mavlinkParser = new MavlinkParser();
    this.lastMavlinkHeartbeat = null;
    this.pendingMsp = new Map();
    this.textDecoder = new TextDecoder();
    this.cliText = "";
    this.cliMode = false;
    this.closing = false;
    this.readTask = null;
  }

  async connect() {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial is unavailable. Use desktop Chrome, Edge, or Chromium.");
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200, bufferSize: 4096 });
    // STM32 USB CDC may accept the open before its MSP endpoint is ready.
    // Assert DTR as desktop FC configurators do, begin consuming input, then
    // allow the endpoint to settle before the first identification request.
    if (this.port.setSignals) {
      await this.port.setSignals({ dataTerminalReady: true }).catch(() => {});
    }
    this.closing = false;
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
    await delay(500);
  }

  async readLoop() {
    while (!this.closing && this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (!value) continue;
          for (const message of this.mavlinkParser.push(value)) {
            const heartbeat = decodeMavlinkHeartbeat(message);
            if (!heartbeat) continue;
            this.lastMavlinkHeartbeat = heartbeat;
            this.dispatchEvent(new CustomEvent("mavlink-heartbeat", { detail: heartbeat }));
          }
          if (this.cliMode) {
            this.cliText += this.textDecoder.decode(value, { stream: true });
            this.dispatchEvent(new CustomEvent("text", { detail: this.cliText }));
          } else {
            for (const frame of this.parser.push(value)) {
              const pending = this.pendingMsp.get(frame.command);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingMsp.delete(frame.command);
                frame.error ? pending.reject(new Error(`FC rejected MSP ${frame.command}`)) : pending.resolve(frame.payload);
              }
            }
          }
        }
      } catch (error) {
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
  }

  async write(bytes) {
    if (!this.writer) throw new Error("Serial port is not connected");
    await this.writer.write(bytes);
  }

  requestMsp(command, payload = new Uint8Array(), timeoutMs = 1200) {
    if (this.pendingMsp.has(command)) throw new Error(`MSP ${command} is already pending`);
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMsp.delete(command);
        reject(new Error(`Timed out waiting for MSP ${command}`));
      }, timeoutMs);
      this.pendingMsp.set(command, { resolve, reject, timer });
      try {
        await this.write(command > 0xfe ? encodeMspV2(command, payload) : encodeMspV1(command, payload));
      } catch (error) {
        clearTimeout(timer);
        this.pendingMsp.delete(command);
        reject(error);
      }
    });
  }

  waitForMavlinkHeartbeat(timeoutMs = 1800) {
    if (this.lastMavlinkHeartbeat) return Promise.resolve(this.lastMavlinkHeartbeat);
    return new Promise((resolve, reject) => {
      const receive = (event) => {
        clearTimeout(timer);
        this.removeEventListener("mavlink-heartbeat", receive);
        resolve(event.detail);
      };
      const timer = setTimeout(() => {
        this.removeEventListener("mavlink-heartbeat", receive);
        reject(new Error("Timed out waiting for a MAVLink heartbeat"));
      }, timeoutMs);
      this.addEventListener("mavlink-heartbeat", receive);
    });
  }

  async enterCli() {
    if (this.cliMode) return;
    this.cliMode = true;
    this.cliText = "";
    await this.write(new TextEncoder().encode("#\r\n"));
    await this.waitForPrompt(2500);
  }

  async runCli(command, timeoutMs = 2500) {
    if (!this.cliMode) throw new Error("FC is not in CLI mode");
    this.cliText = "";
    await this.write(new TextEncoder().encode(`${command}\r\n`));
    return this.waitForPrompt(timeoutMs);
  }

  async waitForPrompt(timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (/(?:^|\r?\n)#\s*$/.test(this.cliText)) return this.cliText;
      await delay(25);
    }
    throw new Error("Timed out waiting for the Betaflight CLI prompt");
  }

  async close({ reboot = false } = {}) {
    if (reboot && this.cliMode && this.writer) {
      await this.write(new TextEncoder().encode("exit\r\n"));
      await delay(300);
    }
    this.closing = true;
    for (const pending of this.pendingMsp.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Serial port closed"));
    }
    this.pendingMsp.clear();
    if (this.reader) await this.reader.cancel().catch(() => {});
    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }
    await this.readTask?.catch(() => {});
    if (this.port) await this.port.close().catch(() => {});
    this.port = null;
    this.cliMode = false;
  }
}
