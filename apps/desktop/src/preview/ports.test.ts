import * as http from "node:http";
import * as net from "node:net";

import { afterEach, expect, test } from "vite-plus/test";

import { findDevServers, portHints } from "./ports.ts";

test("portHints reads explicit ports first, then tool defaults", () => {
  expect(
    portHints({
      dev: "vite",
      preview: "vite preview",
      start: "next start -p 3100",
      api: "PORT=8123 node server.js",
      docs: "astro dev --port=4400",
      sb: "storybook dev",
      build: "tsc -p tsconfig.json && vite build",
      lint: "eslint .",
    }),
  ).toEqual([3100, 8123, 4400, 5173, 4173, 6006]);
  expect(portHints({ a: "http-server -p8081", b: "ng serve", c: "--port 99999" })).toEqual([
    8081, 4200,
  ]);
  expect(portHints(undefined)).toEqual([]);
  expect(portHints({ a: 3 })).toEqual([]);
});

const servers: net.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("findDevServers finds a real HTTP server and skips closed ports and other protocols", async () => {
  const web = await listen(http.createServer((_req, res) => res.end("hi")));
  // Answers anything with a non-HTTP greeting, like Redis would.
  const other = await listen(net.createServer((socket) => socket.end("-ERR unknown\r\n")));
  const closed = await closedPort();
  expect(await findDevServers([closed, other, web])).toEqual([
    { port: web, url: `http://localhost:${web}/` },
  ]);
});

test("findDevServers stays within its budget and keeps a server still busy answering", async () => {
  // Accepts the request but never answers, like a dev server compiling its first page.
  const slow = await listen(http.createServer(() => {}));
  const started = Date.now();
  const found = await findDevServers([slow, await closedPort()], 300);
  expect(Date.now() - started).toBeLessThan(800);
  expect(found.map((server) => server.port)).toEqual([slow]);
});
