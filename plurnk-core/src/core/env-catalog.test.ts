import test from "node:test";
import assert from "node:assert/strict";
import EnvCatalog from "./env-catalog.ts";

const FILES = [
    {
        owner: "@plurnk/plurnk-execs",
        parsed: {},
        text: [
            "# Comma-separated allowlist; unset = all discovered runtimes.",
            "# PLURNK_EXECS_ONLY=sh,jq",
            "# A pager that waits for a keypress hangs a spawn that has no terminal.",
            "PAGER=cat",
            "# Colour escapes are noise in a captured channel.",
            "NO_COLOR=1",
        ].join("\n"),
    },
    {
        owner: "@plurnk/plurnk-mcp",
        parsed: {},
        text: "# Connection and protocol-discovery deadline, positive ms.\nPLURNK_MCP_CONNECT_TIMEOUT=30000",
    },
];

test("EnvCatalog.declarations carries each knob's own comment, and a commented knob is a knob", () => {
    const found = EnvCatalog.declarations(FILES[0]!.text);
    assert.deepEqual(found.map(({ name }) => name), ["PLURNK_EXECS_ONLY", "PAGER", "NO_COLOR"],
        "an optional declaration is written commented out; it stays findable by name");
    assert.match(found[1]!.text, /keypress hangs a spawn/u, "a declaration carries the comment that introduces it");
});

test("EnvCatalog.project with no query is the whole catalog", () => {
    const all = EnvCatalog.project(FILES);
    assert.match(all, /PAGER=cat/u);
    assert.match(all, /PLURNK_MCP_CONNECT_TIMEOUT=30000/u);
    assert.match(all, /═══ @plurnk\/plurnk-execs ═══/u, "owner-labelled, in the same form `config defaults` prints");
});

test("EnvCatalog.project filters by owning package", () => {
    const mcp = EnvCatalog.project(FILES, { source: "@plurnk/plurnk-mcp" });
    assert.match(mcp, /PLURNK_MCP_CONNECT_TIMEOUT/u);
    assert.doesNotMatch(mcp, /PAGER/u, "a source filter answers 'what does this package let me change'");
});

test("EnvCatalog.project matches the declaration name or its comment, never its value", () => {
    const pager = EnvCatalog.project(FILES, { query: "pager" });
    assert.match(pager, /PAGER=cat/u);
    assert.doesNotMatch(pager, /PLURNK_MCP_CONNECT_TIMEOUT/u);
    // A Worker looks for a variable by what it is for before it knows what it is called.
    const deadline = EnvCatalog.project(FILES, { query: "deadline" });
    assert.match(deadline, /PLURNK_MCP_CONNECT_TIMEOUT/u, "the comment that documents a name is a match");
    assert.doesNotMatch(deadline, /PAGER=cat/u);
    // `cat` is the VALUE of PAGER. Matching values would hand the model bytes it did not ask
    // to see; the model's own context hygiene is reason enough, before any secrecy argument.
    assert.equal(EnvCatalog.project(FILES, { query: "cat" }).includes("PAGER=cat"), false,
        "a value match is not a match");
});

test("EnvCatalog.project keeps the comment with its declaration when filtered", () => {
    const one = EnvCatalog.project(FILES, { query: "NO_COLOR" });
    assert.match(one, /# Colour escapes are noise in a captured channel\.\nNO_COLOR=1/u,
        "a filtered declaration arrives documented, which is the point of projecting the source text");
});

test("EnvCatalog.project drops a package with no match rather than rendering an empty section", () => {
    assert.doesNotMatch(EnvCatalog.project(FILES, { query: "PAGER" }), /plurnk-mcp/u);
});

// {§functionality-model-projection} — discover returns structured candidates, not rendered text:
// the family contract requires one addable definition per candidate. The declaration's comment
// becomes the candidate's summary and the owning package its provenance, so the documentation
// moves into the field that exists for it rather than being lost.
test("EnvCatalog.candidates carries the comment as summary and the package as provenance", () => {
    const [first] = EnvCatalog.candidates(FILES, { query: "PAGER" });
    assert.equal(first!.alias, "PAGER");
    assert.equal(first!.summary, "A pager that waits for a keypress hangs a spawn that has no terminal.");
    assert.deepEqual(first!.definition, { value: "cat" });
    assert.equal(first!.provenance.source, "@plurnk/plurnk-execs");
});

test("EnvCatalog.candidates drops a section header, which introduces a region and not a key", () => {
    const [only] = EnvCatalog.candidates([{
        owner: "@plurnk/x", parsed: {},
        text: "# ── Defaults (floor-set) ───────────────\n# The real documentation.\nTHING=1",
    }]);
    assert.equal(only!.summary, "The real documentation.", "prose never begins with a run of rule characters");
});

// The security property the ceiling exists for, at the discovery surface: the catalog projects
// what a package DECLARED, never what the operator filled in. A model learns the name and the
// purpose so it can ask for the key by name, and never sees the value.
test("EnvCatalog.candidates projects the declared value, never an operator's", () => {
    const [credential] = EnvCatalog.candidates([{
        owner: "@plurnk/plurnk-tavily-plugin", parsed: {},
        text: "# Tavily API key; unset disables the materializer.\nTAVILY_API_KEY=",
    }]);
    assert.equal(credential!.definition.value, "", "the declaration is empty even when the host has one set");
    assert.match(credential!.summary!, /unset disables/u, "the model learns what it is for, so it can ask by name");
});

test("EnvCatalog.candidates omits summary rather than inventing one", () => {
    const [bare] = EnvCatalog.candidates([{ owner: "@plurnk/x", parsed: {}, text: "BARE=1" }]);
    assert.equal(bare!.summary, undefined, "a templated instance is self-documenting; an empty string would be a lie");
});

// {§operator-config-undeclared-key} — a `<placeholder>` in a declared name declares a family.
const FAMILIES = {
    owner: "@plurnk/plurnk-fixture",
    parsed: {},
    text: [
        "# Per-alias switch.",
        "PLURNK_FIXTURE_EFFORT=adaptive",
        "# PLURNK_FIXTURE_BUDGET=8192",
        "# Any alias: its definition and its own controls.",
        "# PLURNK_FIXTURE_DEF_<alias>=<definition>",
        "# PLURNK_FIXTURE_PROVIDER_<NAME>_<SETTING>=<value>",
        "# What a pager does.",
        "PAGER=cat",
    ].join("\n"),
};

test("{§operator-config-undeclared-key} a family declaration is its own declaration, never prose documenting the next key", () => {
    const found = EnvCatalog.declarations(FAMILIES.text);
    assert.deepEqual(found.map(({ name }) => name), [
        "PLURNK_FIXTURE_EFFORT", "PLURNK_FIXTURE_BUDGET", "PLURNK_FIXTURE_DEF_<alias>", "PLURNK_FIXTURE_PROVIDER_<NAME>_<SETTING>", "PAGER",
    ]);
    assert.equal(found.at(-1)!.text, "# What a pager does.\nPAGER=cat", "the family's lines stay with the family");
    assert.deepEqual(EnvCatalog.candidates([FAMILIES]).map(({ alias }) => alias), ["PLURNK_FIXTURE_EFFORT", "PLURNK_FIXTURE_BUDGET", "PAGER"],
        "a family is no name a Worker can set, so it is no candidate");
});

test("{§operator-config-undeclared-key} a key is declared by name, as a declared name's scope, or as a family member", () => {
    const declares = EnvCatalog.declares([FAMILIES]);
    for (const key of [
        "PLURNK_FIXTURE_EFFORT", "PLURNK_FIXTURE_BUDGET", "PAGER",          // by name, live or commented
        "PLURNK_FIXTURE_EFFORT_deep12", "PLURNK_FIXTURE_BUDGET_my-box.2",   // a declared name's scope
        "PLURNK_FIXTURE_DEF_docs", "PLURNK_FIXTURE_DEF_docs_ENABLED",       // family members
        "PLURNK_FIXTURE_DEF_分析", "PLURNK_FIXTURE_PROVIDER_FIREWORKS_AI_REASONING_EFFORTS",
    ]) assert.equal(declares(key), true, key);
    for (const key of [
        "PLURNK_FIXTURE_EFORT",            // nothing declares a misspelling
        "PLURNK_FIXTURE",                  // a prefix of a declared name is not that name
        "PLURNK_FIXTURE_EFFORT_",          // a scope is never empty
        "PLURNK_FIXTURE_DEF_",             // nor is a placeholder
        "PLURNK_FIXTURE_DEF_a b",          // and it holds no space
        "PLURNK_FIXTURE_PROVIDER_ACME",    // two placeholders need two segments
    ]) assert.equal(declares(key), false, key);
});
