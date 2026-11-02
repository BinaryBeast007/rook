// Boots in the last theme (saved by applyTheme, src/theme/apply.ts), not a flash of the default.
// A classic blocking script, as the renderer's CSP allows no inline ones.
try {
  const boot = JSON.parse(localStorage.getItem("rook:boot-theme"));
  const hex = /^#[0-9a-f]{6}$/i;
  if (hex.test(boot.canvas) && hex.test(boot.text) && /^(light|dark)$/.test(boot.scheme)) {
    const root = document.documentElement.style;
    root.setProperty("--boot-canvas", boot.canvas);
    root.setProperty("--boot-text", boot.text);
    root.colorScheme = boot.scheme;
  }
} catch {
  // No saved theme yet: index.html's default colors.
}
