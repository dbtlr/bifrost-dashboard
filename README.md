# Bifrost dashboard

An app launcher with a black background, grouped responsive icon grid, local search, and a Manage panel for editing it. TypeScript and Vite build the frontend. A small Node server stores apps and groups in SQLite and exposes a JSON API.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
mkdir -p data && cp -r sample/. data/
npm run dev
```

The checked-in `sample/` contains illustrative `example.test` URLs and local demo icons. The first start imports `data/apps.json` into SQLite. Later starts never import it again, even after every app is deleted.

Vite serves the same API and data icons as the production server. Use `BIFROST_DATA_DIR` to select another data directory. The launcher reads and changes the catalog through this API. Nothing in the dashboard queries or changes the proxy.

Relative data directories resolve from the application root, even with a different Vite root. Vite denies direct file access to the data directory and `sample/`; use `/api/` for catalog data and `/icons/` for live icons.

## Launcher and Manage panel

The launcher fetches `api/catalog` on each page load, with cache revalidation and a ten-second timeout, and validates the whole response before showing it. It shows each nonempty group as a section in the order you set, then ungrouped apps under "Ungrouped". With no groups, one "All apps" section lists everything. Search matches app names and domains across groups and hides groups without matches. Apps open in new tabs. An empty catalog shows an empty state; an invalid or unavailable response shows a retry action. There is no background polling.

Icon paths from the API are relative to the dashboard root and resolve against the page's base URL, so they work under a `--base` prefix. Missing or broken images fall back to initials. Icons are shown as images, never inserted as markup, and all API text is rendered as plain text.

**Manage** opens a side panel (a full-screen sheet on phones) with the same groups and apps as a tree. Drag the handles to reorder groups, reorder apps, or move an app to another group, including an empty one; the tree and launcher update from the server's response. A rejected change, such as a conflict with an edit made elsewhere, reloads the catalog and shows a message. Each group has Rename, Move up, Move down, and Delete (its apps become ungrouped). Selecting an app opens a form to change its name, URL, group, and icon, to move it up or down without dragging, or to remove it. **+ App** and **+ Group** create new ones. Every change is saved immediately. The API behind the panel is documented in [docs/api.md](docs/api.md).

## Data and automation

`BIFROST_DATA_DIR` is writable state, separate from frontend builds. It contains `bifrost.sqlite` and `icons/`. The server creates the data directory and `icons/` when needed, and closes the database on shutdown.

Use the [catalog management API](docs/api.md) to add, change, reorder, and remove apps and groups. Upload icons through the API. It names icons by content hash and removes files when no app references them. All API responses use `Cache-Control: no-cache`.

Automation reads `/api/catalog` and updates individual resources through the API. Writing `apps.json` after the initial import has no effect. Back up the data directory while the service is stopped.

## Build and hosting

```sh
npm run build
npm start
```

`npm start` serves the built dashboard at `http://127.0.0.1:4310`. It uses Node.js 24 and `serve-static`; it does not launch Vite or another proxy. Point the existing Caddy reverse proxy at `127.0.0.1:4310` when both processes run on the same host. Vite development (`npm run dev`) uses port `5173` by default. An occupied production port causes an error rather than an automatic port change.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIFROST_HOST` | `127.0.0.1` | Listening interface. Use an appropriate reachable interface if the proxy runs elsewhere or in a container. |
| `BIFROST_PORT` | `4310` | Fixed HTTP port, configurable from 1 to 65535. Use an unprivileged port for the systemd service. |
| `BIFROST_BUILD_DIR` | `dist/` | Built frontend files. |
| `BIFROST_DATA_DIR` | `data/` | Writable SQLite database and uploaded `icons/`. |

Relative directory settings resolve from the application root, independent of the process working directory. For example, `BIFROST_PORT=4311 npm start` changes only the built server's port.

The server routes `/api/` to the JSON API and `/icons/` to the data directory. Other paths serve the build. `/apps.json` has no live data route. Files use `Cache-Control: no-cache`; missing data icons return 404 even if the build contains a matching file. It serves the app at the origin root; a reverse proxy mounting it under a prefix must strip that prefix, and the frontend must be built with the matching Vite `--base`.

`sample/` and `data/` are not copied into `dist/`. `npm run preview` serves only the static build, without the API or data icons. Use `npm start` or `npm run dev` to exercise the API.

## systemd service

`deploy/bifrost-dashboard.service` runs the built server under a temporary unprivileged systemd identity and restarts it on failure. It reads configuration from `/etc/bifrost-dashboard/dashboard.env`. It does not build the frontend or configure the existing reverse proxy.

First place the application at the chosen deployment location and run `npm ci` and `npm run build` there. The service needs `server/`, `src/app-rules.ts`, `package.json`, runtime `node_modules/`, and the configured build directory. Node.js 24 must be installed at a service-accessible path outside `/home`; set `BIFROST_NODE_BIN` to that executable. Development dependencies are only needed for builds and checks.

For the first installation, run these commands from the application directory:

```sh
sudo install -d -m 0755 /etc/bifrost-dashboard
sudo install -m 0644 deploy/dashboard.env.example /etc/bifrost-dashboard/dashboard.env
sudoedit /etc/bifrost-dashboard/dashboard.env
```

Set `BIFROST_APP_DIR` and `BIFROST_BUILD_DIR` to the chosen absolute locations. The example uses `/srv/bifrost-dashboard` for the application. Keep `BIFROST_DATA_DIR=/var/lib/bifrost-dashboard` to match the unit's `StateDirectory=bifrost-dashboard`. Systemd creates writable persistent storage for the dynamic service identity while the rest of the filesystem remains protected. Application and build files must be readable, and their parent directories traversable, by that identity. Paths under `/home` are hidden by the unit's sandbox.

Check the chosen port with `ss -ltn` before enabling the service. Then install and start the dedicated unit:

```sh
sudo install -m 0644 deploy/bifrost-dashboard.service /etc/systemd/system/bifrost-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now bifrost-dashboard.service
systemctl status bifrost-dashboard.service
journalctl -u bifrost-dashboard.service -n 50 --no-pager
```

To migrate an existing deployment:

1. Stop the service with `sudo systemctl stop bifrost-dashboard.service`.
2. Copy its old `apps.json` and `icons/` into `/var/lib/bifrost-dashboard`. Preserve an existing `bifrost.sqlite` to keep its state instead.
3. Update `dashboard.env` to use that data directory.
4. Install the updated unit and reload systemd before starting:

```sh
sudo install -m 0644 deploy/bifrost-dashboard.service /etc/systemd/system/bifrost-dashboard.service
sudo systemctl daemon-reload
sudo systemctl start bifrost-dashboard.service
```

The updated unit's `StateDirectory=bifrost-dashboard` makes persistent storage writable under `ProtectSystem=strict`. The old unit lacks that setting.

A fresh database imports the legacy catalog once, accepting a leading UTF-8 BOM. An invalid `apps.json` stops startup until it is fixed or removed. The error names the file and invalid app number. No apps are imported on failure, so the corrected file can be imported on the next start.

For later frontend releases, build the application and restart with `sudo systemctl restart bifrost-dashboard.service`. Preserve the environment file and the persistent data directory. Port or path changes in the environment file also require a restart. API updates do not. Stop and disable the service with `sudo systemctl disable --now bifrost-dashboard.service`.

## Checks

```sh
npm run check
npx playwright install chromium
npm run test:browser
```

Linux browser checks also need Chromium's system libraries; on a development or CI machine that permits package installation, `npx playwright install --with-deps chromium` installs them. `npm run test:browser` builds the frontend first. Each browser test starts its own dashboard server on a random port with a fresh temporary database, so tests are isolated and run in parallel. They cover the grouped launcher, search, load failures, and the Manage panel (adding, editing, icons, dragging, keyboard reordering, deletion, the phone sheet, and conflict recovery) in desktop and phone projects.

`npm run check` runs the unit tests, TypeScript checks, and Vite build. Unit tests cover one-time import, ordering, atomic layouts, JSON validation, icon uploads and cleanup, file routing, cache headers, path protections, and occupied ports. Validate unit syntax with `systemd-analyze verify deploy/bifrost-dashboard.service`.

The original static design studies remain in `designs/` and are not part of the production build.
