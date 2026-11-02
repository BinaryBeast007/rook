// Install-tests the x64 Linux packages from `pnpm dist:linux:docker` in clean containers:
// `node apps/desktop/scripts/test-linux-docker.mjs` from the repo root. The deb (Ubuntu) and rpm
// (Fedora) are installed, reinstalled (deb) and removed; every package is launched under Xvfb and
// must stay up for 15 seconds without fatal output, and node-pty must spawn a shell from the
// installed app. Packages are read from apps/desktop/release/linux, mounted read-only.
// Containers have no user namespaces or SUID chrome-sandbox setup, so the app runs with
// --no-sandbox; a real desktop session, the sandbox, Wayland and auto-update are not covered.
import { spawnSync } from "node:child_process";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const packages = NodePath.join(root, "apps/desktop/release/linux");

// Shared helpers. `launch` runs the app under Xvfb with ROOK_DISABLE_UPDATES unset, so the
// update check runs (and fails against the private feed, which must only log a warning).
const prelude = `
set -eu
export DEBIAN_FRONTEND=noninteractive
unset ROOK_DISABLE_UPDATES
cd /pkgs
ptycheck() {
  ELECTRON_RUN_AS_NODE=1 "$1/rook" -e "
    const pty = require('$1/resources/app.asar.unpacked/node_modules/node-pty');
    const p = pty.spawn('/bin/sh', ['-c', 'echo pty-ok'], {});
    let out = '';
    p.onData((d) => (out += d));
    p.onExit(() => { console.log('node-pty:', out.trim()); process.exit(out.includes('pty-ok') ? 0 : 1); });
  "
}
launch() {
  xvfb-run -a "$@" > /tmp/rook.log 2>&1 &
  sleep 15
  alive=0; pgrep -x rook > /dev/null && alive=1
  pkill -x rook || true
  sleep 2
  echo "--- app output (tail) ---"; tail -n 25 /tmp/rook.log; echo "---"
  [ "$alive" = 1 ] || { echo "app exited within 15s"; return 1; }
  if grep -E "FATAL|Error: Cannot find module|node-pty|pty\\.node" /tmp/rook.log; then
    echo "fatal output above"; return 1
  fi
}
`;

const scenarios = [
  {
    name: "deb on ubuntu:24.04",
    image: "ubuntu:24.04",
    script: `
deb=$(ls Rook-*-amd64.deb)
apt-get update -qq
apt-get install -y -qq "./$deb" xvfb xauth procps > /dev/null
test -x /usr/bin/rook
ptycheck /opt/Rook
launch rook --no-sandbox
apt-get install -y -qq --reinstall "./$deb" > /dev/null
test -x /usr/bin/rook
apt-get remove -y -qq "$(dpkg-deb -f "$deb" Package)" > /dev/null
test ! -e /opt/Rook || { echo "/opt/Rook left after remove:"; find /opt/Rook | head; exit 1; }
`,
  },
  {
    name: "rpm on fedora:44",
    image: "fedora:44",
    script: `
rpm=$(ls Rook-*x86_64.rpm)
dnf install -y -q "./$rpm" xorg-x11-server-Xvfb xvfb-run xorg-x11-xauth procps-ng > /dev/null
test -x /usr/bin/rook
ptycheck /opt/Rook
launch rook --no-sandbox
dnf remove -y -q "$(rpm -qp --qf '%{NAME}' "$rpm")" > /dev/null
test ! -e /opt/Rook || { echo "/opt/Rook left after remove:"; find /opt/Rook | head; exit 1; }
`,
  },
  {
    // No FUSE in containers, so the AppImage is extracted and its AppRun launched, which is what
    // --appimage-extract-and-run does minus the file listing it prints (which the error grep
    // would match). A desktop supplies the libraries below; the bare image does not.
    name: "AppImage on ubuntu:24.04",
    image: "ubuntu:24.04",
    script: `
apt-get update -qq
apt-get install -y -qq xvfb xauth procps libgtk-3-0t64 libnss3 libasound2t64 libgbm1 \\
  libnotify4 libsecret-1-0 libxss1 libxtst6 xdg-utils > /dev/null
cp Rook-*x86_64.AppImage /tmp/rook.AppImage
cd /tmp
./rook.AppImage --appimage-extract > /dev/null
ptycheck /tmp/squashfs-root
launch /tmp/squashfs-root/AppRun --no-sandbox
`,
  },
];

const failed = [];
// An argument runs only the scenarios whose name contains it, e.g. `AppImage`.
const only = process.argv[2];
for (const { name, image, script } of scenarios.filter((s) => !only || s.name.includes(only))) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--init", "-v", `${packages}:/pkgs:ro`, image, "bash", "-c", prelude + script],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  const pass = result.status === 0;
  if (!pass) failed.push(name);
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
}
console.log(failed.length ? `\nFailed: ${failed.join(", ")}` : "\nAll Linux install tests passed");
process.exit(failed.length ? 1 : 0);
