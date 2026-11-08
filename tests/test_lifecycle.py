import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CONTROLLER = Path(__file__).resolve().parents[1] / 'lifecycle.py'


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=CONTROLLER.parent.parent)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.release = self.root / 'opt/releases/first'
        self.release.mkdir(parents=True)
        (self.release / 'package.json').write_text('{"version":"0.1.0"}')
        for name in ['bin/node', 'server/start.ts', 'dist/index.html']:
            p = self.release / name
            p.parent.mkdir(exist_ok=True)
            p.write_text('synthetic')
        self.env = self.root / 'etc/bifrost-dashboard/dashboard.env'
        self.env.parent.mkdir(parents=True)
        self.env.write_text('BIFROST_HOST=127.0.0.2\nBIFROST_PORT=4321\nBIFROST_DATA_DIR=/srv/bifrost-dashboard-data\nBIFROST_NODE_BIN=/old/node\nBIFROST_APP_DIR=/old\nBIFROST_BUILD_DIR=/old/dist\n')
        self.unit = self.root / 'etc/systemd/system/bifrost-dashboard.service'
        self.unit.parent.mkdir(parents=True)
        self.state = self.root / 'var/lib/bifrost-dashboard/ownership.json'
        self.manager = self.root / 'usr/bin/systemctl'
        self.manager.parent.mkdir(parents=True)
        self.manager.write_text('#!' + sys.executable + '\nimport pathlib,sys\np=pathlib.Path(__file__).parents[2]\na=sys.argv[1:]\nwith (p/"calls").open("a") as f:f.write(" ".join(a)+"\\n")\nif (p/"fail").exists() and a[0]==(p/"fail").read_text():sys.exit(9)\nif a[0]=="is-enabled":sys.exit(1)\nif a[0]=="status":print("active fixture")\n')
        self.manager.chmod(0o755)
        (self.manager.parent / 'journalctl').write_bytes(self.manager.read_bytes())
        (self.manager.parent / 'journalctl').chmod(0o755)

    def run_cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, '-I', '-S', '-B', str(CONTROLLER), '--fixture-root', str(self.root), *args], env={'FLEET_RELEASE': str(self.release)}, text=True, capture_output=True, timeout=15)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_version_and_log_bounds(self):
        self.assertEqual('0.1.0', self.run_cli('version').stdout.strip())
        for value in ['0', '-1', '10001', 'bad']:
            self.run_cli('logs', '--lines', value, ok=False)
        self.assertFalse((self.root / 'calls').exists())

    def test_install_preserves_data_and_converges_hardened_unit(self):
        data = self.root / 'srv/bifrost-dashboard-data'
        data.mkdir(parents=True)
        (data / 'apps.json').write_text('private catalog sentinel')
        before = self.env.read_bytes()
        self.run_cli('install')
        unit = self.unit.read_text()
        for setting in ['DynamicUser=yes', 'ProtectHome=yes', 'ProtectSystem=strict', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'Restart=on-failure', 'BIFROST_HOST=127.0.0.2', 'BIFROST_PORT=4321', str(self.release / 'bin/node')]:
            self.assertIn(setting, unit)
        self.assertNotIn('/old', unit)
        self.assertEqual(self.env.read_bytes(), before)
        self.assertEqual((data / 'apps.json').read_text(), 'private catalog sentinel')
        saved = self.state.read_bytes()
        self.run_cli('install')
        self.assertEqual(self.state.read_bytes(), saved)
        self.assertEqual(self.unit.read_text(), unit)
        self.assertIn('active fixture', self.run_cli('status').stdout)
        self.run_cli('logs', '--lines', '10000')
        self.assertIn('-n 10000', (self.root / 'calls').read_text())

    def test_foreign_unit_requires_exact_explicit_hash(self):
        self.unit.write_text('[Service]\nExecStart=/usr/bin/foreign\n')
        original = self.unit.read_bytes()
        self.run_cli('install', ok=False)
        self.run_cli('install', '--adopt-unit-sha256', '0' * 64, ok=False)
        self.assertEqual(self.unit.read_bytes(), original)
        self.assertFalse(self.state.exists())
        self.run_cli('install', '--adopt-unit-sha256', hashlib.sha256(original).hexdigest())
        self.run_cli('status')
        self.unit.write_text('foreign replacement')
        for action in ['install', 'restart', 'status', 'logs']:
            self.run_cli(action, ok=False)
        self.assertEqual(self.unit.read_text(), 'foreign replacement')

    def test_new_release_and_prior_installer_recovery(self):
        self.run_cli('install')
        first = self.release
        before = self.unit.read_bytes()
        import shutil
        self.release = self.release.parent / 'second'
        shutil.copytree(first, self.release)
        self.run_cli('install')
        self.assertIn(str(self.release), self.unit.read_text())
        self.release = first
        self.run_cli('status', ok=False)
        self.run_cli('install')
        self.assertEqual(self.unit.read_bytes(), before)
        self.run_cli('restart')

    def test_manager_failures_restore_prior_unit_and_metadata(self):
        self.run_cli('install')
        before = (self.unit.read_bytes(), self.state.read_bytes())
        self.env.write_text('BIFROST_PORT=4322\n')
        for action in ['daemon-reload', 'enable', 'restart', 'is-active']:
            (self.root / 'fail').write_text(action)
            self.run_cli('install', ok=False)
            self.assertEqual((self.unit.read_bytes(), self.state.read_bytes()), before)
        (self.root / 'fail').unlink()
        self.run_cli('install')
        self.assertIn('BIFROST_PORT=4322', self.unit.read_text())

    def test_failed_first_install_and_adoption_restore_original(self):
        (self.root / 'fail').write_text('restart')
        self.run_cli('install', ok=False)
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.state.exists())
        self.unit.write_text('legacy bytes')
        before = self.unit.read_bytes()
        self.run_cli('install', '--adopt-unit-sha256', hashlib.sha256(before).hexdigest(), ok=False)
        self.assertEqual(self.unit.read_bytes(), before)
        self.assertFalse(self.state.exists())

    def test_failed_install_restores_a_previously_stopped_service(self):
        self.run_cli('install')
        before = (self.unit.read_bytes(), self.state.read_bytes())
        self.manager.write_text(self.manager.read_text() + '\nif a[0]=="is-active":sys.exit(3)\n')
        (self.root / 'calls').write_text('')
        (self.root / 'fail').write_text('restart')
        self.run_cli('install', ok=False)
        self.assertEqual((self.unit.read_bytes(), self.state.read_bytes()), before)
        self.assertEqual((self.root / 'calls').read_text().splitlines()[-1], 'stop bifrost-dashboard.service')

    def test_configuration_errors_do_not_change_unit(self):
        for content in ['BIFROST_PORT=no', 'BIFROST_PORT=80', 'BIFROST_HOST=0.0.0.0', 'BIFROST_DATA_DIR=relative', 'BIFROST_DATA_DIR=/home/user/data', 'NODE_OPTIONS=--inspect', 'BIFROST_PORT=4310\nBIFROST_PORT=4320', 'garbage', 'BIFROST_DATA_DIR=' + str(self.release / 'data')]:
            self.env.write_text(content)
            self.run_cli('install', ok=False)
            self.assertFalse(self.unit.exists())
        self.env.unlink()
        self.run_cli('install', ok=False)
        self.assertFalse(self.state.exists())

    def test_symlink_writable_and_hardlink_paths_refused(self):
        self.env.chmod(0o666)
        self.run_cli('install', ok=False)
        self.env.chmod(0o644)
        self.unit.symlink_to(self.env)
        self.run_cli('install', ok=False)
        self.unit.unlink()
        os.link(self.env, self.unit)
        self.run_cli('install', ok=False)
        self.unit.unlink()
        self.run_cli('install')
        self.state.chmod(0o666)
        self.run_cli('restart', ok=False)

    def test_foreign_loaded_fragment_or_dropins_refused(self):
        original = self.manager.read_text()
        for prop, output in [('FragmentPath', '/usr/lib/systemd/system/bifrost-dashboard.service'), ('DropInPaths', '/etc/systemd/system/bifrost-dashboard.service.d/override.conf')]:
            self.manager.write_text(original + '\nif "--property=' + prop + '" in a:print(' + repr(output) + ')\n')
            self.run_cli('install', ok=False)
            self.assertFalse(self.unit.exists())

    def test_manager_read_failures_and_missing_ownership_are_honest(self):
        self.run_cli('status', ok=False)
        self.run_cli('install')
        for action in ['status', '-u', 'restart']:
            (self.root / 'fail').write_text(action)
            self.run_cli('logs' if action == '-u' else action, ok=False)

    def test_restart_applies_native_settings_without_enabling_service(self):
        self.run_cli('install')
        self.env.write_text('BIFROST_PORT=4333\n')
        (self.root / 'calls').write_text('')
        self.run_cli('restart')
        self.assertIn('BIFROST_PORT=4333', self.unit.read_text())
        self.assertNotIn('enable bifrost-dashboard.service', (self.root / 'calls').read_text())

    def test_unsafe_parent_and_release_paths_are_refused(self):
        self.unit.parent.chmod(0o777)
        self.run_cli('install', ok=False)
        self.unit.parent.chmod(0o755)
        (self.release / 'dist').chmod(0o777)
        self.run_cli('install', ok=False)
        self.assertFalse(self.unit.exists())

    def test_loaded_unit_without_reviewable_bytes_is_foreign(self):
        self.manager.write_text(self.manager.read_text() + '\nif "--property=FragmentPath" in a:print(' + repr(str(self.unit)) + ')\n')
        self.run_cli('install', ok=False)
        self.assertFalse(self.unit.exists())

    def test_malformed_ownership_never_authorizes_service_control(self):
        self.run_cli('install')
        self.state.write_text('[]')
        before = self.unit.read_bytes()
        self.run_cli('install', ok=False)
        self.run_cli('restart', ok=False)
        self.assertEqual(self.unit.read_bytes(), before)

    def test_fixture_mode_refuses_host_root(self):
        result = subprocess.run([sys.executable, '-I', '-S', '-B', str(CONTROLLER), '--fixture-root', '/', 'install'], capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('fixture root cannot be host root', result.stderr)
