import test from "node:test";
import assert from "node:assert/strict";
import WorkerEnv from "./worker-env.ts";

const noSecrets = (name: string): boolean => name.startsWith("PLURNK_") || name === "OPENAI_API_KEY";

test("WorkerEnv.parse reads assignments and keeps disabled entries visible", () => {
    const entries = WorkerEnv.parse([
        "# the worker's own registry",
        "CARGO_TARGET_DIR=/tmp/shared",
        "",
        "# CI=1",
        "QUOTED=\"has spaces\"",
        "SINGLE='also spaces'",
        "not an assignment",
        "9INVALID=x",
    ].join("\n"));
    assert.deepEqual(entries, [
        { name: "CARGO_TARGET_DIR", value: "/tmp/shared", enabled: true },
        // A commented ASSIGNMENT is a disabled entry the model can see it turned off;
        // ordinary prose above it stays prose.
        { name: "CI", value: "1", enabled: false },
        { name: "QUOTED", value: "has spaces", enabled: true },
        { name: "SINGLE", value: "also spaces", enabled: true },
    ], "prose comments and names a shell could not export are not entries");
});

test("WorkerEnv.render round-trips the enabled/disabled distinction", () => {
    const document = "A=1\n# B=2";
    assert.equal(WorkerEnv.render(WorkerEnv.parse(document)), document);
});

test("WorkerEnv.compose layers the worker's registry over the ambient environment", () => {
    const composed = WorkerEnv.compose(
        { PATH: "/usr/bin", CI: "1", LANG: "C" },
        "CARGO_TARGET_DIR=/tmp/shared\nLANG=en_US.UTF-8",
        noSecrets,
    );
    assert.equal(composed.PATH, "/usr/bin", "the ambient layer survives untouched");
    assert.equal(composed.CARGO_TARGET_DIR, "/tmp/shared", "the worker's own value is added");
    assert.equal(composed.LANG, "en_US.UTF-8", "and a nearer setter wins over the ambient one");
});

// This is how a worker turns off `CI=1` for itself without the operator — the case the
// converged design names explicitly.
test("WorkerEnv.compose: a disabled entry masks an ambient name for this worker alone", () => {
    const composed = WorkerEnv.compose({ PATH: "/usr/bin", CI: "1" }, "# CI=1", noSecrets);
    assert.equal(composed.PATH, "/usr/bin");
    assert.equal("CI" in composed, false, "the name is absent, not empty — the tool must not see it set");
});

// The ceiling does not apply to the worker's own values, but the invariant does at every layer:
// a model cannot introduce plurnk's own names by writing them into its registry.
test("WorkerEnv.compose refuses plurnk's own names from the worker's registry", () => {
    const composed = WorkerEnv.compose(
        { PATH: "/usr/bin" },
        "PLURNK_SERVICE_DB_PATH=/tmp/steal.db\nOPENAI_API_KEY=sk-mine\nMY_OWN=fine",
        noSecrets,
    );
    assert.equal(composed.PLURNK_SERVICE_DB_PATH, undefined, "a model cannot set plurnk's configuration for a subprocess");
    assert.equal(composed.OPENAI_API_KEY, undefined, "nor shadow a provider credential name");
    assert.equal(composed.MY_OWN, "fine", "its own names are its own business");
});
