import { expect, test } from "vite-plus/test";

import { parseAppearance } from "./policy.ts";

test("valid appearances pass with only the known fields", () => {
  expect(parseAppearance({ scheme: "light", background: "#FAFAFA", symbol: "#333333" })).toEqual({
    scheme: "light",
    background: "#FAFAFA",
    symbol: "#333333",
  });
  expect(
    parseAppearance({ scheme: "dark", background: "#0e0e10", symbol: "#a3a3a3", extra: 1 }),
  ).toEqual({ scheme: "dark", background: "#0e0e10", symbol: "#a3a3a3" });
  expect(parseAppearance({ scheme: "system", background: "#0e0e10", symbol: "#a3a3a3" })).toEqual({
    scheme: "system",
    background: "#0e0e10",
    symbol: "#a3a3a3",
  });
});

test("anything else is rejected", () => {
  const valid = { scheme: "dark", background: "#0e0e10", symbol: "#a3a3a3" };
  for (const bad of [
    null,
    undefined,
    "dark",
    42,
    [],
    {},
    { ...valid, scheme: "Dark" },
    { ...valid, background: "#fff" },
    { ...valid, background: "#0e0e10ff" },
    { ...valid, background: "0e0e10" },
    { ...valid, background: "red" },
    { ...valid, background: "#0e0e1g" },
    { ...valid, symbol: "#a3a3a3\n" },
    { ...valid, symbol: 0xa3a3a3 },
  ])
    expect(parseAppearance(bad)).toBeUndefined();
});
