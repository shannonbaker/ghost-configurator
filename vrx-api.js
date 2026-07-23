export class VrxApi {
  constructor(baseUrl = "http://127.0.0.1:48182/ghost-dp") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      cache: "no-store",
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
}
