import assert from "node:assert/strict";
import test from "node:test";
import { envSurfaceViolations, measure, readPanels, stripComments } from "./env-surface-policy.mjs";

const panel = (content, name = "plurnk-x/.env.defaults") => ({ name, content });
const source = (content, name = "plurnk-x/src/thing.ts") => ({ name, content });
const run = ({ panels = [], sources = [], allowance = {} }) =>
    envSurfaceViolations({ panels, sources, corpus: sources, allowance });

test("a knob read in shipped source must be declared on a panel, live or as an optional knob", () => {
    const panels = [panel("PLURNK_X_LIVE=1\n# PLURNK_X_OPTIONAL=example\n")];
    assert.deepEqual(run({ panels, sources: [source("read(env.PLURNK_X_LIVE); read(env[\"PLURNK_X_OPTIONAL\"]);")] }), []);
    assert.deepEqual(
        run({ panels, sources: [source("use(env.PLURNK_X_LIVE); const key = \"PLURNK_X_HIDDEN\";")] }),
        ["undeclared: PLURNK_X_HIDDEN — 1 found, allowance 0"],
    );
});

test("a computed name is a family, covered by one declared example of it", () => {
    const panels = [panel("PLURNK_X_LIVE=1\n# PLURNK_EXECS_PYTHON3=0\n")];
    const family = source("const on = env[`PLURNK_EXECS_${runtime}`]; const known = env.PLURNK_EXECS_JQ; use(env.PLURNK_X_LIVE);");
    assert.deepEqual(run({ panels, sources: [family] }), []);
    // A family nothing declares an example of is as hidden as a single key.
    assert.deepEqual(
        run({ panels: [panel("PLURNK_X_LIVE=1\n")], sources: [family] }),
        ["undeclared: PLURNK_EXECS_JQ — 1 found, allowance 0"],
    );
});

test("a read never carries its own value: a default in code is a second home for a choice", () => {
    const panels = [panel("PLURNK_X_TURNS=-1\n")];
    const violations = run({ panels, sources: [source("const a = Number(process.env.PLURNK_X_TURNS ?? \"50\");\nconst b = env[\"PLURNK_X_TURNS\"] || 30;")] });
    assert.deepEqual(violations, [
        "fallback: plurnk-x/src/thing.ts — 2 found, allowance 0",
        "raw-env: plurnk-x/src/thing.ts — 1 found, allowance 0",
    ]);
});

test("a constant named DEFAULT is, by its own name, a default living in code", () => {
    assert.deepEqual(
        run({ sources: [source("const DEFAULT_LIMIT = 50;\nclass A { static readonly DEFAULT_POLICY = {}; static #DEFAULT_TIMERS = {}; }")] }),
        ["default-constant: plurnk-x/src/thing.ts — 3 found, allowance 0"],
    );
});

test("a retired key is named only to be refused, and is declared nowhere", () => {
    const retiring = source("shedRenamed(env, \"PLURNK_X_OLD\", \"PLURNK_X_NEW\", label);\nconst retired: Record<string, string> = { PLURNK_X_GONE: \"why\" };");
    assert.deepEqual(run({ panels: [panel("PLURNK_X_NEW=1\n")], sources: [retiring] }), []);
    assert.deepEqual(
        run({ panels: [panel("PLURNK_X_NEW=1\nPLURNK_X_OLD=1\n")], sources: [retiring] }),
        ["retired-declared: PLURNK_X_OLD — 1 found, allowance 0"],
    );
});

test("a live declaration nothing consumes means the panel lies", () => {
    assert.deepEqual(
        run({ panels: [panel("PLURNK_X_UNUSED=1\n")], sources: [source("export const nothing = 1;")] }),
        ["dead-knob: PLURNK_X_UNUSED — 1 found, allowance 0"],
    );
});

test("one package owns a key", () => {
    const { duplicates } = readPanels([panel("PLURNK_X=1\n", "plurnk-a/.env.defaults"), panel("PLURNK_X=2\n", "plurnk-b/.env.defaults")]);
    assert.deepEqual(duplicates, ["PLURNK_X: declared by both plurnk-a/.env.defaults and plurnk-b/.env.defaults"]);
});

test("prose is not a read: comments, messages that merely begin with a name, tests and fixtures", () => {
    const prose = source([
        "// PLURNK_X_HISTORIC was the old spelling",
        "/* PLURNK_X_BLOCK */",
        "throw new Error(\"PLURNK_X_MESSAGE configuration has companions\");",
        "const url = \"https://example.test//PLURNK_X_IN_URL\";",
    ].join("\n"));
    assert.deepEqual(run({ sources: [prose, source("env.PLURNK_X_IN_TEST", "plurnk-x/src/thing.test.ts"), source("env.PLURNK_X_FIXTURE", "plurnk-x/src/fixtures/f.mjs")] }), []);
    assert.equal(stripComments("a // b\n\"c // d\" /* e */ f").replace(/\s+/gu, " "), "a \"c // d\" f");
});

test("the allowance is a ratchet: new debt is refused, and so is a paid debt left on the books", () => {
    const sources = [source("const a = process.env.HOME; const b = process.env.PATH;")];
    assert.deepEqual(run({ sources, allowance: { "raw-env": { "plurnk-x/src/thing.ts": 2 } } }), []);
    assert.deepEqual(
        run({ sources, allowance: { "raw-env": { "plurnk-x/src/thing.ts": 1 } } }),
        ["raw-env: plurnk-x/src/thing.ts — 2 found, allowance 1"],
    );
    assert.deepEqual(
        run({ sources, allowance: { "raw-env": { "plurnk-x/src/thing.ts": 3 } } }),
        ["raw-env: plurnk-x/src/thing.ts — allowance 3 is stale, 2 remain; lower it"],
    );
    assert.deepEqual(
        run({ sources: [], allowance: { "fallback": { "plurnk-x/src/gone.ts": 1 } } }),
        ["fallback: plurnk-x/src/gone.ts — allowance 1 is stale, 0 remain; lower it"],
    );
});

test("the one reader is where the environment is touched, and nowhere else is free", () => {
    const findings = measure({ panels: [], sources: [source("process.env.HOME", "plurnk-meta/src/Env.ts"), source("process.env.HOME")], corpus: [] });
    assert.deepEqual([...findings.keys()], ["raw-env\tplurnk-x/src/thing.ts"]);
});
