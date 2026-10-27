import assert from "node:assert/strict";
import fs, { readFile } from "node:fs/promises";
import path from "node:path";
import test, { describe, it } from "node:test";
import { TREE_SITTER_REGISTRY } from "../plurnk-mimetypes/src/treesitter/registry.ts";
import { identity, validateCommit } from "./commit-provenance.mjs";
import {
    CONVENTIONAL_TYPES,
    validateBranchName,
    validateCommitMessage,
} from "./conventional.mjs";
import {
    defaultGrammarViolations,
    installScriptViolations,
    moduleContractViolations,
    packageGraphViolations,
    workspaceNpmConfigViolations,
} from "./dependency-policy.mjs";
import { envSurfaceViolations, readPanels, stripComments } from "./env-surface-policy.mjs";
import { hostPathViolations } from "./host-path-policy.mjs";
import {
    canonicalTestCommand,
    packageLifecycleViolations,
} from "./package-lifecycle-policy.mjs";

const panel = (content, name = "plurnk-x/.env.defaults") => ({ name, content });
const source = (content, name = "plurnk-x/src/thing.ts") => ({ name, content });
const run = ({ panels = [], sources = [], allowance = {} }) =>
    envSurfaceViolations({ panels, sources, corpus: sources, allowance });

test("{§lint-gate} a knob read in shipped source must be declared on a panel, live or as an optional knob", () => {
    const panels = [panel("PLURNK_X_LIVE=1\n# PLURNK_X_OPTIONAL=example\n")];
    assert.deepEqual(run({ panels, sources: [source("read(env.PLURNK_X_LIVE); read(env[\"PLURNK_X_OPTIONAL\"]);")] }), []);
    assert.deepEqual(
        run({ panels, sources: [source("use(env.PLURNK_X_LIVE); const key = \"PLURNK_X_HIDDEN\";")] }),
        ["undeclared: PLURNK_X_HIDDEN — 1 found, allowance 0"],
    );
});

test("{§lint-gate} a computed name is a family, covered by one declared example of it", () => {
    const panels = [panel("PLURNK_X_LIVE=1\n# PLURNK_EXECS_PYTHON3=0\n")];
    const family = source("const on = env[`PLURNK_EXECS_${runtime}`]; const known = env.PLURNK_EXECS_JS; use(env.PLURNK_X_LIVE);");
    assert.deepEqual(run({ panels, sources: [family] }), []);
    assert.deepEqual(
        run({ panels: [panel("PLURNK_X_LIVE=1\n")], sources: [family] }),
        ["undeclared: PLURNK_EXECS_JS — 1 found, allowance 0"],
    );
});

test("{§lint-gate} a read never carries its own value: a default in code is a second home for a choice", () => {
    const panels = [panel("PLURNK_X_TURNS=-1\n")];
    const violations = run({ panels, sources: [source("const a = Number(process.env.PLURNK_X_TURNS ?? \"50\");\nconst b = env[\"PLURNK_X_TURNS\"] || 30;")] });
    assert.deepEqual(violations, ["fallback: plurnk-x/src/thing.ts — 2 found, allowance 0"]);
});

test("{§lint-gate} a constant named DEFAULT is, by its own name, a default living in code", () => {
    assert.deepEqual(
        run({ sources: [source("const DEFAULT_MODE = 50;\nclass A { static readonly DEFAULT_POLICY = {}; static #DEFAULT_TIMERS = {}; }")] }),
        ["default-constant: plurnk-x/src/thing.ts — 3 found, allowance 0"],
    );
});

test("{§lint-gate} a live declaration nothing consumes means the panel lies", () => {
    assert.deepEqual(
        run({ panels: [panel("PLURNK_X_UNUSED=1\n")], sources: [source("export const nothing = 1;")] }),
        ["dead-knob: PLURNK_X_UNUSED — 1 found, allowance 0"],
    );
});

test("{§lint-gate} one package owns a key", () => {
    const { duplicates } = readPanels([panel("PLURNK_X=1\n", "plurnk-a/.env.defaults"), panel("PLURNK_X=2\n", "plurnk-b/.env.defaults")]);
    assert.deepEqual(duplicates, ["PLURNK_X: declared by both plurnk-a/.env.defaults and plurnk-b/.env.defaults"]);
});

test("{§lint-gate} prose is not a read: comments, messages that merely begin with a name, tests and fixtures", () => {
    const prose = source([
        "// PLURNK_X_COMMENT named in prose",
        "/* PLURNK_X_BLOCK */",
        "throw new Error(\"PLURNK_X_MESSAGE configuration has companions\");",
        "const url = \"https://example.test//PLURNK_X_IN_URL\";",
    ].join("\n"));
    assert.deepEqual(run({ sources: [prose, source("env.PLURNK_X_IN_TEST", "plurnk-x/src/thing.test.ts"), source("env.PLURNK_X_FIXTURE", "plurnk-x/src/fixtures/f.mjs")] }), []);
    assert.equal(stripComments("a // b\n\"c // d\" /* e */ f").replace(/\s+/gu, " "), "a \"c // d\" f");
});

test("{§lint-gate} the allowance is a ratchet: new debt is refused, and so is a paid debt left on the books", () => {
    const sources = [source("const DEFAULT_A = 1; const DEFAULT_B = 2;")];
    assert.deepEqual(run({ sources, allowance: { "default-constant": { "plurnk-x/src/thing.ts": 2 } } }), []);
    assert.deepEqual(
        run({ sources, allowance: { "default-constant": { "plurnk-x/src/thing.ts": 1 } } }),
        ["default-constant: plurnk-x/src/thing.ts — 2 found, allowance 1"],
    );
    assert.deepEqual(
        run({ sources, allowance: { "default-constant": { "plurnk-x/src/thing.ts": 3 } } }),
        ["default-constant: plurnk-x/src/thing.ts — allowance 3 is stale, 2 remain; lower it"],
    );
    assert.deepEqual(
        run({ sources: [], allowance: { "fallback": { "plurnk-x/src/gone.ts": 1 } } }),
        ["fallback: plurnk-x/src/gone.ts — allowance 1 is stale, 0 remain; lower it"],
    );
});

test("{§lint-gate} reading the system environment is the mechanism, never a debt", () => {
    const direct = source("const turns = Number(process.env.PLURNK_X_TURNS); const home = process.env.HOME;");
    assert.deepEqual(run({ panels: [panel("PLURNK_X_TURNS=-1\n")], sources: [direct] }), []);
});

test("{§lint-gate} a reader that accepts a fallback can state a value the panel never did", () => {
    const reader = source("const readInt = (name: string, fallback: number): number => {\n    const raw = process.env[name];\n    return raw === undefined ? fallback : Number(raw);\n};");
    assert.deepEqual(run({ sources: [reader] }), ["reader-fallback: plurnk-x/src/thing.ts — 1 found, allowance 0"]);
    assert.deepEqual(run({ sources: [source("const parse = (text: string, fallback: unknown) => { try { return JSON.parse(text); } catch { return fallback; } };")] }), []);
    assert.deepEqual(run({ sources: [source("const readBound = (env: NodeJS.ProcessEnv, name: string, floor: number): number => {\n    const raw = env[name];\n    if (raw === undefined) throw new Error(name);\n    return Number(raw);\n};")] }), []);
});

test("{§lint-gate} a package that ships a panel tests on it, or the floor is a fiction where the code is exercised", () => {
    const panels = [panel("PLURNK_X=1\n")];
    const sources = [source("use(env.PLURNK_X);")];
    const manifest = (scripts) => ({ name: "plurnk-x/package.json", content: JSON.stringify({ scripts }) });
    const check = (scripts) => envSurfaceViolations({ panels, sources, corpus: sources, manifests: [manifest(scripts)], allowance: {} });
    assert.deepEqual(check({ "test:unit": "node --env-file=.env.defaults --test src/**/*.test.ts" }), []);
    assert.deepEqual(check({ "test:unit": "node --env-file-if-exists=.env.defaults --test" }), []);
    assert.deepEqual(
        check({ "test:unit": "node --env-file-if-exists=../plurnk-execs/.env.defaults --test" }),
        ["test-floor: plurnk-x test:unit — 1 found, allowance 0"],
    );
    assert.deepEqual(envSurfaceViolations({ panels: [], sources: [], corpus: [], manifests: [manifest({ "test:unit": "node --test" })], allowance: {} }), []);
    assert.deepEqual(check({ "test:unit": "npm run build" }), []);
});

test("{§lint-gate} a number whose name says duration, size or limit is a choice, unless the register says why it is mechanism", () => {
    const sources = [source("const POLL_INTERVAL_MS = 250;\nclass A { static readonly PAGE_LIMIT = 50; static #RETRY_MAX = 3; }\nconst TEXT_NODE = 3;\nlet depth = 0;")];
    const check = (mechanism) => envSurfaceViolations({ panels: [], sources, corpus: sources, allowance: {}, mechanism });
    assert.deepEqual(check({}).map((violation) => violation.split(" — ")[0]), [
        "tunable: plurnk-x/src/thing.ts:PAGE_LIMIT",
        "tunable: plurnk-x/src/thing.ts:POLL_INTERVAL_MS",
        "tunable: plurnk-x/src/thing.ts:RETRY_MAX",
    ]);
    const register = {
        "plurnk-x/src/thing.ts:PAGE_LIMIT": "the protocol's own page size",
        "plurnk-x/src/thing.ts:POLL_INTERVAL_MS": "internal cadence",
        "plurnk-x/src/thing.ts:RETRY_MAX": "protocol resilience",
    };
    assert.deepEqual(check(register), []);
    assert.deepEqual(check({ ...register, "plurnk-x/src/thing.ts:RETRY_MAX": " " }), ["tunable: plurnk-x/src/thing.ts:RETRY_MAX — the register gives no reason"]);
    assert.deepEqual(check({ ...register, "plurnk-x/src/gone.ts:OLD_LIMIT": "was here" }), ["tunable: plurnk-x/src/gone.ts:OLD_LIMIT — registered as mechanism but gone; strike it from the register"]);
});

test("{§lint-gate} a bare number handed to a timer or a deadline is named or read from the panel; it has no register", () => {
    const bare = source("setTimeout(tick, 5000);\nawait delay(150, undefined, { signal });\nconst signal = AbortSignal.timeout(30_000);");
    assert.deepEqual(run({ sources: [bare] }), ["timer-literal: plurnk-x/src/thing.ts — 3 found, allowance 0"]);
    const named = source("setTimeout(tick, TICK_MS);\nawait delay(Knob.integer(\"PLURNK_X_POLL\", 1));\nsetTimeout(tick, 0);");
    assert.deepEqual(run({ panels: [panel("PLURNK_X_POLL=150\n")], sources: [named] }).filter((violation) => violation.startsWith("timer-literal")), []);
});

const range = (names) => Object.fromEntries(names.map((name) => [`@plurnk/${name}`, "^1.0.0"]));
const workspace = (name, dependencies = [], peerDependencies = []) => ({
    file: `${name}/package.json`,
    manifest: { name: `@plurnk/${name}`, dependencies: range(dependencies), peerDependencies: range(peerDependencies) },
});

test("{§lint-gate} package graph policy enforces layered acyclic stability", async () => {
    assert.deepEqual(packageGraphViolations([
        workspace("contracts"),
        workspace("schemes", ["contracts"]),
        workspace("leaf", [], ["schemes"]),
        workspace("service", ["contracts", "schemes", "leaf"]),
    ]), []);

    const cycleViolations = packageGraphViolations([
        workspace("contracts"),
        workspace("hooks", ["contracts"], ["service"]),
        workspace("service", ["contracts", "hooks"]),
    ]);
    assert.ok(
        cycleViolations.includes("package cycle among @plurnk/hooks, @plurnk/service, against the Acyclic Dependencies principle (ARCHITECTURE.md § Package principles)"),
        cycleViolations.join("\n"),
    );

    const stabilityViolations = packageGraphViolations([
        workspace("contracts"),
        workspace("util"),
        workspace("impl", ["contracts", "util"]),
        workspace("api", ["impl"]),
        workspace("left", ["api"]),
        workspace("right", ["api"]),
    ]);
    assert.deepEqual(stabilityViolations, [
        "api/package.json: dependencies.@plurnk/impl is less stable than this package (instability 2/3 against 1/3), against the Stable Dependencies principle (ARCHITECTURE.md § Package principles)",
    ]);

    const devFixture = workspace("contracts");
    devFixture.manifest.devDependencies = range(["service"]);
    assert.deepEqual(packageGraphViolations([devFixture, workspace("service", ["contracts"])]), []);

    const root = path.resolve(import.meta.dirname, "..");
    const { workspaces } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const entries = await Promise.all(workspaces.map(async (dir) => ({
        file: `${dir}/package.json`,
        manifest: JSON.parse(await fs.readFile(path.join(root, dir, "package.json"), "utf8")),
    })));
    assert.deepEqual(packageGraphViolations(entries), []);
});

test("{§module-seam-slices} a module peers on the contract; only the host depends on it", () => {
    const entry = (name, sections, importsContract = true) => ({ file: `${name}/package.json`, manifest: { name: `@plurnk/${name}`, ...sections }, importsContract });
    const contract = { "@plurnk/plurnk-modules": "^1.29.0" };
    assert.deepEqual(moduleContractViolations([
        entry("plurnk-service", { dependencies: contract }),
        entry("plurnk-peer", { peerDependencies: contract }),
        entry("plurnk-unrelated", {}, false),
    ]), []);
    assert.deepEqual(moduleContractViolations([entry("plurnk-direct", { dependencies: contract })]), [
        "plurnk-direct/package.json: a module declares @plurnk/plurnk-modules as a peer dependency ({§module-seam-slices})",
        "plurnk-direct/package.json: dependencies.@plurnk/plurnk-modules must be a peer dependency ({§module-seam-slices})",
    ]);
});

describe("default grammar and dependency policy", () => {
    const leaf = ({ slug }) => `@plurnk/plurnk-mimetypes-grammar-${slug}`;
    const dependencies = Object.fromEntries(TREE_SITTER_REGISTRY.filter(({ optional }) => optional !== true).map((entry) =>
        [leaf(entry), "1.0.0"]));
    const optionalLeaves = [...new Set(TREE_SITTER_REGISTRY.filter(({ optional }) => optional === true).map(leaf))];

    it("{§bundled-set} requires every registered non-optional grammar as a service runtime dependency", async () => {
        const manifest = JSON.parse(await readFile(new URL("../plurnk-core/package.json", import.meta.url), "utf8"));
        assert.deepEqual(defaultGrammarViolations(manifest), []);
        assert.deepEqual(defaultGrammarViolations({ dependencies }), []);
        assert.deepEqual(defaultGrammarViolations({ dependencies, devDependencies: Object.fromEntries(optionalLeaves.map((name) => [name, "1.0.0"])) }), []);
        for (const section of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
            const { "@plurnk/plurnk-mimetypes-grammar-cpp": cpp, ...rest } = dependencies;
            assert.deepEqual(defaultGrammarViolations({
                dependencies: rest,
                [section]: { "@plurnk/plurnk-mimetypes-grammar-cpp": cpp },
            }), ["plurnk-core/package.json: dependencies.@plurnk/plurnk-mimetypes-grammar-cpp is required by {§bundled-set}"]);
        }
    });

    it("{§mimetype-grammar-packages} refuses an optional grammar package in the default composition", () => {
        assert.ok(optionalLeaves.length > 0, "the registry declares at least one optional grammar");
        assert.deepEqual(defaultGrammarViolations({
            dependencies: { ...dependencies, ...Object.fromEntries(optionalLeaves.map((name) => [name, "1.0.0"])) },
        }), optionalLeaves.map((name) =>
            `plurnk-core/package.json: dependencies.${name} is an optional grammar package and must not ship by default ({§mimetype-grammar-packages})`));
    });

    it("{§lint-gate} enforces install-script review and root-only npm configuration", () => {
        assert.deepEqual(installScriptViolations({ allowScripts: [] }), []);
        assert.deepEqual(installScriptViolations({
            allowScripts: [{
                name: "esbuild",
                changes: [{ key: "esbuild@0.28.2", change: "pending" }],
            }],
        }), ["package.json: allowScripts does not review esbuild@0.28.2"]);
        assert.throws(() => installScriptViolations({}), {
            name: "TypeError",
            message: "npm install-scripts returned an invalid allowScripts report",
        });
        assert.deepEqual(workspaceNpmConfigViolations(["plurnk-core/.npmrc"]), [
            "plurnk-core/.npmrc: npm ignores workspace-local configuration; declare repository policy in the root .npmrc",
        ]);
    });
});

test("{§host-path-layout} {§test-artifact-retention} host path policy rejects direct home reconstruction outside the owning resolvers", () => {
    assert.deepEqual(
        hostPathViolations([{ name: "scripts/tool.mjs", content: 'resolve(homedir(), ".config", "plurnk")' }]),
        ["scripts/tool.mjs: reconstructs a host path from homedir() outside plurnk-core/src/core/HostPaths.ts or scripts/lib/benchmarks-root.mjs"],
    );
    assert.deepEqual(
        hostPathViolations([{ name: "pkg/path.ts", content: 'join(homedir(), ".local", "share")' }]),
        ["pkg/path.ts: reconstructs a host path from homedir() outside plurnk-core/src/core/HostPaths.ts or scripts/lib/benchmarks-root.mjs"],
    );
    assert.deepEqual(hostPathViolations([
        { name: "plurnk-core/src/core/HostPaths.ts", content: 'resolve(homedir(), ".config")' },
        { name: "scripts/lib/benchmarks-root.mjs", content: 'join(homedir(), "benchmarks")' },
        { name: "plurnk-core/src/example.test.ts", content: 'join(homedir(), ".cache")' },
    ]), []);
});

test("{§lint-gate} package lifecycle policy enforces canonical test composition, no consumer prepare, and quoted globs", () => {
    const complete = {
        "test:lint": "tsc --noEmit",
        "test:unit": "node --test src/*.test.js",
        "test:intg": "node --test test/intg/*.test.js",
        test: "npm run test:lint && npm run test:unit && npm run test:intg",
    };
    assert.equal(canonicalTestCommand(complete), complete.test);
    assert.deepEqual(packageLifecycleViolations("complete", { scripts: complete }), []);

    const partial = {
        "test:lint": "tsc --noEmit",
        "test:intg": "node --test test/intg/*.test.js",
        test: "npm run test:lint && npm run test:intg",
    };
    assert.equal(canonicalTestCommand(partial), partial.test);
    assert.deepEqual(packageLifecycleViolations("parser", { scripts: partial }), []);

    assert.deepEqual(packageLifecycleViolations("missing", {
        scripts: { "test:unit": "node --test" },
    }), ["missing: test must be `npm run test:unit`"]);

    assert.deepEqual(packageLifecycleViolations("hidden", {
        scripts: {
            "test:unit": "node --test test/unit/*.test.js",
            "test:integration": "node --test test/integration/*.test.js",
            test: "npm run test:unit && npm run test:integration",
        },
    }), [
        "hidden: test must be `npm run test:unit`",
        "hidden: test:integration is not a classified test lifecycle script",
    ]);

    assert.deepEqual(packageLifecycleViolations("classified", {
        scripts: {
            "test:lint": "tsc --noEmit",
            "test:unit": "node --test",
            test: "npm run test:lint && npm run test:unit",
            "test:live": "node --test test/live/*.test.js",
            "test:installation": "node scripts/test-installation.js",
        },
    }), []);

    assert.deepEqual(packageLifecycleViolations("empty", {
        scripts: { test: "node --test" },
    }), [
        "empty: declare at least one of test:lint, test:unit, or test:intg",
        "empty: test must be absent until a canonical tier exists",
    ]);

    assert.deepEqual(packageLifecycleViolations("consumer-script", {
        scripts: {
            prepare: "npm run build",
            "test:unit": "node --test",
            test: "npm run test:unit",
        },
    }), [
        "consumer-script: prepare runs in package consumers; build checkout state at the root and packed artifacts through prepack",
    ]);

    const quoted = { "test:unit": "node --test 'src/**/*.test.ts' \"scripts/**/*.test.mjs\"", test: "npm run test:unit" };
    assert.deepEqual(packageLifecycleViolations("quoted", { scripts: quoted }), []);
    assert.deepEqual(packageLifecycleViolations("bare", { scripts: { ...quoted, "test:unit": "node --test src/**/*.test.ts" } }),
        ["bare: test:unit spells the glob src/**/*.test.ts unquoted; sh expands ** one level, so quote it for node"]);
});

const AUTHOR = identity("an-agent", "agent@example.invalid");
const COMMITTER = identity("a-maintainer", "maintainer@example.invalid");
const POLICY = { authors: new Set([AUTHOR]), committer: COMMITTER };
const validCommit = {
    sha: "a".repeat(40),
    authorName: "an-agent",
    authorEmail: "agent@example.invalid",
    committerName: "a-maintainer",
    committerEmail: "maintainer@example.invalid",
    signature: "G",
};

test("{§lint-gate} commit provenance validates signatures and configured author/committer identities", () => {
    assert.deepEqual(validateCommit(validCommit, POLICY), []);
    assert.match(validateCommit({ ...validCommit, authorName: "someone", authorEmail: "someone@example.invalid" }, POLICY)[0], /unexpected author/u);
    assert.match(validateCommit({ ...validCommit, committerName: "an-agent", committerEmail: "agent@example.invalid" }, POLICY)[0], /unexpected committer/u);
    assert.match(validateCommit({ ...validCommit, signature: "N" }, POLICY)[0], /signature status/u);
    assert.match(validateCommit({ ...validCommit, signature: "N" })[0], /signature status/u);
    assert.deepEqual(validateCommit({ ...validCommit, authorName: "anyone", authorEmail: "anyone@example.invalid" }), []);
});

test("{§lint-gate} conventional branch and commit-message rules enforce bounded one-line subjects", () => {
    for (const type of CONVENTIONAL_TYPES) {
        assert.deepEqual(validateBranchName(`${type}/project-lifecycle`), [], type);
        assert.deepEqual(validateCommitMessage(`${type}(project): normalize lifecycle\n`), [], type);
    }
    assert.deepEqual(validateBranchName("main"), []);
    assert.match(validateBranchName("feature/project-lifecycle")[0], /main or type\/kebab-slug/);
    assert.match(validateBranchName("feat/Project Lifecycle")[0], /main or type\/kebab-slug/);
    assert.match(validateBranchName("feat/not_kebab")[0], /main or type\/kebab-slug/);
    assert.deepEqual(validateCommitMessage("Merge branch 'feat/example'\n"), []);
    assert.deepEqual(validateCommitMessage("Revert \"feat: example\"\n"), []);
    assert.match(validateCommitMessage("Update lifecycle\n")[0], /type\(scope\): summary/);
    assert.match(validateCommitMessage(`fix: ${"x".repeat(100)}\n`)[0], /exceeds 100 characters/);
    assert.match(validateCommitMessage("fix: lifecycle\n\nExplanation.\n")[0], /one-liner doctrine/);
    assert.match(validateCommitMessage("fix: lifecycle\n\nCo-Authored-By: someone\n")[0], /one-liner doctrine/);
    assert.deepEqual(validateCommitMessage("fix: lifecycle\n\n# template guidance\n"), []);
});
