import assert from "node:assert/strict";

process.env.GATEWAY_PROXY_AUTOSTART = "false";
process.env.BROWSER_AUTH_MODE = "disabled";

const { sanitizeReturnTo, server } = await import("./gateway-proxy.mjs");

const cases = [
  ["/", "/"],
  ["/workspace?tab=agents", "/workspace?tab=agents"],
  ["", "/"],
  [null, "/"],
  ["https://evil.example/path", "/"],
  ["//evil.example/path", "/"],
  ["/%5Cevil.example", "/"],
  ["/%5cevil.example", "/"],
  ["/\\evil.example", "/"],
  ["/safe?next=%5C%5Cevil.example", "/"],
  ["/%255Cnot-decoded-twice", "/"],
];

for (const [input, expected] of cases) {
  assert.equal(sanitizeReturnTo(input), expected, `sanitizeReturnTo(${String(input)})`);
}

server.close();
