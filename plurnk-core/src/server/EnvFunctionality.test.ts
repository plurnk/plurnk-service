import test from "node:test";
import assert from "node:assert/strict";
import EnvFunctionality from "./EnvFunctionality.ts";
import { OperationFailureError } from "../core/results.ts";

// The contract types a definition as `object`, deliberately: the coordinator does not know any
// family's shape. A test that reads through it narrows first rather than asserting on `any`.
const valueOf = (definition: object): string => {
    assert.ok("value" in definition && typeof definition.value === "string", "an env definition carries a string value");
    return definition.value;
};

const FILES = [{
    owner: "@plurnk/plurnk-execs",
    parsed: {},
    text: "# A pager that waits for a keypress hangs a spawn that has no terminal.\nPAGER=cat\n# Service configuration.\nPLURNK_WITNESS_KNOB=1\n# Provider credential.\nGEMINI_API_KEY=",
}];

const adapter = new EnvFunctionality(async () => FILES);
const identity = { workspaceId: 1 };

test("{§functionality-scope} env defaults to worker scope and supports shared workspace defaults", () => {
    assert.deepEqual(adapter.scopes, ["worker", "workspace"]);
    assert.equal(adapter.family, "env");
});

// The coordinator's shared grammar is lowercase-hyphen (skill names, MCP server ids). An
// environment variable is uppercase with underscores, and its case is semantic, so the family
// declares the shell's grammar and the coordinator enforces that one instead.
test("{§functionality-adapter} env declares the shell's alias grammar: PATH is an alias, path-1 is not", () => {
    assert.equal(adapter.aliasPattern.test("PATH"), true);
    assert.equal(adapter.aliasPattern.test("CARGO_TARGET_DIR"), true);
    assert.equal(adapter.aliasPattern.test("_leading_underscore"), true);
    assert.equal(adapter.aliasPattern.test("path-1"), false, "the shared lowercase-hyphen shape is not a shell name");
    assert.equal(adapter.aliasPattern.test("9NOPE"), false);
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

test("{§exec-env-scoped} reserved names have the same scoped refusal at family and invocation admission", async (t) => {
    const previous = process.env.PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV;
    process.env.PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV = "CUSTOM_PROVIDER_TOKEN";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV;
        else process.env.PLURNK_PROVIDERS_PROVIDER_ENVFIXTURE_API_KEY_ENV = previous;
    });
    for (const alias of ["PLURNK_SERVICE_DB_PATH", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "CUSTOM_PROVIDER_TOKEN"]) {
        const refused = (cause: unknown): boolean => {
            assert.ok(cause instanceof OperationFailureError);
            assert.equal(cause.result.status, 400);
            assert.equal(cause.result.problem.type, "https://problems.plurnk.xyz/env/functionality/name-reserved");
            assert.equal(cause.result.problem.alias, alias);
            assert.equal(cause.result.problem.detail, `'${alias}' is reserved in env entries and invocation overrides.`);
            assert.equal(cause.result.problem.recovery, "READ worker:///_plurnk/plurnk/env.md for supported configuration paths.");
            return true;
        };
        await assert.rejects(() => adapter.admit({ alias, definition: { value: "explicit-value" } }, identity), refused);
        assert.throws(() => EnvFunctionality.modifier([JSON.stringify({ env: { [alias]: "explicit-value" } })]), refused);
    }
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

test("{§env-functionality} discover distinguishes an unknown source from a known source with no matches", async () => {
    const source = "@plurnk/plurnk-execs";
    assert.deepEqual((await adapter.discover({ source }, identity)).map(({ alias }) => alias), ["PAGER"]);
    assert.deepEqual(await adapter.discover({ source, query: "not-a-declared-name" }, identity), []);
    for (const source of [".env", "/tmp/settings.env", "@plurnk/not-installed"]) {
        await assert.rejects(adapter.discover({ source }, identity), (cause: unknown) => {
            assert.ok(cause instanceof OperationFailureError);
            assert.equal(cause.result.status, 400);
            assert.equal(cause.result.problem.type, "https://problems.plurnk.xyz/env/functionality/source-unknown");
            assert.equal(cause.result.problem.source, source);
            assert.match(cause.result.problem.detail, /package in the configuration catalog/u);
            assert.match(String(cause.result.problem.recovery), /READ/u);
            return true;
        });
    }
});

test("{§env-functionality} discover projects only what a Worker may set, and matches a declaration's comment", async () => {
    assert.deepEqual((await adapter.discover({}, identity)).map(({ alias }) => alias), ["PAGER"], "plurnk's own names never appear");
    assert.deepEqual((await adapter.discover({ query: "keypress" }, identity)).map(({ alias }) => alias), ["PAGER"], "a Worker finds a name by what it is for");
    assert.deepEqual(await adapter.discover({ query: "PLURNK_WITNESS_KNOB" }, identity), [], "not even by exact name");
    assert.deepEqual(await adapter.discover({ query: "GEMINI_API_KEY" }, identity), [], "MCP credential bindings do not make provider names env-family candidates");
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

// Nothing is launched, so nothing can fail to launch. This is why the family prepares no
// runtimes: the field is the resident family's facet ({§module-workspace-residency-facet}).
test("{§env-functionality} prepare publishes no runtime and marks every enabled definition active", async () => {
    const prepared = await adapter.prepare({
        signal: new AbortController().signal,
        workspaceId: 1,
        enabled: new Map([["PAGER", { definition: { value: "cat" } }], ["CI", { definition: { value: "1" } }]]),
        previous: null,
        failure: "publish-unavailable",
        progress: () => undefined,
    } as never);
    assert.equal("runtimes" in prepared, false, "no processes, so no resident facet");
    assert.deepEqual([...prepared.outcomes.keys()], ["PAGER", "CI"]);
    assert.deepEqual([...prepared.outcomes.values()], [{ state: "active" }, { state: "active" }]);
});

// {§exec-env-scoped} — one rule for the spawn and its record: what the command receives and why.
test("{§exec-env-scoped} compose applies the Worker's state over the ambient ceiling and records each name's provenance", () => {
    const { env, record } = EnvFunctionality.compose({ PATH: "/usr/bin", CI: "1", TERM: "xterm" }, { version: 1, definitions: {
        CARGO_TARGET_DIR: { origin: "worker", enabled: true, definition: { value: "/tmp/shared" } },
        TOOLCHAIN: { origin: "worker", enabled: true, definition: { value: "stable" }, inherited: "alice" },
        CI: { origin: "service", enabled: false, inherited: "alice" },
        TERM: { origin: "service", enabled: true },
        OFF: { origin: "worker", enabled: false, definition: { value: "x" } },
        PLURNK_SERVICE_DB_PATH: { origin: "worker", enabled: true, definition: { value: "/tmp/steal.db" } },
    } });
    assert.deepEqual(env, { PATH: "/usr/bin", TERM: "xterm", CARGO_TARGET_DIR: "/tmp/shared", TOOLCHAIN: "stable" });
    assert.deepEqual(record, {
        PATH: { source: "host", value: "/usr/bin" },
        TERM: { source: "host", value: "xterm" },
        CARGO_TARGET_DIR: { source: "worker", value: "/tmp/shared" },
        TOOLCHAIN: { source: "worker", from: "alice", value: "stable" },
        CI: { source: "masked", from: "alice" },
        OFF: { source: "masked" },
        PLURNK_SERVICE_DB_PATH: { source: "masked" },
    });
    assert.throws(() => EnvFunctionality.compose({}, { version: 2 }), /not a version 1 record/u, "a foreign state shape is a defect, never a fallback");
});

// {§env-option} — the heading's `env` is admitted by the family's own rules, by name, before anything
// runs or is created; the executor never sees the key.
test("{§env-option} the modifier is read through the shared reader and admitted like an add", () => {
    assert.deepEqual(EnvFunctionality.modifier(['{"cwd": "src", "env": {"RUN_ID": "7", "CI": ""}}']), { RUN_ID: "7", CI: "" });
    assert.deepEqual(EnvFunctionality.modifier(null), {}, "no block, no environment");
    assert.deepEqual(EnvFunctionality.modifier(['{"cwd": "src"}']), {}, "a block without env is not an environment");
    const type = (run: () => unknown): string => {
        try { run(); } catch (cause) { return String((cause as { result: { problem: { type: string } } }).result.problem.type); }
        throw new Error("expected a refusal");
    };
    assert.match(type(() => EnvFunctionality.modifier(['{"env": ["x"]}'])), /env\/functionality\/env-invalid$/u);
    assert.match(type(() => EnvFunctionality.modifier(['{"env": {"9NOPE": "x"}}'])), /env\/functionality\/name-invalid$/u);
    assert.match(type(() => EnvFunctionality.modifier(['{"env": {"PLURNK_SERVICE_DB_PATH": "x"}}'])), /env\/functionality\/name-reserved$/u);
    assert.match(type(() => EnvFunctionality.modifier(['{"env": {"COUNT": 3}}'])), /env\/functionality\/value-invalid$/u);
    assert.deepEqual(EnvFunctionality.modifier(['{"env": ']), {}, "a block that is not the array shape carries no env: it is the executor's to accept or refuse");
    assert.deepEqual(EnvFunctionality.modifier(['{"a": 1}', '{"env": {"X": "1"}}']), {}, "so is a repeated block");
});

test("{§env-option} compose applies the op's modifier nearest the spawn and records it as the modifier's", () => {
    const { env, record } = EnvFunctionality.compose({ PATH: "/usr/bin" }, { version: 1, definitions: {
        CARGO_TARGET_DIR: { origin: "worker", enabled: true, definition: { value: "/tmp/shared" } },
    } }, { CARGO_TARGET_DIR: "/tmp/override", RUN_ID: "7" });
    assert.deepEqual(env, { PATH: "/usr/bin", CARGO_TARGET_DIR: "/tmp/override", RUN_ID: "7" });
    assert.deepEqual(record.CARGO_TARGET_DIR, { source: "modifier", value: "/tmp/override" }, "the nearest setter wins, and the record says which");
    assert.deepEqual(record.RUN_ID, { source: "modifier", value: "7" });
});
