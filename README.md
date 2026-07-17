# GHOST Configurator POC

Static, build-free browser proof of concept for configuring the existing
Betaflight GHOST field stream.

## Current scope

- Connects through Web Serial at 115200 baud.
- Reads FC variant, version, and board identity using MSPv1.
- Enters the Betaflight CLI and discovers fields using `ghost_field list`.
- Reads the current `ghost_field` table.
- Clears, rewrites, saves, and reboots the FC when Apply is selected.
- Includes a demo mode and an offline service worker.

The CLI integration is intentionally isolated in `serial.js` and `app.js`. It
is the temporary adapter for the firmware currently available. A later version
should replace it with common GHOST MSPv2 capabilities/configuration commands.

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
