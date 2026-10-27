import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Meta from "@plurnk/plurnk-meta";
import { PROVIDERS_KNOBS } from "@plurnk/plurnk-providers";
import EnvFlags from "./EnvFlags.ts";
import EnvCatalog from "./env-catalog.ts";
import EnvDefaults from "./env-defaults.ts";
import OperatorConfig from "./OperatorConfig.ts";
import { hermeticGitEnv } from "./git-env.ts";

describe("EnvFlags", () => {
test("{§operator-config-precedence} parseEnvDefaultsContent: simple var with single-line description", () => {
    const content = `# SQLite file path.
PLURNK_SERVICE_DB_PATH=./plurnk.db`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].flagName, "--service-db-path");
    assert.equal(flags[0].envName, "PLURNK_SERVICE_DB_PATH");
    assert.equal(flags[0].defaultValue, "./plurnk.db");
    assert.equal(flags[0].description, "SQLite file path.");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: multi-line description joins with spaces", () => {
    const content = `# A description that spans several comment lines
# and should fold into a single string,
# joined with single spaces.
PLURNK_SOME_KNOB=256`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].flagName, "--some-knob");
    assert.match(flags[0].description ?? "", /^A description that spans several comment lines and should/);
    assert.match(flags[0].description ?? "", /joined with single spaces/);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: section delimiter resets description buffer", () => {
    const content = `# --- Storage ---
PLURNK_SERVICE_DB_PATH=./plurnk.db`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null, "section delimiter does NOT become description");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: blank line between comment and var resets buffer", () => {
    const content = `# This comment is for nothing in particular.

PLURNK_SERVICE_DB_PATH=./plurnk.db`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: section delimiter then comment then var — only the comment is description", () => {
    const content = `# --- Storage ---
# SQLite file path.
PLURNK_SERVICE_DB_PATH=./plurnk.db`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags[0].description, "SQLite file path.");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: var without comment has null description", () => {
    const content = `PLURNK_MAGIC_NUMBER=42`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: empty-comment-line resets buffer", () => {
    const content = `# desc 1
#
# desc 2
PLURNK_X=foo`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags[0].description, "desc 2");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: an optional knob's commented declaration ends its own description", () => {
    const flags = EnvFlags.parseEnvDefaultsContent([
        "# Default child model.",
        "# PLURNK_MODEL_CHILD=fast",
        "# Turn ceiling; -1 = none.",
        "PLURNK_SERVICE_MAX_TURNS=-1",
    ].join("\n"));
    assert.deepEqual(flags.map(({ envName, description }) => [envName, description]), [["PLURNK_SERVICE_MAX_TURNS", "Turn ceiling; -1 = none."]]);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: a family's commented declaration ends its own description", () => {
    const flags = EnvFlags.parseEnvDefaultsContent([
        "# Any alias: its glob, and its own _ENABLED control.",
        "# PLURNK_MEMBERS_<alias>=<glob>",
        "# Matched paths a members definition lists as its sample.",
        "PLURNK_SERVICE_MEMBERS_SAMPLE=20",
    ].join("\n"));
    assert.deepEqual(flags.map(({ envName, description }) => [envName, description]),
        [["PLURNK_SERVICE_MEMBERS_SAMPLE", "Matched paths a members definition lists as its sample."]]);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: strips quotes from default values", () => {
    const content = `# desc
PLURNK_QUOTED="hello world"`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags[0].defaultValue, "hello world");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: ignores non-PLURNK_ variables", () => {
    const content = `# desc
OPENAI_API_KEY=foo
# desc
PLURNK_X=bar`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].envName, "PLURNK_X");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: kebab-cases the flag name from snake_case env", () => {
    const flags = EnvFlags.parseEnvDefaultsContent("# desc\nPLURNK_SOME_LONG_NAME=value");
    assert.equal(flags[0].flagName, "--some-long-name");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: parses the actual plurnk-service .env.defaults shape", () => {
    const content = `# plurnk-service environment cascade.
#
# Override order.

# --- Storage ---
# SQLite file path.
PLURNK_SERVICE_DB_PATH=./plurnk_dev.db

# --- Diagnostics ---
# When 1, enables debug.
PLURNK_SERVICE_DEBUG=0`;

    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 2);

    const byEnv = Object.fromEntries(flags.map((f) => [f.envName, f]));
    assert.equal(byEnv.PLURNK_SERVICE_DB_PATH.flagName, "--service-db-path");
    assert.equal(byEnv.PLURNK_SERVICE_DB_PATH.description, "SQLite file path.");
    assert.equal(byEnv.PLURNK_SERVICE_DEBUG.flagName, "--service-debug");
});

test("{§operator-config-precedence} formatFlagsHelp: undescribed flags still appear (terse fallback to env=default)", () => {
    const flags = [
        { flagName: "--db-path", envName: "PLURNK_SERVICE_DB_PATH", defaultValue: "./db", description: "SQLite path" },
        { flagName: "--magic", envName: "PLURNK_MAGIC", defaultValue: "42", description: null },
    ];
    const help = EnvFlags.formatFlagsHelp(flags);
    assert.match(help, /--db-path.*SQLite path/);
    assert.match(help, /--magic.*PLURNK_MAGIC=42/);
});

test("{§operator-config-precedence} formatFlagsHelp: described flag shows description + env=default on one line", () => {
    const flags = [
        { flagName: "--db-path", envName: "PLURNK_SERVICE_DB_PATH", defaultValue: "./db", description: "SQLite path" },
    ];
    const help = EnvFlags.formatFlagsHelp(flags);
    assert.match(help, /SQLite path\s+\(PLURNK_SERVICE_DB_PATH=\.\/db\)/);
});
});

describe("flag-parity", () => {
const root = fileURLToPath(new URL("../..", import.meta.url));
const DYNAMIC_READS = new Set(["PLURNK_SERVICE_LIVE_TIMEOUT"]);
const DYNAMIC_PREFIXES = ["PLURNK_SERVICE_SQLITE_", "PLURNK_SERVICE_RECAP_LINE_"];

test("{§operator-config-precedence} every shipped service flag has an adjacent description for CLI help", () => {
    const template = readFileSync(`${root}/.env.defaults`, "utf8");
    const flags = EnvFlags.parseEnvDefaultsContent(template);
    assert.ok(flags.length > 0);
    assert.deepEqual(flags.filter(({ description }) => description === null).map(({ envName }) => envName), [],
        "active knobs need a local explanation, not just a distant section introduction");
    const help = EnvFlags.formatFlagsHelp(flags);
    for (const { flagName, envName } of flags) {
        assert.ok(help.includes(flagName), `${envName} must remain discoverable in help`);
    }
});

test("{§operator-config-precedence} every PLURNK_SERVICE_* the code reads is in .env.defaults, and vice versa", () => {
    const template = readFileSync(`${root}/.env.defaults`, "utf8");
    const declared = new Set(
        [...template.matchAll(/^#?\s*(PLURNK_SERVICE_[A-Z0-9_]+)=/gm)].map((m) => m[1]),
    );

    const srcFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src/*.ts", "src/**/*.ts", "src/**/*.sql"], { cwd: root, encoding: "utf8", env: hermeticGitEnv() }).trim().split("\n").filter((f) => f.length > 0 && !f.endsWith(".test.ts") && existsSync(`${root}/${f}`));
    const read = new Set<string>();
    for (const f of srcFiles) {
        for (const m of readFileSync(`${root}/${f}`, "utf8").matchAll(/\bPLURNK_SERVICE_[A-Z0-9_]+\b/g)) read.add(m[0]);
    }

    const underDynamicPrefix = (flag: string) => DYNAMIC_PREFIXES.some((p) => flag.startsWith(p) && flag !== p.slice(0, -1));

    const declaredNotRead = [...declared].filter((f) => !read.has(f) && !DYNAMIC_READS.has(f) && !underDynamicPrefix(f));
    assert.deepEqual(declaredNotRead, [], `declared in .env.defaults but never read by src (dead flags?): ${declaredNotRead.join(", ")}`);

    const readNotDeclared = [...read].filter((f) => !declared.has(f) && !DYNAMIC_READS.has(f) && !underDynamicPrefix(f));
    assert.deepEqual(readNotDeclared, [], `read by src but missing from .env.defaults (no floor, no --flag): ${readNotDeclared.join(", ")}`);
});
});

describe("shipped-defaults", () => {
const shippedEnv = async (): Promise<Map<string, string>> => {
    const raw = await readFile(new URL("../../.env.defaults", import.meta.url), "utf8");
    const env = new Map<string, string>();
    for (const line of raw.split("\n")) {
        const m = /^([A-Z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (m) {
            assert.equal(env.has(m[1]), false, `.env.defaults declares ${m[1]} more than once`);
            env.set(m[1], m[2].replace(/^"|"$/g, ""));
        }
    }
    return env;
};

test("{§operator-config-precedence} the template ships no double policy, no active model, ONLY service-owned knobs", async () => {
    const env = await shippedEnv();
    assert.equal(env.get("PLURNK_MODEL"), undefined, "no active PLURNK_MODEL ships");
    const SERVICE_OWNED = /^(PLURNK_SERVICE_|PLURNK_EXTENSIONS_|PLURNK_MEMBERS_)/;
    const foreign = [...env.keys()].filter((k) => !SERVICE_OWNED.test(k));
    assert.deepEqual(foreign, [], `the template declares only service-owned knobs; foreign: ${foreign.join(", ")}`);
    assert.equal(env.get("PLURNK_SERVICE_MAX_TURNS"), "-1", "model-call ceilings are opt-in, not a lifetime allowance");
    assert.equal(env.get("PLURNK_SERVICE_PREVIEW_LINES"), "100", "the only correct default is 100");
    assert.equal(env.get("PLURNK_SERVICE_PREVIEW_CHARS"), "16000");
    assert.equal(env.get("PLURNK_SERVICE_EMISSION_HISTORY"), "all");
    assert.equal(env.get("PLURNK_SERVICE_REASONING_ROWS"), "0");
    assert.equal(env.get("PLURNK_SERVICE_BUDGET_PRESSURE"), "80%", "the gauge names its largest rows only above eighty percent");
    assert.equal(env.get("PLURNK_SERVICE_BUDGET_LARGEST_ITEMS"), "5", "the pressured gauge names the five largest retained rows");
    assert.equal(env.get("PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES"), "104857600", "filesystem snapshots ship with a 100 MiB safety ceiling");
});

test("{§operator-config-precedence} a key the daemon and its clients both read is declared by contracts, and only there", async () => {
    const contracts = await readFile(new URL("../../../plurnk-contracts/.env.defaults", import.meta.url), "utf8");
    const declared = new Map([...contracts.matchAll(/^(?:# )?(PLURNK_[A-Z_]+)=(.*)$/gmu)].map((match) => [match[1], match[2]]));
    assert.deepEqual([...declared.keys()], ["PLURNK_HOST", "PLURNK_PORT", "PLURNK_ACP_URL", "PLURNK_AUTH", "PLURNK_SECRET", "PLURNK_PASS"]);
    assert.equal(declared.get("PLURNK_HOST"), "127.0.0.1", "local-only unless the operator says otherwise");
    assert.equal(declared.get("PLURNK_AUTH"), "1", "authenticated unless the operator says otherwise");
    assert.equal(declared.get("PLURNK_SECRET"), "", "no shipped secret; the daemon mints one per boot");
    const core = await shippedEnv();
    for (const key of declared.keys()) assert.equal(core.get(key), undefined, `${key} has one owner, and it is not the service`);
});

test("{§operator-config-precedence} the installed panels declare every family their packages read, and a fresh seed draws no notice", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const { files } = await EnvDefaults.collect(root, Meta.nearestNodeModules(root) ?? join(root, "node_modules"));
    const declares = EnvCatalog.declares(files);
    const computed = [
        ...PROVIDERS_KNOBS.map((knob) => `${knob}_fixture`),
        "PLURNK_PROVIDERS_GBNF_fixture",
        "PLURNK_MODEL_fixture", "PLURNK_BASEURL_fixture",
        "PLURNK_PROVIDERS_PROVIDER_XIAOMI_REASONING_EFFORTS",
        "PLURNK_EXECS_JS",
        ...["MCP", "SCHEDULE", "MEMBERS"].flatMap((family) => [`PLURNK_${family}_fixture`, `PLURNK_${family}_fixture_ENABLED`]),
        "PLURNK_MCP_fixture_TOOLS", "PLURNK_SKILLS_分析", "PLURNK_SKILLS_分析_ENABLED",
    ];
    assert.deepEqual(computed.filter((key) => !declares(key)), [], "a key a package reads by a computed name belongs to a declared family");
    assert.deepEqual(OperatorConfig.undeclared(OperatorConfig.renderSeed(), declares), []);
});
});
