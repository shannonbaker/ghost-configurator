# GHOST Configurator POC

Static, build-free browser proof of concept for configuring the existing
Betaflight GHOST field stream.

## Current scope

- Connects through Web Serial at 115200 baud.
- Reads FC variant, version, and board identity using MSPv1.
- Enters the Betaflight CLI and discovers fields using `ghost_field list`.
- Reads the current `ghost_field` table.
- Uses the transactional GHOST MSPv2 v1.0 API when supported.
- Retains clear/rewrite/save/reboot CLI fallback for older POC firmware.
- Includes a demo mode and an offline service worker.

The GHOST API integration is isolated in `ghost-api.js`. Firmware without the
new commands automatically uses the temporary Betaflight CLI adapter.

The versioned byte-level command contract is in
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
programs that own the serial port. Applying configuration enters CLI, replaces
the GHOST field table, saves, and reboots the FC.
