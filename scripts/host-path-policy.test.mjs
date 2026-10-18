import assert from "node:assert/strict";
import test from "node:test";
import { hostPathViolations } from "./host-path-policy.mjs";

test("host path policy rejects direct home reconstruction outside the owning resolver", () => {
    assert.deepEqual(
        hostPathViolations([{ name: "scripts/tool.mjs", content: 'resolve(homedir(), ".config", "plurnk")' }]),
        ["scripts/tool.mjs: reconstructs a host path from homedir() outside plurnk-core/src/core/HostPaths.ts or scripts/lib/benchmarks-root.mjs"],
    );
    assert.deepEqual(
        hostPathViolations([{ name: "pkg/path.ts", content: 'join(homedir(), ".local", "share")' }]),
        ["pkg/path.ts: reconstructs a host path from homedir() outside plurnk-core/src/core/HostPaths.ts or scripts/lib/benchmarks-root.mjs"],
    );
});

test("host path policy leaves the owning resolver and tests alone", () => {
    assert.deepEqual(hostPathViolations([
        { name: "plurnk-core/src/core/HostPaths.ts", content: 'resolve(homedir(), ".config")' },
        // {§test-artifact-retention} — the benchmark home's one resolver is the one other owner.
        { name: "scripts/lib/benchmarks-root.mjs", content: 'join(homedir(), "benchmarks")' },
        { name: "plurnk-core/src/example.test.ts", content: 'join(homedir(), ".cache")' },
    ]), []);
});
