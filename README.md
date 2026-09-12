# Home Heat Map

<p align="center"><img src="assets/branding/readme-banner.png" alt="Home Heat Map — a house filled with colourful floor-plan heat contours" width="600"></p>

A Go web app for mapping Home Assistant temperature, relative humidity, RSSI and Zigbee link quality onto shared floor plan images. The UI is embedded in the executable; there is no frontend build step or external CDN. It supports standalone use and includes packaging for a local Home Assistant add-on (now called an app).

## Run standalone

Requires Go 1.24 or newer.

```sh
cp .env.example .env
# Edit .env with your HA base URL and a long-lived access token.
set -a
. ./.env
set +a
go run .
```

Open `http://localhost:8099`, or `http://<server-ip>:8099` from your LAN when using the example listen address. Without environment variables, the app listens on `127.0.0.1:8099`; image setup and the simulated demo work without HA.

The HA URL is the base address (e.g. `http://192.168.1.20:8123`), without `/api`. Create a long-lived access token from your HA user profile. Tokens stay in the server environment and are never sent to the browser or saved with layouts. Registry discovery may require an administrator token; the UI reports permission failures while allowing manual placement.

For HTTPS using a private certificate authority, set `HA_CA_FILE` to its PEM certificate path. This adds your CA to the system roots for both REST and WebSocket connections while preserving certificate and hostname verification. With Docker, mount the certificate read-only and set `HA_CA_FILE` to the path inside the container.

```sh
go build -o homeheatmap .
./homeheatmap -listen 0.0.0.0:8099 -data ./data
```

Standalone access has no login and is intended for a trusted local network. Anyone with access can edit the floor plans. `.env`, the binary and persistent data are excluded from Git.

## Setup and use

1. **Add a floor**: upload a PNG, JPEG or GIF (up to 20 MB / 40 megapixels) and choose its HA floor. Multiple images/floors are supported. HA floor association suggests sensors; it does not prevent manual placement from other areas.
2. **Trace rooms**: enter Setup, choose Room, click the corners in order, enter a name and finish. Clicking within 12 screen pixels of the first corner closes the shape without adding an extra vertex; the Finish room button also closes it automatically. Trace each room's usable interior without overlapping other rooms. Concave polygons work. Use Undo point or Backspace while drawing; Escape cancels. Saved room shapes can be removed and redrawn.
3. **Place sensors**: select a temperature sensor, then click its location inside a room. Select it again to reposition. Ignore unwanted sensors; enable Show ignored sensors to restore them. A sensor can only be placed once across all floors.
4. **Connect doorways**: choose Doorway, click just inside one room at the opening, then just inside the adjoining room. Keep endpoints close to the actual doorway. Adjust influence per door: zero disconnects it, one is the strongest connection. Connections are static; HA door open/closed entities are not yet used.
5. **Save setup**. Floor plans, polygons, placements, doorways and ignored sensors persist under `DATA_DIR`. Saves are atomic and reject stale edits from another tab. Back up the entire data directory. Deleted floors leave their uploaded image files on disk.
6. **View live or history**: readings refresh every 15 seconds. Choose a day, week or month ending at the selected date/time. Drag the timeline or press Play. Zoom and scroll the plan; set the colour scale and overlay strength independently.

The demo uses a generated illustrative floor plan and simulated readings. Demo changes are not saved. Exit the demo to return to your real configuration.

## Temperature model

Temperature values are converted to Celsius; humidity stays in % RH. Rendering uses inverse-square distance weighting from sensor positions along the shortest paths inside room polygons. Paths can cross into another room only through an explicit doorway; a doorway adds a distance penalty controlled by its influence. Concave room boundaries obstruct direct paths. Multiple doorway connections can propagate an estimate across several rooms.

A lone reachable sensor produces a uniform field. Multiple sensors produce gradients. Rooms without a local valid reading have dotted outlines and are labelled as estimates when a connected sensor can influence them. Disconnected rooms have no temperature. The sidebar reports a spatial average of the rendered field, not a simple sensor average. This is a visual interpolation model, not a physical heat/airflow simulation: it does not infer insulation, door state, ventilation or heating power.

The colour scale stays fixed while scrubbing so identical colours mean identical temperatures. Unknown/unavailable readings are excluded. Live readings are cleared after a minute of failed refreshes, rather than appearing current indefinitely.

## History

- **Day**: HA REST state history, preserving recorded changes and unavailable states. A reading holds until its next recorded change, matching HA state semantics.
- **Week / month**: HA WebSocket recorder hourly mean statistics, requested in Celsius. Sensors must have compatible long-term statistics in HA (typically temperature sensors with `state_class: measurement`). Missing intervals remain blank; raw history is not silently substituted or fabricated. The most recent incomplete hour can be blank. Select **Hourly means** explicitly when viewing an older day whose raw history has already been purged.
- The end-time input uses the browser's local timezone; API timestamps are UTC. Week/month mean trailing 7/30 days, not calendar periods. Playback displays the recorded interval; it does not interpolate across missing timestamps.

HA API references: [REST states and history](https://developers.home-assistant.io/docs/api/rest/), [WebSocket authentication](https://developers.home-assistant.io/docs/api/websocket/), [recorder statistics command](https://github.com/home-assistant/core/blob/dev/homeassistant/components/recorder/websocket_api.py).

## Docker

Fill `.env`, then run `docker compose up --build -d`. The container stores its data in the mounted `./data` directory.

## Home Assistant add-on / app

This repository includes app-store metadata in `repository.yaml`. Once the
repository is publicly readable, add it using [Add repository to Home Assistant](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FMrPsyware%2FHA-HomeHeatMap),
or enter `https://github.com/MrPsyware/HA-HomeHeatMap` in the app store's repository
settings. Select **Home Heat Map**, install, start, and open its web UI.
This requires an HA installation with Supervisor/app support.

While the GitHub repository is private, the ordinary repository URL cannot be
cloned anonymously by HA. Your desktop's `gh` login is not transferred to HA.
For private testing, use the local installation below. Repository visibility is
a separate GitHub setting; this packaging does not change it.

Installation currently builds the Docker image on the HA host (amd64 or aarch64),
so the first install can take a few minutes. Prebuilt container publishing is not
yet configured. To release an update, increment `version` in `config.yaml` and
push the changes; HA can then detect an app update. Installing a repository does
not itself install the app or enable unattended updates.

The app uses HA's Supervisor token automatically; no personal HA token is needed.
Existing standalone floor plans are not transferred automatically: the app starts
with its own persistent `/data` directory.


The root `config.yaml` and `Dockerfile` provide local add-on packaging. Copy this project (excluding `.env` and existing data) into `/addons/home_heat_map` on your HA installation, reload the app/add-on store, and install the local Home Heat Map entry. The container uses `/data` for persistence.

When `SUPERVISOR_TOKEN` is present, the app automatically uses `http://supervisor/core` and the Supervisor token. It accepts requests only from HA's ingress proxy (`172.30.32.2`), and uses relative browser URLs so it works under an ingress path. No direct host port is exposed by the add-on manifest. See [HA ingress requirements](https://developers.home-assistant.io/docs/apps/presentation/).

The standalone app can be tested without an HA instance. The add-on package and real HA integration still need an end-to-end check on your installation.

## Checks

```sh
go test -race ./...
go vet ./...
node --test web/*.test.mjs
```

Tests cover layout validation, persistence, image uploads, origin checks, ingress access, mock HA REST and WebSocket APIs, unit conversion, missing history, gradients, concave geometry and doorway isolation.

## Layers and device setup

Use the layer selector beside Live / History to switch between Temperature,
Humidity, Signal strength (RSSI in dBm), and Zigbee link quality (LQI, 0–255).
Existing placements remain temperature sensors. Each layer shares the same floor
image and room polygons, with independent sensor placements and colour scale
defaults. Temperature and humidity follow room boundaries and doorways; room labels
show the spatial average and an asterisk when there is no valid local reading.

In Setup → Humidity, **Pair matching humidity sensors** copies the locations of
temperature sensors across all floors. It prefers a unique humidity entity on the
same HA device, then tries the entity name after the domain with endings such as
`_temperature`, `_tempreture`, `_temp`, `_humidity`, or `_humid` removed.
Ambiguous matches are skipped, as are ignored or already placed entities. Review
the results and Save setup. Pairing is a one-time copy, so either placement can
subsequently be moved independently. You can always place a humidity sensor manually.
Humidity discovery uses HA's relative-humidity class or a humidity-named percentage
sensor. Soil moisture, battery percentages, and binary leak sensors are excluded.

Search the sensor list by name or entity ID. The default filter shows devices
assigned to the current HA floor plus devices already placed there; choose **All
devices** or **All unplaced devices** to find others. If the floor has no HA
association, the default shows all. Drag a list entry onto the map, or select it
and click its position. In Select mode you can drag existing sensor markers.
Humidity and temperature need a room; signal sensors can go anywhere on the image.
Up to 1,000 sensor placements per floor are supported.

Signal interpolation crosses room boundaries; room tags are labels only.
RSSI and LQI are separate layers and are never averaged together. RSSI is based
on readings HA actually exposes, not a radio survey or a simulation of walls,
transmit power, roaming or mesh routing. LQI values depend on the reporting device
and integration. Only numeric sensor entities exposed in HA are discovered;
devices with no RSSI/LQI entity cannot supply a reading.

The signal Network filter can select Wi-Fi, Zigbee or unclassified devices.
ZHA entities and LQI are classified as Zigbee; ESPHome and UniFi RSSI entities
are suggested as Wi-Fi. Other integrations may stay unclassified. After placing
a device you can override its network in the list. Wi-Fi AP and Zigbee
coordinator/router reference markers have a name and location, but contribute no
invented signal readings. Click a reference in the setup list to move it.

Signal devices use small dots with details on hover or tap. History works per
layer using saved placements and HA recorder data. Long-term hourly means require
HA statistics support for that entity; unavailable data stays blank.

## Home Assistant dashboard card

The custom card uses the app's compact view, keeping room tags and the glow while
hiding setup, the sidebar, and device markers/text by default. Hover or tap a
device location to reveal its details. This is a display mode, not an access-control
boundary; standalone setup remains available at the app's main URL.

1. Copy [web/home-heat-map-card.js](web/home-heat-map-card.js) to
   `/config/www/home-heat-map-card.js` on Home Assistant.
2. Add dashboard resource `/local/home-heat-map-card.js` with type **JavaScript module**.
3. Add a manual card:

```yaml
type: custom:home-heat-map-card
url: http://YOUR-APP-HOST:8099/
metrics:
  - temperature
  - humidity
history: true
height: 550
device_labels: false
# floor: YOUR-FLOOR-ID
```

Use one entry in `metrics` to lock the layer, or multiple entries to show a
selector. Supported entries are `temperature`, `humidity`, `rssi`, and `lqi`.
Set `history: false` (the default) to hide history. `device_labels: true`
restores the full app's marker/label behaviour. Omit `floor` to show a floor
selector; floor names are matched case-insensitively (for example, `floor: upstairs`). Internal floor IDs are also accepted.
The card URL must be reachable by the dashboard browser; `localhost` refers to
that browser's machine. An HTTPS dashboard needs an HTTPS app URL, typically
through your reverse proxy. The card does not establish a Supervisor ingress
session or create a proxy; use a stable browser-accessible app URL. App API
credentials stay on the app server.

For a standard webpage/iframe card, the compact URL is:
`http://YOUR-APP-HOST:8099/?embed=1&metrics=temperature,humidity&history=1`.
Optional parameters: `floor=ID`, `device_labels=1`.

Card lifecycle follows the [Home Assistant custom-card API](https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/).
Sensor classifications use [HA sensor device classes and units](https://developers.home-assistant.io/docs/core/entity/sensor/).
The card and iframe are browser-tested locally; installation in a real HA
dashboard still needs verification on your installation.

Browser regression checks (mock HA responses; no user layout writes):

```sh
npm install --prefix /tmp/heatmap-browser playwright
go build -buildvcs=false -o /tmp/homeheatmap-next .
# Run this server in another terminal:
# /tmp/homeheatmap-next -listen 127.0.0.1:8100 -data /tmp/heatmap-feature-data
NODE_PATH=/tmp/heatmap-browser/node_modules node tests/browser.cjs
```

Requires Chromium at `/usr/bin/chromium`. The fixture covers two floors, pairing,
save/history flows, over 100 signal devices, reference markers, the custom-card
configuration, and compact rendering at 450×550.

### Minimal live display

Add `minimal=1` to the app URL for just the live floor plan, gradients and room
labels—no controls, legend, device markers, or hover text:

```text
http://YOUR-APP-HOST:8099/?minimal=1&metrics=temperature&floor=upstairs
```

It automatically uses embedded mode and live updates. Omit `floor` to use the
first floor; the first entry in `metrics` selects the layer. Errors still appear
if the app cannot load or refresh data.

In the HA card, set `minimal: true` alongside `floor` and `metrics`.
Minimal mode overrides history and device-label settings. Copy the updated card
JavaScript to HA if you already installed an older version.

Floor URL parameters and card settings accept case-insensitive floor names or exact internal IDs. For names containing spaces, URL-encode them (for example `floor=First%20Floor`). Exact IDs take precedence; duplicate names select the first matching floor.

## Transfer an existing setup

With app version 0.1.1 or newer, open **Setup → Import saved setup**, select your
transfer ZIP and click **Import transfer ZIP**. This works through HA ingress and
does not need SSH or File Editor access. The ZIP must contain `layout.json` at its
root and the referenced `images/` files, without an outer `data/` folder. It must
not contain `.env`, tokens, or other configuration files. Maximum ZIP and expanded
size: 100 MB; each image: 20 MB; layout JSON: 2 MB.

Import replaces the entire setup, including all floors, rooms, sensor placements,
doorways, ignored sensors and reference markers. It preserves the previous saved
layout as `layout-before-import-<timestamp>.json` in the app's private data folder
and leaves the old images intact. The page reloads after a successful import.
HA authentication stays managed by Supervisor. Save any source edits before
creating the transfer ZIP. Private bundles should stay in the Git-ignored
`backups/` directory.
