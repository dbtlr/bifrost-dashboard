# Service commands

`server/service.ts` installs and controls the dashboard as a systemd service on Linux. Run it with Node.js 24 from the release you want the service to run:

```sh
sudo node server/service.ts install
```

The **release** is the directory that contains the script's `server/` directory, with symbolic links resolved. The service runs the dashboard from that release, so a deployment tool installs a new release, or rolls back to an earlier one, by running that release's `server/service.ts install`.

The commands trust the release and the configuration file: root runs the release's code, and the configuration chooses the program the service runs. Keep both writable only by root.

## Commands

| Command | Root | Effect |
| --- | --- | --- |
| `install [--force]` | yes | Writes the unit, reloads systemd, enables the service, restarts it, and checks that it is active. |
| `restart` | yes | Rewrites the installed unit from the current configuration, reloads systemd, restarts the service, and checks that it is active. It refuses when the installed unit runs a different release; use `install` to switch releases. It does not enable a disabled service. |
| `status` | no | Runs `systemctl status bifrost-dashboard.service --no-pager` and exits with its exit code. |
| `logs [--lines N]` | yes | Runs `journalctl -u bifrost-dashboard.service -n N --no-pager`. `N` is 1 to 10000; the default is 50. Root is required because `journalctl` shows other users nothing and still succeeds. |
| `version` | no | Prints the release's `package.json` version. |
| `unit` | no | Prints the unit that `install` would write. It reads and validates the configuration but changes nothing. |
| `uninstall [--force]` | yes | Stops and disables the service, removes the unit if present, and reloads systemd. Running it again after a partial failure completes it: without a unit file, a failure to stop or disable a unit systemd no longer knows counts as done. It never removes the data directory or the configuration file. |

Commands marked "Root" require the effective user to be root. They fail before any change otherwise.

On success, `install` and `restart` print `bifrost-dashboard.service is active`. "Active" is systemd's report only. An HTTP health check of the dashboard remains the caller's job.

### Exit status

| Status | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | The command failed, and the service is as it was before: nothing changed, or `install` or `restart` restored the previous state. |
| 2 | Usage error, such as an unknown command or an out-of-range `--lines`. Nothing changed. |
| 4 | The command failed after changing the service, and the previous state is not restored: recovery after `install` or `restart` failed, or `uninstall` stopped partway. Inspect the service before retrying. |

`status` is the exception: it passes through `systemctl`'s exit code (3 means inactive).

A failure prints `bifrost-dashboard: <reason>` to standard error. When recovery ran, or `uninstall` stopped partway, the message also says which steps completed.

The commands run `/usr/bin/systemctl` and `/usr/bin/journalctl` by absolute path, with an argument list, no shell, and a minimal environment. Each call has a 30-second limit; a call that exceeds it fails the command.

## Configuration

The commands read `/etc/bifrost-dashboard/dashboard.env`. If the file does not exist, every setting takes its default. If it exists but is not a regular file or cannot be read, the command fails.

| Setting | Default | Rule |
| --- | --- | --- |
| `BIFROST_HOST` | `127.0.0.1` | A loopback IP address: `::1`, or IPv4 with first part `127`, written as four decimal parts from 0 to 255 without leading zeros. The API has no authentication, so the service listens only on loopback behind the reverse proxy. |
| `BIFROST_PORT` | `4310` | An integer from 1024 to 65535. |
| `BIFROST_DATA_DIR` | `/var/lib/bifrost-dashboard` | `/var/lib/bifrost-dashboard`, or `/var/lib/bifrost-dashboard-NAME` where `NAME` is not empty and uses letters, digits, `_`, `.`, and `-`. See [Data](#data). |
| `BIFROST_NODE_BIN` | The Node.js binary running the command | The absolute path of the Node.js binary the service runs. |

A leading byte order mark is ignored. After surrounding whitespace is removed, each line is blank, a comment starting with `#`, or `KEY=value` where `KEY` is uppercase letters, digits, and `_`, starting with a letter. A value may be wrapped in matching single or double quotes, which are removed. Escapes, inline comments, and `export` are not supported.

These fail the command and name the line or setting: a malformed line, a repeated setting, a value that breaks its rule, and any `BIFROST_` setting not listed here, which is most likely a misspelling. Two settings from earlier versions, `BIFROST_APP_DIR` and `BIFROST_BUILD_DIR`, are ignored with a warning: the release determines both. Other keys are ignored with a warning.

The release and `BIFROST_NODE_BIN`, after symbolic links are resolved, must be absolute paths that use only letters, digits, `_`, `.`, `/`, and `-`, with no `.` or `..` segment. This keeps them literal in the unit file, where `%`, `$`, spaces, and line breaks have special meaning. Values are written into the unit only after they pass these rules.

Configuration changes take effect on the next `install` or `restart`. The unit these commands write embeds the validated settings instead of reading the file at start. Drop-in files can still override them; see [The unit](#the-unit).

The commands do not check the version of `BIFROST_NODE_BIN`. A Node.js that cannot run the dashboard shows up as a service that keeps restarting, which the caller's health check reports.

## Release checks

`install`, `restart`, and `unit` refuse a release that lacks any of `package.json`, `deploy/bifrost-dashboard.service`, `server/start.ts`, `src/app-rules.ts`, `dist/index.html`, or `node_modules/`. Run `npm ci` and `npm run build` first. A release that installs from npm can drop development dependencies afterward with `npm prune --omit=dev`.

The unit hides `/home`, `/root`, `/run/user`, `/tmp`, and `/var/tmp` from the service. The release and `BIFROST_NODE_BIN`, with symbolic links resolved, must be outside them. The error names the resolved path.

The release must not overlap the data directory. With `STATE` the last part of `BIFROST_DATA_DIR`, such as `bifrost-dashboard`, the resolved release must not be inside `/var/lib/STATE` or `/var/lib/private/STATE`, and must not contain either. systemd keeps a dynamic user's data in `/var/lib/private/STATE`, and the data directory may not exist yet, so the check compares against these fixed paths, with symbolic links resolved in the part of each that exists. Otherwise the database would live in a disposable release, or the service could write release code.

## The unit

`install` renders the release's `deploy/bifrost-dashboard.service` and writes it to `/etc/systemd/system/bifrost-dashboard.service`. The template sets `NODE_ENV=production`, `BIFROST_HOST`, `BIFROST_PORT`, and `BIFROST_DATA_DIR`, and no other environment. Its placeholders are:

| Placeholder | Value |
| --- | --- |
| `@RELEASE@` | The release directory, used for `WorkingDirectory` and the server path. The server finds `dist/` inside it. |
| `@NODE@` | `BIFROST_NODE_BIN`, with symbolic links resolved. |
| `@HOST@`, `@PORT@` | `BIFROST_HOST` and `BIFROST_PORT`. |
| `@DATA_DIR@` | `BIFROST_DATA_DIR`. |
| `@STATE_DIRECTORY@` | The last part of `BIFROST_DATA_DIR`, such as `bifrost-dashboard`. |

The rendered unit's first line is `# Managed by bifrost-dashboard server/service.ts`. `install` and `uninstall` refuse to replace or remove an existing unit without that line unless given `--force`, so they do not destroy a unit written by hand or by another tool. They refuse a unit path that is a symbolic link, including a masked unit, even with `--force`; unmask it first.

`restart` requires an installed unit with that line and exactly one `WorkingDirectory` line, and reads the installed release from it. It ignores drop-ins for this.

`install` and `restart` write the unit atomically. They write a temporary file in the same directory whose name does not end in `.service`, set its mode to `0644`, flush it to disk, and rename it over the unit. A reader sees the old unit or the new one, never a partial file. A temporary file left by an interrupted run is harmless; systemd ignores it.

If a step after the write fails, they restore the previous state in this order:

1. A service that was not active before is stopped, which also cancels a start job that is still queued. A service that was not enabled before (`systemctl is-enabled` did not report `enabled`) is disabled.
2. The previous unit is put back, or the new unit is removed when none existed. Then systemd is reloaded.
3. A service that was active before is restarted.

The exit status then says whether that recovery succeeded.

Drop-in files in `/etc/systemd/system/bifrost-dashboard.service.d/` are left alone and apply as usual, including any setting they override. Checking them is the job of whoever manages them.

## Data

The data directory is limited to names starting with `bifrost-dashboard` because systemd takes over a `StateDirectory`: with a dynamic user, it moves an existing directory to `/var/lib/private/` and changes its owner. Any other name could hand another program's data to the dashboard.

The service creates `bifrost.sqlite` and `icons/` in `BIFROST_DATA_DIR` on first start. If that directory holds a legacy `apps.json` and no database, the first start imports it once; see [Storage](api.md#storage) in the API reference. The commands never write, move, or delete data themselves. Back up the data directory while the service is stopped.

Earlier versions kept data in `/srv/bifrost-dashboard-data`, which these commands reject as a data directory. While that directory exists, `install` and `restart` also refuse a data directory that holds neither `bifrost.sqlite` nor `apps.json`, so the service never starts with an empty catalog while the old data waits elsewhere. To move such an installation:

1. Stop the service.
2. Copy everything in `/srv/bifrost-dashboard-data` into `/var/lib/bifrost-dashboard`, including `bifrost.sqlite` if it exists, `apps.json`, and `icons/`. The database, when present, holds every change made since the import.
3. Remove `BIFROST_DATA_DIR` from the configuration, or set it to `/var/lib/bifrost-dashboard`.
4. Run `install`. A unit that an earlier tool wrote lacks the managed line, so the first install needs `--force`.
5. Once the dashboard shows the expected catalog, archive or remove `/srv/bifrost-dashboard-data`. While it exists, `install` and `restart` keep refusing a data directory without a catalog.

## Testing

`--root DIR` redirects every system path into `DIR`: the configuration file, the unit directory, the data directory and legacy data directory it checks, and the managers, which must be at `DIR/usr/bin/systemctl` and `DIR/usr/bin/journalctl`. It skips the root-user check and the hidden-location checks, so tests can run from a checkout. It never falls back to the host's managers. The commands refuse `--root` when run as root and refuse a `DIR` that resolves to `/`, so it cannot be used to run a test directory's programs as root. Tests that run the commands therefore need a non-root user.
