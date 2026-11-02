# Rook

Rook is a cross-platform Agentic Development Environment (ADE) for Windows, macOS, and Linux.

Rook runs real coding agents (Claude Code and Codex) inside your project folders. It streams their
replies with tool activity and approvals, and keeps every chat's history. Each workspace adds
tabs for changes, a terminal, files, and a browser, plus a Git flow that goes from commit to push
to pull request. Agents sign in through their own official tools and keep their own
credentials.

> **Status:** early and pre-1.0. Expect breaking changes.

## Requirements

- **Node.js 24 LTS** (`.node-version` pins 24.22.1; `engines` accepts `^24.11.0 || >=26`)
- **pnpm 12** (the `packageManager` field pins 12.15.0; pnpm switches to it automatically)
- Optional: the global [Vite+](https://viteplus.dev/guide/) `vp` CLI, which reads `.node-version`
  and `packageManager` to provide the right Node.js and pnpm. Every script also works through
  `pnpm` without it.

## Setup

```sh
pnpm install
```

Electron downloads its binary the first time it runs. It does not download during install.

## Commands

Run these from the repo root.

| Command                                     | What it does                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                  | Starts the web dev server (HMR) and the Electron shell. Restarts Electron when main or preload changes. |
| `pnpm build`                                | Builds the renderer (`apps/web/dist`) and main/preload (`apps/desktop/dist-electron`).                  |
| `pnpm start`                                | Runs the built app unpackaged, loading the production renderer over `rook://`.                          |
| `pnpm typecheck`                            | Runs `tsc --noEmit` (TypeScript 7) in every package, cached by Vite+.                                   |
| `pnpm lint`                                 | Runs Oxlint through `vp lint`. Warnings fail the run.                                                   |
| `pnpm fmt` / `pnpm fmt:check`               | Formats with Oxfmt, or checks formatting only.                                                          |
| `pnpm check`                                | Runs the format check, lint, typecheck, and icon check together, as CI would.                           |
| `pnpm test`                                 | Runs the unit tests in every package.                                                                   |
| `pnpm icons:export` / `pnpm icons:check`    | Renders app icons and favicons from `assets/brand`, or checks they are up to date.                      |
| `pnpm dist`                                 | Builds everything, then packages installers for the current OS into `apps/desktop/release`.             |
| `pnpm dist:win` / `dist:mac` / `dist:linux` | Packages for a specific OS.                                                                             |
| `pnpm dist:linux:docker`                    | Packages for Linux in a Docker container, from any host.                                                |

Pass Electron flags to the dev shell by running it directly, for example
`pnpm --filter @rook/web dev` in one terminal and
`node apps/desktop/scripts/dev.mjs --inspect` in another.

## Architecture

```
apps/
  desktop/   Electron shell: main process, preload, packaging (electron-builder)
  web/       Renderer: React 19 + Tailwind CSS 4, built by Vite+
packages/
  contracts/ Types and IPC channel names shared by main, preload, and renderer
assets/
  brand/     Logo and icon sources (SVG); scripts/export-icons.mjs renders them
```

**Process model.** The main process (`apps/desktop/src/main.ts`) owns the app lifecycle and
windows. The renderer is ordinary web code with no Node.js access. It reaches the main process
only through the typed `window.rook` bridge (`RookBridge` in `packages/contracts`), which the
sandboxed preload exposes with `contextBridge`. Main validates that every IPC call comes from the
app's own origin before handling it.

**Renderer loading.** In development, the window loads the Vite dev server
(`http://localhost:5733`). In production, it loads `rook://app/index.html`, a privileged custom
scheme that serves the built web app with a strict Content Security Policy. Using a custom scheme
avoids `file://`. When packaged, electron-builder copies `apps/web/dist` into the app archive as
`renderer/`.

**Bundling.** Vite+ (`vp pack`, which uses tsdown) bundles main as ESM and the preload as a
single CommonJS file, which sandboxed preloads require. Workspace packages are bundled in, so the
packaged app ships no `node_modules`. The build prints a "use ESM" warning for the preload; it is
expected.

**Security defaults.** These are set in `apps/desktop/src`:

- `contextIsolation` on, `sandbox` on, `nodeIntegration` off
- Every permission request is denied
- `window.open` is denied; https links open in the OS browser
- Navigation away from the app origin is blocked
- The app runs as a single instance

**Adding a capability.** To add a feature that crosses the process boundary:

1. Add its channel and types in `packages/contracts`.
2. Handle the channel in `apps/desktop/src/ipc.ts`.
3. Expose it in `preload.ts`.
4. Call it from the renderer.

## Packaging and releases

Rook packages for Windows (NSIS + portable), macOS (dmg + zip) and Linux (AppImage + deb + rpm).
`apps/desktop/electron-builder.yml` holds the targets and signing settings, and
`.github/workflows/build.yml` builds, tests and publishes each release.
App icons are generated from `assets/brand` into `apps/desktop/resources` and `apps/web/public`.
See [assets/brand/README.md](assets/brand/README.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first. Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
