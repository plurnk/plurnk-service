import assert from "node:assert/strict";
import test from "node:test";
import { hostPathViolations } from "./host-path-policy.mjs";

test("host path policy rejects new legacy teaching and direct home reconstruction", () => {
    const legacy = ["~", ".plurnk"].join("/");
    assert.deepEqual(
        hostPathViolations([{ name: "pkg/README.md", content: `Use ${legacy}/.env` }]),
        ["pkg/README.md: 1 legacy-home reference(s), allowance 0"],
    );
    assert.deepEqual(
        hostPathViolations([{ name: "scripts/tool.mjs", content: 'resolve(homedir(), ".config", "plurnk")' }]),
        ["scripts/tool.mjs: reconstructs a host path from homedir() outside plurnk-core/src/core/HostPaths.ts"],
    );
    assert.deepEqual(
        hostPathViolations([{ name: "pkg/INSTALL.md", content: "Use $HOME/.plurnk/.env" }]),
        ["pkg/INSTALL.md: 1 legacy-home reference(s), allowance 0"],
    );
    assert.deepEqual(
        hostPathViolations([{ name: "pkg/path.ts", content: 'join(home, ".plurnk", ".env")' }]),
        ["pkg/path.ts: 1 legacy-home reference(s), allowance 0"],
    );
});

test("host path policy preserves the deliberate transition and owning resolver", () => {
    const legacy = ["~", ".plurnk"].join("/");
    assert.deepEqual(hostPathViolations([
        { name: "plurnk-core/INSTALL.md", content: `Migrate ${legacy} explicitly.` },
        { name: "plurnk-core/src/core/HostPaths.ts", content: 'resolve(homedir(), ".config")' },
        { name: "plurnk-core/src/example.test.ts", content: `fixture ${legacy}` },
    ]), []);
});
