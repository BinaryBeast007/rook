// Where the renderer is loaded from: the Vite dev server in development, or the
// built web app served over a privileged `rook://` scheme in production. A custom
// scheme gives the renderer a stable origin and avoids file:// privileges.
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import { app, net, protocol } from "electron";

const SCHEME = "rook";
const HOST = "app";
const PRODUCTION_ORIGIN = `${SCHEME}://${HOST}`;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // blob: shows attachment previews the page builds from bytes it already holds.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Set by `scripts/dev.mjs`; never set in a packaged build. */
const devServerUrl = app.isPackaged ? undefined : process.env.ROOK_DEV_SERVER_URL;

export const rendererUrl = devServerUrl ?? `${PRODUCTION_ORIGIN}/index.html`;

export function isRendererUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}

// Packaged: electron-builder copies apps/web/dist to <app>/renderer.
// Unpackaged (`pnpm start`): read the web app's build output directly.
function rendererRoot(): string {
  return app.isPackaged
    ? NodePath.join(app.getAppPath(), "renderer")
    : NodePath.resolve(app.getAppPath(), "../web/dist");
}

export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
}

export function registerRendererProtocol(): void {
  if (devServerUrl) return;
  const root = rendererRoot();

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const filePath = NodePath.resolve(root, relativePath);
    const pathFromRoot = NodePath.relative(root, filePath);
    const isInsideRoot = !pathFromRoot.startsWith("..") && !NodePath.isAbsolute(pathFromRoot);

    if (url.host !== HOST || !isInsideRoot) return notFound();

    try {
      const response = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return notFound();
    }
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
