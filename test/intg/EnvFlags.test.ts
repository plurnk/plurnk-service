import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvExampleContent, formatFlagsHelp } from "../../src/core/EnvFlags.ts";

test("parseEnvExampleContent: simple var with single-line description", () => {
    const content = `# SQLite file path.
PLURNK_DB_PATH=./plurnk.db`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].flagName, "--db-path");
    assert.equal(flags[0].envName, "PLURNK_DB_PATH");
    assert.equal(flags[0].defaultValue, "./plurnk.db");
    assert.equal(flags[0].description, "SQLite file path.");
});

test("parseEnvExampleContent: multi-line description joins with spaces", () => {
    const content = `# Per-channel head/tail token budget for index preview tiles. The scheme
# declares orientation (head/tail) via SchemeRegistration.channel_orientations;
# this knob decides how many tokens to render from that orientation.
PLURNK_ENTRY_SIZE_DEFAULT_TOKENS=256`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].flagName, "--entry-size-default-tokens");
    assert.match(flags[0].description ?? "", /^Per-channel head\/tail token budget/);
    assert.match(flags[0].description ?? "", /how many tokens to render/);
});

test("parseEnvExampleContent: section delimiter resets description buffer", () => {
    const content = `# --- Storage ---
PLURNK_DB_PATH=./plurnk.db`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null, "section delimiter does NOT become description");
});

test("parseEnvExampleContent: blank line between comment and var resets buffer", () => {
    const content = `# This comment is for nothing in particular.

PLURNK_DB_PATH=./plurnk.db`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null);
});

test("parseEnvExampleContent: section delimiter then comment then var — only the comment is description", () => {
    const content = `# --- Storage ---
# SQLite file path.
PLURNK_DB_PATH=./plurnk.db`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags[0].description, "SQLite file path.");
});

test("parseEnvExampleContent: var without comment has null description", () => {
    const content = `PLURNK_MAGIC_NUMBER=42`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null);
});

test("parseEnvExampleContent: empty-comment-line resets buffer", () => {
    const content = `# desc 1
#
# desc 2
PLURNK_X=foo`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags[0].description, "desc 2");
});

test("parseEnvExampleContent: strips quotes from default values", () => {
    const content = `# desc
PLURNK_QUOTED="hello world"`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags[0].defaultValue, "hello world");
});

test("parseEnvExampleContent: ignores non-PLURNK_ variables", () => {
    const content = `# desc
OPENAI_API_KEY=foo
# desc
PLURNK_X=bar`;
    const flags = parseEnvExampleContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].envName, "PLURNK_X");
});

test("parseEnvExampleContent: kebab-cases the flag name from snake_case env", () => {
    const flags = parseEnvExampleContent("# desc\nPLURNK_SOME_LONG_NAME=value");
    assert.equal(flags[0].flagName, "--some-long-name");
});

test("parseEnvExampleContent: parses the actual plurnk-service .env.example shape", () => {
    const content = `# plurnk-service environment cascade.
#
# Override order.

# --- Storage ---
# SQLite file path.
PLURNK_DB_PATH=./plurnk_dev.db

# --- Rendering ---
# Per-channel head/tail token budget for index preview tiles. The scheme declares
# orientation (head/tail).
PLURNK_ENTRY_SIZE_DEFAULT_TOKENS=256

# --- Diagnostics ---
# When 1, enables debug.
PLURNK_DEBUG=0`;

    const flags = parseEnvExampleContent(content);
    assert.equal(flags.length, 3);

    const byEnv = Object.fromEntries(flags.map((f) => [f.envName, f]));
    assert.equal(byEnv.PLURNK_DB_PATH.flagName, "--db-path");
    assert.equal(byEnv.PLURNK_DB_PATH.description, "SQLite file path.");
    assert.equal(byEnv.PLURNK_ENTRY_SIZE_DEFAULT_TOKENS.flagName, "--entry-size-default-tokens");
    assert.match(byEnv.PLURNK_ENTRY_SIZE_DEFAULT_TOKENS.description ?? "", /Per-channel/);
    assert.equal(byEnv.PLURNK_DEBUG.flagName, "--debug");
});

test("formatFlagsHelp: hidden (no description) flags are omitted from help", () => {
    const flags = [
        { flagName: "--db-path", envName: "PLURNK_DB_PATH", defaultValue: "./db", description: "SQLite path" },
        { flagName: "--magic", envName: "PLURNK_MAGIC", defaultValue: "42", description: null },
    ];
    const help = formatFlagsHelp(flags);
    assert.match(help, /--db-path/);
    assert.match(help, /SQLite path/);
    assert.doesNotMatch(help, /--magic/);
});

test("formatFlagsHelp: includes default value and env var name", () => {
    const flags = [
        { flagName: "--db-path", envName: "PLURNK_DB_PATH", defaultValue: "./db", description: "SQLite path" },
    ];
    const help = formatFlagsHelp(flags);
    assert.match(help, /default: "\.\/db"/);
    assert.match(help, /env: PLURNK_DB_PATH/);
});
