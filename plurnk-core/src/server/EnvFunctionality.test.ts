import test from "node:test";
import assert from "node:assert/strict";
import EnvFunctionality from "./EnvFunctionality.ts";

// The contract types a definition as `object`, deliberately: the coordinator does not know any
// family's shape. A test that reads through it narrows first rather than asserting on `any`.
const valueOf = (definition: object): string => {
    assert.ok("value" in definition && typeof definition.value === "string", "an env definition carries a string value");
    return definition.value;
};

const FILES = [{
    owner: "@plurnk/plurnk-execs",
    parsed: {},
    text: "# A pager that waits for a keypress hangs a spawn that has no terminal.\nPAGER=cat",
}];

const adapter = new EnvFunctionality(async () => FILES);
const identity = { workspaceId: 1 };

test("{§functionality-scope} env declares worker scope; its definitions belong to one worker", () => {
    assert.equal(adapter.scope, "worker");
    assert.equal(adapter.family, "env");
});

test("{§env-functionality} admit accepts a name a shell can export", async () => {
    const admitted = await adapter.admit({ alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } }, identity);
    assert.deepEqual(admitted, { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } });
});

test("{§env-functionality} admit refuses a name a shell could not export", async () => {
    await assert.rejects(
        () => adapter.admit({ alias: "9NOPE", definition: { value: "x" } }, identity),
        /is not a name a shell can export/u,
    );
});

// The invariant refused at ADMISSION rather than silently at the spawn. A model that writes
// PLURNK_SERVICE_DB_PATH into its registry would otherwise see it accepted, then watch it never
// appear in any command, and never learn why.
test("{§exec-env-scoped} admit refuses plurnk's own names, so the model learns why", async () => {
    await assert.rejects(
        () => adapter.admit({ alias: "PLURNK_SERVICE_DB_PATH", definition: { value: "/tmp/steal.db" } }, identity),
        /never reach a subprocess/u,
    );
});

test("{§env-functionality} admit refuses a non-string value", async () => {
    await assert.rejects(
        () => adapter.admit({ alias: "COUNT", definition: { value: 3 } }, identity),
        /needs a string value/u,
    );
});

test("{§env-functionality} discover projects the configuration catalog as addable candidates", async () => {
    const [candidate] = await adapter.discover({ query: "PAGER" }, identity);
    assert.equal(candidate!.alias, "PAGER");
    assert.equal(valueOf(candidate!.definition), "cat");
    assert.equal(candidate!.provenance.source, "@plurnk/plurnk-execs");
});

// Client configuration contributing candidates would be a second door into the cascade, past the
// operator's ceiling. Agent Skills refuses the same field for the same reason.
test("{§env-functionality} discover refuses client-supplied configuration", async () => {
    await assert.rejects(
        () => adapter.discover({ configuration: {} }, identity),
        /client configuration contributes nothing/u,
    );
});

test("{§env-functionality} available projects what the ceiling admits, enabled, in name order", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
    process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "ZED_LAST,ALPHA_FIRST";
    process.env.ALPHA_FIRST = "a";
    process.env.ZED_LAST = "z";
    try {
        const available = await adapter.available(identity);
        assert.deepEqual(available.map(({ alias }) => alias), ["ALPHA_FIRST", "ZED_LAST"], "sorted by name");
        // Values are projected: the ceiling is the security boundary, not this projection, and any
        // admitted name is already readable by every command the worker runs.
        assert.equal(valueOf(available[0]!.definition), "a");
        assert.ok(available.every(({ enabled }) => enabled), "an admitted name is enabled until the worker disables it");
    } finally {
        delete process.env.ALPHA_FIRST;
        delete process.env.ZED_LAST;
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previous;
    }
});

// Nothing is launched, so nothing can fail to launch. This is why the family publishes no
// runtimes and never enters the warmed capability snapshot ({§module-workspace-residency}).
test("{§env-functionality} prepare publishes no runtime and marks every enabled definition active", async () => {
    const prepared = await adapter.prepare({
        workspaceId: 1,
        enabled: new Map([["PAGER", { value: "cat" }], ["CI", { value: "1" }]]),
        previous: null,
        failure: "publish-unavailable",
    } as never);
    assert.deepEqual(prepared.runtimes, []);
    assert.deepEqual([...prepared.outcomes.keys()], ["PAGER", "CI"]);
    assert.deepEqual([...prepared.outcomes.values()], [{ state: "active" }, { state: "active" }]);
});
