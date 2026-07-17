# GHOST Configurator

Static, build-free browser application for configuring the Betaflight GHOST
field stream and offline VRX widget profile.

## Current scope

- Connects through Web Serial at 115200 baud.
- Reads FC variant, version, and board identity using MSPv1.
- Enters the Betaflight CLI and discovers fields using `ghost_field list`.
- Reads the current `ghost_field` table.
- Uses the transactional GHOST MSPv2 v1.0 API when supported.
- Reads and atomically uploads the AHI/sticks widget profile through MSPv2.
- Shows the FC-side MSP DisplayPort wire rate while the configurator is
  connected; all rate calculations run in the browser.
- Stores renderer-only options as an opaque INI document on the FC, allowing
  future widget keys without matching FC parsing code.
- Retains clear/rewrite/save/reboot CLI fallback for older POC firmware.
- Includes an offline service worker.

The GHOST API integration is isolated in `ghost-api.js`. Firmware without the
new commands automatically uses the temporary Betaflight CLI adapter.

The default profile is [`widgets/default.ini`](widgets/default.ini). The
versioned byte-level command contract is in
[`docs/ghost-msp-config-v1.md`](docs/ghost-msp-config-v1.md).

## Run locally

The application must be served from `localhost` or HTTPS; do not open
`index.html` directly.

```sh
cd configurator-poc
python3 -m http.server 8000
```

Open `http://localhost:8000` in desktop Chrome, Edge, or Chromium.

## Test

```sh
npm test
```

## Safety

Remove propellers before connecting a flight controller. Disconnect other
programs that own the serial port. MSPv2 field and profile mutations are
rejected while the FC is armed. The CLI fallback applies only to field
subscriptions and saves/reboots the FC.
