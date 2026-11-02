// Builds the Linux packages (AppImage, deb, rpm; x64 and arm64) in a Debian container, so any
// host with Docker can make them: `pnpm dist:linux:docker` from the repo root. The working tree
// (minus node_modules, build output and .git) is copied into the container, installed from the
// lockfile, built, and packaged. Packages land in apps/desktop/release/linux. Extra arguments go
// to electron-builder, e.g. `-c.extraMetadata.version=0.0.1` for a test upgrade.
// Named volumes cache the pnpm store and Electron downloads between runs.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const nodeVersion = readFileSync(NodePath.join(root, ".node-version"), "utf8").trim();
const { packageManager } = JSON.parse(readFileSync(NodePath.join(root, "package.json"), "utf8"));
const out = NodePath.join(root, "apps/desktop/release/linux");
mkdirSync(out, { recursive: true });

// shortcut: arguments are joined unquoted, so none may contain spaces; quote them if one must.
const builderArgs = process.argv.slice(2).join(" ");
const script = `
set -eu
apt-get update -qq && apt-get install -y -qq rpm > /dev/null
npm install --global --silent ${packageManager}
mkdir /build
tar -C /src --exclude=node_modules --exclude=.git --exclude=release --exclude=dist \\
  --exclude=dist-electron -cf - . | tar -C /build -xf -
# A Windows bind mount reports every file as 0777, which would ship world-writable icons.
chmod -R a-x,u=rwX,go=rX /build
cd /build
CI=true pnpm install --frozen-lockfile
pnpm build
cd apps/desktop
pnpm exec electron-builder --linux --publish never ${builderArgs}
cp release/*.AppImage release/*.deb release/*.rpm release/latest-linux*.yml /out/
`;

const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${root}:/src:ro`,
    "-v",
    `${out}:/out`,
    "-v",
    "rook-pnpm-store:/root/.local/share/pnpm/store",
    "-v",
    "rook-builder-cache:/root/.cache",
    `node:${nodeVersion}-bookworm`,
    "bash",
    "-c",
    script,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status === 0) console.log(`\nLinux packages are in ${out}`);
process.exit(result.status ?? 1);
