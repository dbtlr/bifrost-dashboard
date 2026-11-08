#!/usr/bin/python3
import argparse
import fcntl
import hashlib
import ipaddress
import re
import stat
import subprocess
import tempfile
import time
import json
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description='Bifrost dashboard system lifecycle')
    parser.add_argument('--fixture-root', type=Path, help='isolated filesystem with fixture managers only')
    sub = parser.add_subparsers(dest='action', required=True)
    install = sub.add_parser('install')
    install.add_argument('--adopt-unit-sha256')
    for action in ('restart', 'status', 'version'):
        sub.add_parser(action)
    logs = sub.add_parser('logs')
    logs.add_argument('--lines', type=int, choices=range(1, 10001), default=50, metavar='N')
    args = parser.parse_args()
    release = Path(os.environ.get('FLEET_RELEASE', str(Path(__file__).absolute().parent)))
    if args.action == 'version':
        print(json.loads((release / 'package.json').read_text())['version'])
        return
    operate(args, release)



SERVICE = 'bifrost-dashboard.service'


class System:
    def __init__(self, fixture):
        if fixture == Path('/'):
            raise ValueError('fixture root cannot be host root')
        self.root = fixture or Path('/')
        if not self.root.is_absolute() or '..' in self.root.parts:
            raise ValueError('root must be absolute and normalized')
        self.uid = os.geteuid() if fixture else 0
        if not fixture and (sys.platform != 'linux' or os.geteuid() != 0):
            raise ValueError('Linux root required; use --fixture-root only for isolated tests')
        self.deadline = time.monotonic() + 30
        self.secure(self.root)

    def secure(self, path):
        if not path.is_absolute() or '..' in path.parts or not path.is_relative_to(self.root):
            raise ValueError('unsafe path: ' + str(path))
        parts = [path, *path.parents]
        for part in reversed(parts[:parts.index(self.root) + 1]):
            st = part.lstat()
            if st.st_uid != self.uid or st.st_mode & 0o022 or stat.S_ISLNK(st.st_mode):
                raise ValueError('unsafe ownership, writable or symlinked path: ' + str(part))
            if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)) or st.st_mode & 0o7000:
                raise ValueError('unsafe file type or mode: ' + str(part))
            if stat.S_ISREG(st.st_mode) and st.st_nlink != 1:
                raise ValueError('hard-linked path: ' + str(part))
        return path

    def directory(self, path):
        if not path.exists():
            self.directory(path.parent)
            path.mkdir(mode=0o755)
        self.secure(path)
        if not path.is_dir():
            raise ValueError('directory required: ' + str(path))

    def atomic(self, path, data):
        self.directory(path.parent)
        if os.path.lexists(path):
            self.secure(path)
        fd, temporary = tempfile.mkstemp(prefix='.lifecycle-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fchmod(stream.fileno(), 0o644)
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def manager(self, program, *args, allowed=(0,)):
        executable = self.secure(self.root / ('usr/bin/' + program))
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('system manager operation budget exhausted')
        try:
            result = subprocess.run([str(executable), *args], env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}, capture_output=True, text=True, timeout=min(20, remaining))
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(program + ' timed out; manager state needs inspection') from error
        if result.returncode not in allowed:
            raise RuntimeError(program + ' ' + args[0] + ' failed: ' + result.stderr.strip())
        return result


def path_value(value):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in Path(value).parts or '%' in value:
        raise ValueError('absolute simple path required: ' + value)
    return value


def configuration(system, release):
    path = system.root / 'etc/bifrost-dashboard/dashboard.env'
    try:
        system.secure(path)
    except FileNotFoundError as error:
        raise ValueError('missing dashboard.env; provision native configuration before install') from error
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'(BIFROST_(?:HOST|PORT|DATA_DIR|NODE_BIN|APP_DIR|BUILD_DIR))=(.*)', line)
        if not match or match[1] in values:
            raise ValueError('malformed, duplicate or unsupported dashboard.env setting')
        value = match[2]
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[match[1]] = value
    host = values.get('BIFROST_HOST', '127.0.0.1')
    if not ipaddress.ip_address(host).is_loopback:
        raise ValueError('BIFROST_HOST must be a loopback address')
    port = values.get('BIFROST_PORT', '4310')
    if not port.isascii() or not port.isdecimal() or not 1024 <= int(port) <= 65535:
        raise ValueError('BIFROST_PORT must be an unprivileged port 1024..65535')
    data = path_value(values.get('BIFROST_DATA_DIR', '/srv/bifrost-dashboard-data'))
    if Path(data).is_relative_to(release) or data == '/' or Path(data).parts[1] in ('home', 'root', 'tmp'):
        raise ValueError('data must be separate from release and accessible outside home')
    return {'host': host, 'port': str(int(port)), 'data': data}


def unit_bytes(release, config):
    path_value(str(release))
    return (f"""[Unit]
Description=Bifrost app dashboard
After=network.target

[Service]
Type=exec
WorkingDirectory={release}
Environment="NODE_ENV=production"
Environment="BIFROST_HOST={config['host']}"
Environment="BIFROST_PORT={config['port']}"
Environment="BIFROST_DATA_DIR={config['data']}"
Environment="BIFROST_APP_DIR={release}"
Environment="BIFROST_BUILD_DIR={release}/dist"
ExecStart={release}/bin/node {release}/server/start.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
""").encode()


def operate(args, release):
    system = System(args.fixture_root)
    system.secure(release)
    if not args.fixture_root and any(release.is_relative_to(Path(p)) for p in ('/home', '/root', '/tmp')):
        raise ValueError('immutable release must be outside home and temporary directories')
    for path in release.rglob('*'):
        system.secure(path)
    for name in ('bin/node', 'server/start.ts', 'dist/index.html', 'package.json'):
        if not system.secure(release / name).is_file():
            raise ValueError('incomplete release: ' + name)
    unit = system.root / 'etc/systemd/system' / SERVICE
    state = system.root / 'var/lib/bifrost-dashboard/ownership.json'
    system.directory(state.parent)
    lock_path = state.parent / '.lock'
    if os.path.lexists(lock_path):
        system.secure(lock_path)
    with lock_path.open('a') as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        old_unit = system.secure(unit).read_bytes() if os.path.lexists(unit) else None
        old_state = system.secure(state).read_bytes() if os.path.lexists(state) else None
        fragment = system.manager('systemctl', 'show', SERVICE, '--property=FragmentPath', '--value').stdout.strip()
        drops = system.manager('systemctl', 'show', SERVICE, '--property=DropInPaths', '--value').stdout.strip()
        if drops or (fragment and fragment != str(unit)):
            raise ValueError('foreign unit fragment or drop-ins; refusing service control')
        if old_state is not None:
            record = json.loads(old_state)
            if not isinstance(record, dict):
                raise ValueError('malformed ownership record')
            if record.get('application') != 'bifrost-dashboard' or record.get('schema') != 1:
                raise ValueError('foreign ownership record')
            expected = unit_bytes(Path(record['release']), record['config'])
            if old_unit != expected or hashlib.sha256(expected).hexdigest() != record.get('unit_sha256'):
                raise ValueError('owned unit drift; inspect unit and ownership record before recovery')
        else:
            if fragment and old_unit is None:
                raise ValueError('foreign loaded unit without on-disk bytes; inspect manager state')
            if args.action != 'install':
                raise ValueError('missing application ownership record; install first')
            if old_unit is not None:
                supplied = args.adopt_unit_sha256 or ''
                if not re.fullmatch('[a-f0-9]{64}', supplied) or hashlib.sha256(old_unit).hexdigest() != supplied:
                    raise ValueError('foreign existing unit; explicit --adopt-unit-sha256 matching reviewed bytes required')
        if args.action != 'install':
            if record['release'] != str(release):
                raise ValueError('controller release differs from installed service; reinstall selected release')
        if args.action not in ('install', 'restart'):
            if args.action == 'logs':
                result = system.manager('journalctl', '-u', SERVICE, '-n', str(args.lines), '--no-pager')
            else:
                result = system.manager('systemctl', args.action, SERVICE, '--no-pager')
            print(result.stdout, end='')
            return
        config = configuration(system, release)
        desired = unit_bytes(release, config)
        record = {'application': 'bifrost-dashboard', 'schema': 1, 'release': str(release), 'config': config, 'unit_sha256': hashlib.sha256(desired).hexdigest()}
        enabled = system.manager('systemctl', 'is-enabled', SERVICE, allowed=(0, 1, 3, 4)).returncode == 0
        active = system.manager('systemctl', 'is-active', SERVICE, allowed=(0, 3, 4)).returncode == 0
        try:
            system.atomic(unit, desired)
            system.atomic(state, (json.dumps(record, sort_keys=True, indent=2) + '\n').encode())
            system.manager('systemctl', 'daemon-reload')
            if args.action == 'install':
                system.manager('systemctl', 'enable', SERVICE)
            system.manager('systemctl', 'restart', SERVICE)
            system.manager('systemctl', 'is-active', SERVICE)
        except Exception as failure:
            system.deadline = time.monotonic() + 20
            # Restore the prior authority before asking the manager to recover it.
            for path, previous in ((unit, old_unit), (state, old_state)):
                if previous is None:
                    if os.path.lexists(path):
                        system.secure(path).unlink()
                else:
                    system.atomic(path, previous)
            try:
                if not enabled:
                    system.manager('systemctl', 'disable', SERVICE)
                system.manager('systemctl', 'daemon-reload')
                if old_unit is not None and active:
                    system.manager('systemctl', 'restart', SERVICE)
                else:
                    system.manager('systemctl', 'stop', SERVICE)
            except Exception as recovery:
                raise RuntimeError(str(failure) + '; metadata restored but manager recovery failed: ' + str(recovery)) from failure
            raise RuntimeError(str(failure) + '; prior metadata restored; inspect manager state') from failure
        print('System manager reports active (HTTP health remains caller-owned)')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        print('bifrost-dashboard: ' + str(error), file=sys.stderr)
        sys.exit(1)
