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

The launcher fetches `api/catalog` on each page load, with cache revalidation and a ten-second timeout, and validates the whole response before showing it. It shows each nonempty group as a section in the order you set, then ungrouped apps under "Ungrouped". With no groups, one "All apps" section lists everything. Search matches an app's name or its domain across groups and hides groups without matches. Apps open in new tabs. An empty catalog shows an empty state; an invalid or unavailable response shows a retry action. There is no background polling.

Icon paths from the API are relative to the dashboard root and resolve against the page's base URL, so they work under a `--base` prefix. Missing or broken images fall back to initials. Icons are shown as images, never inserted as markup, and all API text is rendered as plain text.

**Manage** opens a side panel (a full-screen sheet on phones) with the same groups and apps as a tree. Drag the handles to reorder groups, reorder apps, or move an app to another group, including an empty one; the tree and launcher update from the server's response. A rejected change, such as a conflict with an edit made elsewhere, reloads the catalog and shows a message. Each group has Rename, Move up, Move down, and Delete (its apps become ungrouped). Selecting an app opens a form to change its name, URL, group, and icon, to move it up or down without dragging, or to remove it. **+ App** and **+ Group** create new ones. Every change is saved immediately, one at a time: while a change is saving, the controls that make changes are disabled, so a slow reply can never overwrite newer state. Reorders send the catalog revision they were built from, so a reorder from an outdated view is rejected instead of undoing changes made elsewhere. The API behind the panel is documented in [docs/api.md](docs/api.md).

## Data and automation

`BIFROST_DATA_DIR` is writable state, separate from frontend builds. It contains `bifrost.sqlite` and `icons/`. The server creates the data directory and `icons/` when needed, and closes the database on shutdown.

Use the [catalog management API](docs/api.md) to add, change, reorder, and remove apps and groups. Upload icons through the API. It names icons by content hash and removes files when no app references them. All API responses use `Cache-Control: no-cache`.

Automation reads `/api/catalog` and updates individual resources through the API. The catalog carries a revision that increases with every change. A layout write must send the revision it was built from and is rejected with `409` if another change came first, so a reorder never silently undoes edits it didn't see. Writing `apps.json` after the initial import has no effect. Back up the data directory while the service is stopped.

## Build and hosting

```sh
npm run build
npm start
```

`npm start` serves the built dashboard at `http://127.0.0.1:4310`. It uses Node.js 24 and `serve-static`; it does not launch Vite or another proxy. Point the existing Caddy reverse proxy at `127.0.0.1:4310` when both processes run on the same host. Vite development (`npm run dev`) uses port `5173` by default. An occupied production port causes an error rather than an automatic port change.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIFROST_HOST` | `127.0.0.1` | Listening interface. The systemd service accepts only loopback addresses. |
| `BIFROST_PORT` | `4310` | Fixed HTTP port, configurable from 1 to 65535. Use an unprivileged port for the systemd service. |
| `BIFROST_BUILD_DIR` | `dist/` | Built frontend files. |
| `BIFROST_DATA_DIR` | `data/` | Writable SQLite database and uploaded `icons/`. |

Relative directory settings resolve from the application root, independent of the process working directory. For example, `BIFROST_PORT=4311 npm start` changes only the built server's port.

The server routes `/api/` to the JSON API and `/icons/` to the data directory. Other paths serve the build. `/apps.json` has no live data route. Files use `Cache-Control: no-cache`; missing data icons return 404 even if the build contains a matching file. It serves the app at the origin root; a reverse proxy mounting it under a prefix must strip that prefix, and the frontend must be built with the matching Vite `--base`.

`sample/` and `data/` are not copied into `dist/`. `npm run preview` serves only the static build, without the API or data icons. Use `npm start` or `npm run dev` to exercise the API.

## systemd service

`server/service.ts` installs and controls the dashboard as a systemd service. The service runs the built server under a temporary unprivileged systemd identity, restarts it on failure, and keeps its data in `/var/lib/bifrost-dashboard`. The commands do not build the frontend or configure the reverse proxy. [Service commands](docs/service.md) is the full reference.

Place the release outside `/home` and `/tmp`, for example at `/srv/bifrost-dashboard`, and keep it writable only by root. Run `npm ci` and `npm run build` there; `npm prune --omit=dev` can then drop the development dependencies. The service runs the Node.js 24 binary that runs the command, unless `BIFROST_NODE_BIN` names another one.

Configuration is optional. To change the port or data directory, create the file before installing:

```sh
sudo install -d -m 0755 /etc/bifrost-dashboard
sudo install -m 0644 deploy/dashboard.env.example /etc/bifrost-dashboard/dashboard.env
sudoedit /etc/bifrost-dashboard/dashboard.env
```

Check the chosen port with `ss -ltn`. Then install and start the service from the release directory:

```sh
sudo node server/service.ts install
node server/service.ts status
sudo node server/service.ts logs --lines 50
```

`install` writes the unit, enables and restarts the service, and checks that systemd reports it active. If a step fails, it puts the previous unit and service state back. The service listens on loopback only, because the API has no authentication; point the reverse proxy at it on the same host.

- **New release:** build it in its own directory and run its `server/service.ts install`. Running an earlier release's `install` rolls back.
- **Configuration change:** run `sudo node server/service.ts restart` from the installed release.
- **Removal:** run `sudo node server/service.ts uninstall`. It keeps the data directory and the configuration file.

A fresh database imports a legacy `apps.json` from the data directory once, accepting a leading UTF-8 BOM. An invalid `apps.json` stops startup until it is fixed or removed. The error names the file and invalid app number. No apps are imported on failure, so the corrected file can be imported on the next start.

Installations from earlier versions kept data in `/srv/bifrost-dashboard-data`. [Service commands](docs/service.md#data) describes how to move it; `install` refuses to start an empty catalog while that directory exists.

## Checks

```sh
npm run check
npx playwright install chromium
npm run test:browser
```

Linux browser checks also need Chromium's system libraries; on a development or CI machine that permits package installation, `npx playwright install --with-deps chromium` installs them. `npm run test:browser` builds the frontend first. Each browser test starts its own dashboard server on a random port with a fresh temporary database, so tests are isolated and run in parallel. They cover the grouped launcher, search, load failures, and the Manage panel (adding, editing, icons, dragging, keyboard reordering, deletion, the phone sheet, conflict recovery, slow and concurrent changes, and focus after changes) in desktop and phone projects.

`npm run check` runs the unit tests, TypeScript checks, and Vite build. Unit tests cover one-time import, schema upgrades, catalog revisions, ordering, atomic layouts, JSON validation, the API client, search, and the Manage panel's move and edit rules, icon uploads and cleanup, file routing, cache headers, path protections, and occupied ports. Service tests run `server/service.ts` against a temporary system root with stand-in `systemctl` and `journalctl`. They cover unit rendering, configuration rules, recovery after failed installs, and every command; they need a non-root user. To check a rendered unit's syntax, save the output of `server/service.ts unit` as `bifrost-dashboard.service` and run `systemd-analyze verify` on it.

The original static design studies remain in `designs/` and are not part of the production build.

## Privacy boundary

The checked-in `sample/` catalog and icons are illustrative examples. Keep real service catalogs, icons, and deployment configuration out of the repository; they belong in the data directory and `/etc/bifrost-dashboard/`. The dashboard shows and edits the catalog it stores. It does not discover services.

## License and artwork

The application is licensed under the [MIT License](LICENSE), copyright 2026 Drew Butler. Package metadata retains `private: true`; the package is not published to npm.

The 12 demo SVGs and corresponding inline design-study marks are newly authored generic geometric examples. They replace artwork whose provenance was unverified. No provenance claim is made for the replaced artwork. The application brand remains unchanged and contains no embedded demo marks. Third-party dependencies retain their own licenses and copyright notices; the application license does not replace those terms.
