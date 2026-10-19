import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Browser half: evaluate the prebuilt bundle against a stub ModuleLoader and
// make sure it registers, then that its factory asks only for `react`.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let registration;
runInContext(
  source,
  createContext({
    window: { __ModuleLoader__: { load: (value) => { registration = value; } } },
    console,
    setTimeout,
    clearTimeout
  })
);
assert.ok(registration, "client bundle did not register itself");
assert.equal(registration.id, "dsh-system-monitor");

const react = {
  createElement: () => ({}),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useId: () => ":r0:"
};
const client = registration.factory((name) => {
  if (name === "react") return react;
  throw new Error(`unexpected require(${name})`);
});
assert.equal(typeof client.apply, "function");
assert.ok(Array.isArray(client.inject) && client.inject.includes("slots"));

// Host half: importing it must stay side-effect free and expose its contract.
const host = await import("../lib/index.js");
assert.equal(typeof host.apply, "function");
assert.equal(host.API.snapshot, "/api/dsh-system-monitor/snapshot");
assert.ok(host.Config && host.Config["~standard"]);
console.log("smoke: client bundle + host module ok");
