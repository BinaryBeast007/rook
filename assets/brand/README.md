# Brand assets

These SVGs are the source of truth for every Rook icon. Colors: ink `#0E0E10`, paper `#F4F3EF`.

| File                 | Use                                                                                |
| -------------------- | ---------------------------------------------------------------------------------- |
| `app-icon.svg`       | App icon. 1024 canvas with an 824px tile inset 100px (the macOS icon safe area).   |
| `app-icon-light.svg` | Light variant of the app icon, for light surfaces such as docs.                    |
| `favicon.svg`        | Pixel-aligned 16px mark that switches between ink and paper with the color scheme. |
| `mark.svg`           | The bare mark in `currentColor`. The renderer inlines it as `RookMark`.            |
| `mark-black.svg`     | The mark in ink, for light backgrounds.                                            |
| `mark-white.svg`     | The mark in paper, for dark backgrounds.                                           |
| `preview.png`        | Reference sheet of the marks and icons at every size.                              |

`pnpm icons:export` renders these into the icons the apps ship. `pnpm icons:check`, which `pnpm check` also runs,
fails if any of them is missing or stale. Never edit the generated files by hand.

| Generated file                                 | From                   | Used by                                    |
| ---------------------------------------------- | ---------------------- | ------------------------------------------ |
| `apps/desktop/resources/icon-mac.png`          | `app-icon.svg` (1024)  | macOS bundle icon, dev dock icon           |
| `apps/desktop/resources/icon.png`              | app icon tile (1024)   | Linux packages and window icon             |
| `apps/desktop/resources/icon.ico`              | app icon tile (16–256) | Windows executable, installer, window icon |
| `apps/web/public/favicon.svg`                  | `favicon.svg` (copied) | Browser tab                                |
| `apps/web/public/favicon.ico`, `favicon-*.png` | app icon tile (16–48)  | Browser tab fallback                       |
| `apps/web/public/apple-touch-icon.png`         | app icon, square (180) | iOS home screen                            |

The "tile" crops `app-icon.svg` to its 824px tile, because Windows, Linux, and browsers add their own
padding. The touch icon also drops the corner radius, because iOS applies its own mask.
