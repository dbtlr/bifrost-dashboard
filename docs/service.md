# Service commands

`server/service.ts` installs and controls the dashboard as a systemd service on Linux. Run it with Node.js 24 from the release you want the service to run:

```sh
sudo node server/service.ts install
```

The **release** is the directory that contains the script's `server/` directory, with symbolic links resolved. The service runs the dashboard from that release, so a deployment tool installs a new release, or rolls back to an earlier one, by running that release's `server/service.ts install`.

The commands trust the release: root runs its code to install it. Keep release directories writable only by root.

## Commands

| Command | Root | Effect |
| --- | --- | --- |
| `install [--force]` | yes | Writes the unit, reloads systemd, enables the service, restarts it, and checks that it is active. |
| `restart` | yes | Rewrites the installed unit from the current configuration, reloads systemd, restarts the service, and checks that it is active. It refuses when the installed unit runs a different release; use `install` to switch releases. It does not enable a disabled service. |
| `status` | no | Runs `systemctl status bifrost-dashboard.service --no-pager` and exits with its exit code. |
| `logs [--lines N]` | yes | Runs `journalctl -u bifrost-dashboard.service -n N --no-pager`. `N` is 1 to 10000; the default is 50. Root is required because `journalctl` shows other users nothing and still succeeds. |
| `version` | no | Prints the release's `package.json` version. |
| `unit` | no | Prints the unit that `install` would write. It reads and validates the configuration but changes nothing. |
| `uninstall [--force]` | yes | Stops and disables the service, removes the unit, and reloads systemd. It never removes the data directory or the configuration file. |

Commands marked "Root" require the effective user to be root. They fail before any change otherwise.

On success, `install` and `restart` print `bifrost-dashboard.service is active`. "Active" is systemd's report only. An HTTP health check of the dashboard remains the caller's job.

### Exit status

| Status | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | The command failed. Nothing changed, or the previous unit and service state were restored. |
| 2 | Usage error, such as an unknown command or an out-of-range `--lines`. Nothing changed. |
| 4 | The command failed and restoring the previous state also failed. Inspect the service before retrying. |

`status` is the exception: it passes through `systemctl`'s exit code (3 means inactive).

A failure prints `bifrost-dashboard: <reason>` to standard error. When recovery ran, the message also reports what recovery did.

The commands run `/usr/bin/systemctl` and `/usr/bin/journalctl` by absolute path, with an argument list, no shell, and a minimal environment. Each call has a 30-second limit; a call that exceeds it fails the command.

## Configuration

The commands read `/etc/bifrost-dashboard/dashboard.env`. If the file does not exist, every setting takes its default. If it exists but is not a regular file or cannot be read, the command fails.

| Setting | Default | Rule |
| --- | --- | --- |
| `BIFROST_HOST` | `127.0.0.1` | A loopback IP address: IPv4 in `127.0.0.0/8` in dotted-decimal form, or `::1`. The API has no authentication, so the service listens only on loopback behind the reverse proxy. |
| `BIFROST_PORT` | `4310` | An integer from 1024 to 65535. |
| `BIFROST_DATA_DIR` | `/var/lib/bifrost-dashboard` | `/var/lib/bifrost-dashboard`, or `/var/lib/bifrost-dashboard-NAME` where `NAME` uses letters, digits, `_`, `.`, and `-`. See [Data](#data). |
| `BIFROST_NODE_BIN` | The Node.js binary running the command | The absolute path of the Node.js binary the service runs. |

Each line is blank, a comment starting with `#`, or `KEY=value`. A value may be wrapped in matching single or double quotes, which are removed. Escapes and inline comments are not supported.

These fail the command and name the line or setting: a malformed line, a repeated setting, a value that breaks its rule, and any `BIFROST_` setting not listed here, which is most likely a misspelling. Two settings from earlier versions, `BIFROST_APP_DIR` and `BIFROST_BUILD_DIR`, are ignored with a warning: the release determines both. Keys without the `BIFROST_` prefix are ignored with a warning.

The release and `BIFROST_NODE_BIN` must be absolute paths that use only letters, digits, `_`, `.`, `/`, and `-`, with no `.` or `..` segment. This keeps them literal in the unit file, where `%`, `$`, and spaces have special meaning. Settings are written into the unit only after they pass these rules.

Configuration changes take effect on the next `install` or `restart`. The unit embeds the validated settings instead of reading the file at start, so systemd never starts the service with settings these commands did not check.

## Release checks

`install`, `restart`, and `unit` refuse a release that lacks any of `package.json`, `server/start.ts`, `src/app-rules.ts`, `dist/index.html`, or `node_modules/`. Run `npm ci` and `npm run build` first. A release that installs from npm can drop development dependencies afterward with `npm prune --omit=dev`.

The unit hides `/home`, `/root`, `/run/user`, `/tmp`, and `/var/tmp` from the service. The release and `BIFROST_NODE_BIN`, with symbolic links resolved, must be outside them. The error names the resolved path.

The release and the data directory must not overlap: neither may be inside the other, with symbolic links resolved. Otherwise the database would live in a disposable release, or the service could write release code.

## The unit

`install` renders `deploy/bifrost-dashboard.service` from the release and writes it to `/etc/systemd/system/bifrost-dashboard.service`. The template's placeholders are:

| Placeholder | Value |
| --- | --- |
| `@RELEASE@` | The release directory, used for `WorkingDirectory` and the server path. The server finds `dist/` inside it. |
| `@NODE@` | `BIFROST_NODE_BIN`, with symbolic links resolved. |
| `@HOST@`, `@PORT@` | `BIFROST_HOST` and `BIFROST_PORT`. |
| `@DATA_DIR@` | `BIFROST_DATA_DIR`. |
| `@STATE_DIRECTORY@` | The last part of `BIFROST_DATA_DIR`, such as `bifrost-dashboard`. |

The rendered unit's first line is `# Managed by bifrost-dashboard server/service.ts`. `install` and `uninstall` refuse to replace or remove an existing unit without that line unless given `--force`, so they do not destroy a unit written by hand or by another tool. `restart` requires an installed unit with that line, and reads the installed release from its `WorkingDirectory`.

`install` and `restart` write the unit atomically. They write a temporary file in the same directory whose name does not end in `.service`, set its mode to `0644`, flush it to disk, and rename it over the unit. A reader sees the old unit or the new one, never a partial file.

If a later step fails, they restore the previous state:

- The previous unit is put back, or the new unit is removed when none existed. Then systemd is reloaded.
- A service that was not enabled before is disabled again.
- A service that was active before is restarted. A service that was not active before is stopped, which also cancels a start job that is still queued.

The exit status then says whether that recovery succeeded.

Drop-in files in `/etc/systemd/system/bifrost-dashboard.service.d/` are left alone and apply as usual.

## Data

The data directory is limited to names starting with `bifrost-dashboard` because systemd takes over a `StateDirectory`: with a dynamic user, it moves an existing directory to `/var/lib/private/` and changes its owner. Any other name could hand another program's data to the dashboard.

The service creates `bifrost.sqlite` and `icons/` in `BIFROST_DATA_DIR` on first start. If that directory holds a legacy `apps.json`, the first start imports it once; see [Storage](api.md#storage) in the API reference. The commands never write, move, or delete data themselves. Back up the data directory while the service is stopped.

Earlier versions used `/srv/bifrost-dashboard-data`, which these commands reject. To move such an installation, stop the service, copy its `apps.json` and `icons/` into `/var/lib/bifrost-dashboard`, set `BIFROST_DATA_DIR` accordingly or remove it, and run `install`.

## Testing

`--root DIR` redirects every system path into `DIR`: the configuration file, the unit directory, and the managers, which must be at `DIR/usr/bin/systemctl` and `DIR/usr/bin/journalctl`. It skips the root-user check and the hidden-location checks, so tests can run from a checkout. It never falls back to the host's managers. The commands refuse `--root` when run as root and refuse a `DIR` that resolves to `/`, so it cannot be used to run a test directory's programs as root.
