# Bifrost dashboard

A static app launcher with a black background, responsive icon grid, and local search. TypeScript and Vite build the frontend. App discovery is handled by external automation that publishes a JSON catalog and icons.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run dev
```

The checked-in `public/apps.json` contains illustrative `example.test` URLs and local demo icons. Replace it with actual apps. Nothing in the dashboard queries or changes the proxy.

## Catalog contract

```json
{
  "apps": [
    {
      "name": "Photos",
      "url": "https://photos.example.test",
      "icon": "icons/photos.v1.svg"
    }
  ]
}
```

- `name`: required, nonempty display name.
- `url`: required, absolute HTTP(S) URL without embedded credentials. Paths and ports are supported. The host is displayed below the app name.
- `icon`: optional URL or path on the same origin as the catalog. Relative paths resolve beside the catalog. SVG, PNG, and other browser-supported image formats work. Missing or broken images fall back to initials. SVG files are displayed as images, never inserted as markup.

The catalog is fetched at runtime on each page load, with cache revalidation and a ten-second timeout. It is never imported into the JavaScript bundle. Apps are sorted alphabetically, searched by name or domain, and opened in new tabs. An empty array displays an empty state; an invalid catalog or unavailable file displays a retry action. There is no background polling.

The default source is `./apps.json`. Change the `apps-source` meta tag in `index.html` to configure its URL. Keep catalog and icon serving on the dashboard's origin. For a deployment under a URL prefix, use Vite's `--base` option and relative icon paths.

## Automation updates

During development, automation can write `public/apps.json` and `public/icons/`. The included Node server also uses `public/` by default. For the systemd service, automation writes to `BIFROST_DATA_DIR`, which contains `apps.json` and `icons/`. This directory is independent of frontend builds.

1. Write any new icons first. Use versioned filenames when replacing an icon, such as `photos.v2.svg`.
2. Generate and validate a complete catalog in a temporary file beside the served `apps.json`.
3. Atomically rename that file to `apps.json` on the same filesystem. Readers then see either the old or new complete catalog.
4. The next page load or browser refresh picks up the change, without a frontend rebuild.

Retain old icons while cached pages may still reference them. A directory mount is preferable to a single-file bind mount when automation uses atomic replacement.

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
| `BIFROST_DATA_DIR` | `public/` | Runtime `apps.json` and `icons/`. |

Relative directory settings resolve from the application root, independent of the process working directory. For example, `BIFROST_PORT=4311 npm start` changes only the built server's port.

The server revalidates files with `Cache-Control: no-cache` and reads catalog and icon changes on each request. Missing live files return 404 even if a sample exists in the build. It serves the app at the origin root; a reverse proxy mounting it under a prefix must strip that prefix, and the frontend must be built with the matching Vite `--base`.

Vite still copies `public/` into `dist/` for standalone previews. `npm run preview` is only for checking that static build locally. The frontend can also be hosted by any static web server without Node, provided it maps the live catalog and icons separately from the build.

## Linux lifecycle reference

`lifecycle.py` is a self-contained standard-library Python controller. Fleet runs it with trusted OS Python using `-I -S -B`.
The package version is `0.1.0`. Build and check release artifacts on a Center before publishing or deploying them.

The runtime archive extracts directly into an immutable release root. It contains `lifecycle.py`, `bin/node`, `server/`, `dist/`, production dependencies, and notices.
It contains no npm toolchain, configuration, runtime catalog, demo data, or database.
Fleet pins and verifies the archive checksum, retains prior releases, invokes install, and checks HTTP health before activation.

Each deployment command is a relative argument array:

```toml
[deployment.commands]
install = ["lifecycle.py", "install"]
restart = ["lifecycle.py", "restart"]
status = ["lifecycle.py", "status"]
logs = ["lifecycle.py", "logs"]
version = ["lifecycle.py", "version"]
```

`FLEET_RELEASE` identifies the absolute installed release root. Without it, the controller uses its own directory.
Production operations require Linux root and root-owned paths without symlinks, hard links, or group/other write access.
The controller validates the release tree and never executes Node. Systemd starts Node through `DynamicUser=yes`.
The unit retains strict filesystem protection, home protection, private temporary storage, and privilege restrictions.

Native configuration remains at `/etc/bifrost-dashboard/dashboard.env`. Install never writes this file or `/srv/bifrost-dashboard-data`.
Missing configuration fails with a provisioning message. The accepted format is one `KEY=value` assignment per line, with optional matching quotes.
Blank lines and full-line comments are accepted. Escapes, inline comments, duplicate keys, and unknown settings are unsupported.
`BIFROST_HOST` must be a loopback IP address. `BIFROST_PORT` must be between 1024 and 65535.
`BIFROST_DATA_DIR` must be an absolute simple path outside the release, home directories, and temporary directories.
Defaults are `127.0.0.1`, `4310`, and `/srv/bifrost-dashboard-data`.
Legacy `BIFROST_NODE_BIN`, `BIFROST_APP_DIR`, and `BIFROST_BUILD_DIR` assignments are accepted but do not select executable code.

The controller validates configuration and embeds the accepted settings in the generated unit.
Executable and build paths always refer to the selected release, regardless of legacy path settings.
Configuration edits take effect on the next `install` or `restart`. Restart verifies ownership before regenerating the unit and does not enable a disabled service.
Catalog changes remain visible without installation or restart. Automation retains ownership of catalog data and icons.
Data files must be readable by the service identity. No schema or database migrations run.

Install writes `/etc/systemd/system/bifrost-dashboard.service` and `/var/lib/bifrost-dashboard/ownership.json` atomically, under a lifecycle lock.
The ownership record stores the selected release, validated settings, and expected unit checksum.
Install reloads systemd, enables and restarts the service, and requires `is-active` success.
That result describes the system manager's report. Fleet's separate HTTP health check determines application health.
Repeated installs converge the same unit and preserve native data.

An existing unit without an ownership record is foreign. Adoption requires `install --adopt-unit-sha256 HASH` with its exact reviewed SHA-256.
No legacy hash grants implicit adoption. Vendor fragments and drop-ins are refused, including during adoption.
Install, restart, status, and logs reject unit drift, unsafe ownership, or mismatched ownership metadata.
Status and logs invoke real `systemctl` and `journalctl`. `logs --lines N` accepts 1 through 10000, defaulting to 50.
Manager errors and timeouts return failure. Version prints only the package version, `0.1.0`.

Manager commands share a 30-second operation budget, with a separate 20-second recovery budget. Each command is bounded to 20 seconds. A failed manager action restores the prior unit and ownership bytes, reloads systemd, and attempts to restart the prior unit.
If no prior unit existed, recovery removes candidate metadata and attempts to stop the failed service.
Recovery reverses enabling when the unit was previously disabled and leaves a previously stopped service stopped. Recovery errors are reported separately and require manager inspection.
A manager timeout can leave a systemd job running. Metadata restoration does not prove process recovery.
A process interruption or power loss between atomic file replacements can require manual reconciliation of unit and ownership metadata.

Fleet can invoke a retained prior release's `install` after a candidate health failure.
Install verifies the current app-owned record before replacing it. It permits both forward switches and prior-release reinstalls.
Other commands reject a controller whose release differs from the installed unit.
Keep retained release directories until recovery is verified. On drift, inspect and restore the reviewed unit and matching ownership record before retrying.
Do not erase the ownership record to bypass a drift error.

`--fixture-root ABSOLUTE_PATH` redirects OS paths into an isolated test directory, using its owner's UID.
Fixture managers must exist inside that directory at `usr/bin/systemctl` and `usr/bin/journalctl`.
This mode never falls back to host managers. It provides filesystem tests without granting installation authority.

## Checks

```sh
npm run check
npx playwright install chromium
npm run test:browser
```

Linux browser checks also need Chromium's system libraries; on a development or CI machine that permits package installation, `npx playwright install --with-deps chromium` installs them. Browser tests run against the production build and cover runtime catalog updates, search, load failures, icon fallback, unsafe text, and narrow-screen layout.

`npm test` also exercises the built server's file routing, cache headers, runtime updates, missing files, and occupied ports. The deploy unit is an illustrative template. Validate a controller-rendered unit with `systemd-analyze verify` in isolated Linux checks.

The original static design studies remain in `designs/` and are not part of the production build.

## Privacy boundary

Release artifacts contain application code and dependency notices. Runtime artifacts exclude the sample catalog, icons, environment files, and mutable data. Publish only illustrative source examples. Keep actual service catalogs and deployment configuration outside the release source and runtime artifacts. The dashboard reads its configured catalog and does not discover services or write catalog data.

## License and artwork

The application is licensed under the [MIT License](LICENSE), copyright 2026 Drew Butler. Package metadata retains `private: true`; these artifacts are not an npm publication.

The 12 demo SVGs and corresponding inline design-study marks are newly authored generic geometric examples. They replace artwork whose provenance was unverified. No provenance claim is made for the replaced artwork. The application brand remains unchanged and contains no embedded demo marks. Third-party dependencies retain their own licenses and copyright notices; the application license does not replace those terms.
