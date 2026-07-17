import { encodeMspV1, encodeMspV2, MspParser } from "./protocol.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class SerialSession extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.parser = new MspParser();
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
    this.closing = false;
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }

  async readLoop() {
    while (!this.closing && this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (!value) continue;
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
