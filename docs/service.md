# Service commands

`server/service.ts` installs and controls the dashboard as a systemd service on Linux. Run it with Node.js 24 from the release you want the service to run:

```sh
sudo node server/service.ts install
```

The **release** is the directory that contains the script's `server/` directory. The service runs the dashboard from that release, so a deployment tool installs a new release by running that release's `server/service.ts install`.

## Commands

| Command | Root | Effect |
| --- | --- | --- |
| `install [--force]` | yes | Writes the unit, reloads systemd, enables the service, restarts it, and checks that it is active. |
| `restart` | yes | Rewrites the unit from the current configuration and release, reloads systemd, restarts the service, and checks that it is active. It does not enable a disabled service. |
| `status` | no | Runs `systemctl status bifrost-dashboard.service --no-pager` and exits with its exit code. |
| `logs [--lines N]` | no | Runs `journalctl -u bifrost-dashboard.service -n N --no-pager`. `N` is 1 to 10000; the default is 50. |
| `version` | no | Prints the release's `package.json` version. |
| `unit` | no | Prints the unit that `install` would write. It reads and validates the configuration but changes nothing. |
| `uninstall [--force]` | yes | Stops and disables the service, removes the unit, and reloads systemd. It never removes the data directory or the configuration file. |

Commands marked "Root" require the effective user to be root. They fail before any change otherwise.

On success, `install` and `restart` print `bifrost-dashboard.service is active`. "Active" is systemd's report only. An HTTP health check of the dashboard remains the caller's job.

Any failure prints one line, `bifrost-dashboard: <reason>`, to standard error and exits with status 1. `status` is the exception: it passes through `systemctl`'s exit code (3 means inactive). A usage error, such as an unknown command or an out-of-range `--lines`, exits with status 2.

Each `systemctl` or `journalctl` call has a 30-second limit. A call that exceeds it fails the command.

## Configuration

The commands read `/etc/bifrost-dashboard/dashboard.env`. The file is optional; without it, every setting takes its default.

| Setting | Default | Rule |
| --- | --- | --- |
| `BIFROST_HOST` | `127.0.0.1` | A loopback IPv4 or IPv6 address. The API has no authentication, so the service listens only on loopback behind the reverse proxy. |
| `BIFROST_PORT` | `4310` | An integer from 1024 to 65535. |
| `BIFROST_DATA_DIR` | `/var/lib/bifrost-dashboard` | A directory under `/var/lib/`. The unit sets `StateDirectory` to the part after `/var/lib/`, so systemd creates it and makes it writable for the service's dynamic user. |
| `BIFROST_NODE_BIN` | The Node.js binary running the command | The absolute path of the Node.js binary the service runs. |

Each line is blank, a comment starting with `#`, or `KEY=value`. A value may be wrapped in matching single or double quotes, which are removed. Escapes and inline comments are not supported.

A malformed line, a repeated setting, or a value that breaks its rule fails the command and names the setting. `BIFROST_APP_DIR` and `BIFROST_BUILD_DIR` are accepted for compatibility and ignored with a warning: the release determines both. Any other `BIFROST_` setting, or any other key, is ignored with a warning.

Paths in the unit (the release, `BIFROST_DATA_DIR`, and `BIFROST_NODE_BIN`) must be absolute and use only letters, digits, `_`, `.`, `/`, and `-`, with no `..` segment. This keeps them literal in the unit file, where `%` and spaces have special meaning.

Configuration changes take effect on the next `install` or `restart`. The unit embeds the validated settings instead of reading the file at start, so systemd never starts the service with settings these commands did not check.

## Release checks

`install`, `restart`, and `unit` refuse a release that lacks any of `package.json`, `server/start.ts`, `src/app-rules.ts`, `dist/index.html`, or `node_modules/`. Run `npm ci` and `npm run build` first. A release that installs from npm can drop development dependencies afterward with `npm prune --omit=dev`.

The release and `BIFROST_NODE_BIN` must be outside `/home`, `/root`, and `/tmp`, because the unit hides those directories from the service.

## The unit

`install` renders `deploy/bifrost-dashboard.service` from the release and writes it to `/etc/systemd/system/bifrost-dashboard.service`. The template's placeholders are:

| Placeholder | Value |
| --- | --- |
| `@RELEASE@` | The release directory. `WorkingDirectory`, the server path, and `BIFROST_BUILD_DIR` (`@RELEASE@/dist`) use it. |
| `@NODE@` | `BIFROST_NODE_BIN`. |
| `@HOST@`, `@PORT@` | `BIFROST_HOST` and `BIFROST_PORT`. |
| `@DATA_DIR@` | `BIFROST_DATA_DIR`. |
| `@STATE_DIRECTORY@` | `BIFROST_DATA_DIR` without its leading `/var/lib/`. |

The rendered unit's first line is `# Managed by bifrost-dashboard server/service.ts`. `install` and `uninstall` refuse to replace or remove an existing unit without that line unless given `--force`, so they do not destroy a unit written by hand or by another tool. `restart` requires an installed unit with that line.

`install` writes the unit atomically: a reader sees the old unit or the new one, never a partial file. If a later step fails, `install` and `restart` put back the previous unit (or remove the new one when none existed), reload systemd, and restart the service if it was active before. The error then reports the original failure and whether that recovery succeeded.

Drop-in files in `/etc/systemd/system/bifrost-dashboard.service.d/` are left alone and apply as usual.

## Data

The service creates `bifrost.sqlite` and `icons/` in `BIFROST_DATA_DIR` on first start. If that directory holds a legacy `apps.json`, the first start imports it once; see [Storage](api.md#storage) in the API reference. The commands never write, move, or delete data. Back up the data directory while the service is stopped.

## Testing

`--root DIR` redirects every system path into `DIR`: the configuration file, the unit directory, and the managers, which must be at `DIR/usr/bin/systemctl` and `DIR/usr/bin/journalctl`. It skips the root-user check and the `/home`, `/root`, and `/tmp` location checks, so tests can run from a checkout. It never falls back to the host's managers. It is for isolated tests only.
