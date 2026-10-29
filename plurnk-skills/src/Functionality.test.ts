import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Problems } from "@plurnk/plurnk-contracts";
import SkillsFunctionality, { serviceSkills } from "./Functionality.ts";
import { SkillsActionError } from "./problems.ts";
import SkillSource from "./SkillSource.ts";

// {§skills-module} Source declarations and the host-owned configuration boundary.
test("{§functionality-adapter} skill staging cleanup preserves the cancellation it follows", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-stop-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const lifetime = new AbortController();
    const reason = new DOMException("fixture stopping", "AbortError");
    const cleanup = new Error("fixture staging cleanup failed");
    const family = new SkillsFunctionality({
        workspacePaths: async () => ({ home: root, projectRoot: null, configurationRoots: [] }),
        readWorkspacePlugins: async () => ({ plugins: [], reports: [], roots: {}, signature: "empty" }),
        readProvidedSkills: async () => new Map(),
        workspaceStateDirectory: async () => root,
        operatorEnvironment: () => ({}),
    });
    t.mock.method(SkillSource.prototype, "open", async () => {
        lifetime.abort(reason);
        return { skills: [], invalid: [], close: async () => { throw cleanup; } };
    });
    await assert.rejects(family.prepare({
        signal: lifetime.signal, workspaceId: 1,
        enabled: new Map([["review", { definition: { name: "review", source: "https://forge.example/skills.git" } }]]),
        previous: null, failure: "publish-unavailable", admissions: [], progress: () => {}, retain: () => () => {},
    }), (cause) => {
        assert.ok(cause instanceof SuppressedError, String(cause));
        assert.equal(cause.suppressed, reason);
        assert.equal(cause.error, cleanup);
        return true;
    });
});

test("{§module-seam-slices} skills use the host's opaque source scopes and precedence without private services", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-seam-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const configurationRoots = ["near", "far"].map((scope) => ({ scope, directory: join(root, scope) }));
    for (const { directory, scope } of configurationRoots) {
        const folder = join(directory, "skills/review");
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "SKILL.md"), `---\nname: review\ndescription: ${scope} review\n---\n`);
    }
    const family = new SkillsFunctionality({
        workspacePaths: async () => ({ home: root, projectRoot: null, configurationRoots }),
        readWorkspacePlugins: async () => ({ plugins: [], reports: [], roots: {}, signature: "empty" }),
        readProvidedSkills: async () => new Map(),
        workspaceStateDirectory: async () => { throw new Error("Discovery does not allocate state."); },
        operatorEnvironment: () => { throw new Error("Discovery does not launch a subprocess."); },
    });
    assert.deepEqual((await family.available({ workspaceId: 1 })).map(({ definition, provenance }) => ({ definition, provenance })), [{
        definition: { name: "review", source: join(root, "near/skills/review") },
        provenance: { kind: "file", source: join(root, "near/skills/review/SKILL.md") },
    }]);
});

test("{§skills-module} native env parsing retains exact standard skill names without opening their sources", () => {
    const names = ["3d-tools", "分析", "café", "ｓｋｉｌｌ", "skill"];
    const definitions = names.map((name) => ({ name, source: `/unavailable/${name}` }));
    const env = parseEnv([
        "PLURNK_SKILLS_ENABLED=1",
        ...definitions.map((definition) => `PLURNK_SKILLS_${definition.name.replaceAll("-", "_")}='${JSON.stringify(definition)}'`),
        "PLURNK_SKILLS_分析_ENABLED=0",
        "PLURNK_SKILLS_future_ENABLED=0",
    ].join("\n"));
    const actual = serviceSkills(env);
    assert.equal(actual.size, names.length, "controls do not manufacture resource definitions");
    for (const definition of definitions) assert.deepEqual(actual.get(definition.name), definition);
});

test("{§functionality-replacement} a changed unavailable skill is a new preparation failure, not its alias's carried outcome", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-replacement-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ["before", "after"]) await mkdir(join(root, name));
    const family = new SkillsFunctionality({
        workspacePaths: async () => ({ home: root, projectRoot: null, configurationRoots: [] }),
        readWorkspacePlugins: async () => ({ plugins: [], reports: [], roots: {}, signature: "empty" }),
        readProvidedSkills: async () => new Map(),
        workspaceStateDirectory: async () => root,
        operatorEnvironment: () => ({}),
    });
    const prepare = (source: string, previous: Parameters<typeof family.prepare>[0]["previous"], failure: "reject" | "publish-unavailable") => family.prepare({
        signal: new AbortController().signal,
        workspaceId: 1, enabled: new Map([["review", { definition: { name: "review", source } }]]),
        previous, failure, admissions: [], progress: () => {}, retain: () => () => {},
    });
    const prior = await prepare(join(root, "before"), null, "publish-unavailable");
    assert.equal(prior.outcomes.get("review")?.state, "unavailable");
    prior.publish(); await prior.commit();
    const carried = await prepare(join(root, "before"), prior.snapshot, "reject");
    assert.deepEqual(carried.outcomes, prior.outcomes, "the unchanged prior failure can still accompany unrelated mutations");
    await carried.abort();
    await assert.rejects(prepare(join(root, "after"), prior.snapshot, "reject"), (cause: unknown) => {
        assert.ok(cause instanceof SkillsActionError);
        assert.equal(cause.problem.type, "https://problems.plurnk.xyz/skills/functionality/skill-not-found");
        assert.equal(cause.problem.status, 404);
        assert.equal(cause.problem.source, join(root, "after"));
        return true;
    });
});

test("{§skills-module} invalid disabled definitions still fail validation; absent definitions inherit", () => {
    const base = { PLURNK_SKILLS_ENABLED: "0", PLURNK_SKILLS_review_ENABLED: "0" };
    assert.equal(serviceSkills(base).size, 0);
    for (const definition of ["null", "{}", '{"name":"review","scope":"project","source":"/srv/review"}', "invalid-json"]) {
        assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: definition }), {
            message: "PLURNK_SKILLS_review must contain a complete SkillDefinition.",
        });
    }
    assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: '{"name":"other","source":"/srv/other"}' }), {
        message: "PLURNK_SKILLS_review: the definition name must equal 'review'.",
    });
    assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: '{"name":"review"}' }), {
        message: "PLURNK_SKILLS_review: a configured skill requires a source.",
    });
    assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: "" }), {
        message: "PLURNK_SKILLS_review must contain a definition; use PLURNK_SKILLS_review_ENABLED=0 to disable a defined resource.",
    });
    assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: JSON.stringify({ name: "review", source: "https://forge.example/skills.git", commit: "a".repeat(40) }) }), {
        message: "PLURNK_SKILLS_review: commit is service-recorded; configure a Git ref instead.",
    });
    for (const definition of [
        { name: "review", source: "/srv/review", ref: "main" },
        { name: "review", source: "http://forge.example/skills.git" },
        { name: "review", source: "https://secret@forge.example/skills.git" },
        { name: "review", source: "docs:///skills/review", ref: "main" },
        { name: "review", source: "docs:///resources/review" },
    ]) {
        assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: JSON.stringify(definition) }), {
            message: "PLURNK_SKILLS_review: invalid skill source or ref.",
        });
    }
});

test("{§skills-sources} MCP skill sources discover, admit with pinned manifest digest, materialize verified files, and refuse source-moved", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-mcp-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const commitV1 = "a".repeat(64);
    const commitV2 = "b".repeat(64);
    let currentCommit = commitV1;
    let failVerify = false;
    const skillMd = "---\nname: sql-helper\ndescription: Format SQL queries.\n---\nUse SQL formatting.\n";
    const guideMd = "# SQL Guide\nSelect columns explicitly.\n";
    const family = new SkillsFunctionality({
        workspacePaths: async () => ({ home: root, projectRoot: null, configurationRoots: [] }),
        readWorkspacePlugins: async () => ({ plugins: [], reports: [], roots: {}, signature: "empty" }),
        readProvidedSkills: async () => new Map(),
        workspaceStateDirectory: async () => root,
        operatorEnvironment: () => ({}),
        invokeModuleAction: async (name, params) => {
            assert.equal(name, "workspace.mcp.skills");
            if (params.server !== "docs") {
                const err = new Error("not connected") as Error & { problem: unknown };
                err.problem = Problems.create("mcp:management", "server-not-connected", 404, "Server not connected.", {
                    retryable: false,
                });
                throw err;
            }
            if (failVerify) {
                const err = new Error("digest mismatch") as Error & { problem: unknown };
                err.problem = Problems.create(
                    "mcp:management",
                    "skill-verification-failed",
                    502,
                    "Digest mismatch for SKILL.md.",
                    { retryable: false },
                );
                throw err;
            }
            if (params.skill === undefined) {
                return {
                    skills: [
                        {
                            name: "sql-helper",
                            description: "Format SQL queries.",
                            uri: "skill://sql-helper/SKILL.md",
                            commit: currentCommit,
                            dynamic: false,
                        },
                    ],
                };
            }
            if (params.skill !== "sql-helper") return { found: false };
            return {
                found: true,
                skill: {
                    name: "sql-helper",
                    description: "Format SQL queries.",
                    uri: "skill://sql-helper/SKILL.md",
                    commit: currentCommit,
                    dynamic: false,
                    ...(params.includeFiles === true
                        ? {
                              files: [
                                  { path: "SKILL.md", base64: Buffer.from(skillMd).toString("base64") },
                                  { path: "references/GUIDE.md", base64: Buffer.from(guideMd).toString("base64") },
                              ],
                          }
                        : {}),
                },
            };
        },
    });

    // 1. Discover from <server>:/// and <server>:///skills/<name>
    const discovered = await family.discover({ source: "docs:///" }, { workspaceId: 1 });
    assert.deepEqual(discovered, [
        {
            alias: "sql-helper",
            summary: "Format SQL queries.",
            definition: { name: "sql-helper", source: "docs:///skills/sql-helper" },
            provenance: { kind: "source", source: "docs:///skills/sql-helper" },
        },
    ]);
    const discoveredSingle = await family.discover({ source: "docs:///skills/sql-helper" }, { workspaceId: 1 });
    assert.equal(discoveredSingle.length, 1);

    // 2. Admit records the 64-hex SHA-256 manifest digest in commit and canonicalizes source
    const admitted = await family.admit(
        { alias: "sql-helper", definition: { name: "sql-helper", source: "docs:///skills" } },
        { workspaceId: 1 },
    );
    assert.deepEqual(admitted, {
        alias: "sql-helper",
        definition: {
            name: "sql-helper",
            source: "docs:///skills/sql-helper",
            commit: commitV1,
        },
    });

    // 3. Prepare materializes verified files into workspace state and mounts skill://sql-helper/
    const prepared = await family.prepare({
        signal: new AbortController().signal,
        workspaceId: 1,
        enabled: new Map([["sql-helper", { definition: admitted.definition }]]),
        previous: null,
        failure: "reject",
        admissions: [],
        progress: () => {},
        retain: () => () => {},
    });
    assert.equal(prepared.outcomes.get("sql-helper")?.state, "active");
    prepared.publish();
    await prepared.commit();
    const tree = family.trees(1).get("sql-helper");
    assert.ok(tree !== undefined);
    assert.equal(tree.document.description, "Format SQL queries.");
    if ("directory" in tree && typeof tree.directory === "string") {
        assert.equal(await readFile(join(tree.directory, "references/GUIDE.md"), "utf8"), guideMd);
    }

    // 4. Remote server mutating manifest digest after admission fails with 409 source-moved
    currentCommit = commitV2;
    await assert.rejects(
        family.prepare({
            signal: new AbortController().signal,
            workspaceId: 1,
            enabled: new Map([["sql-helper", { definition: admitted.definition }]]),
            previous: prepared.snapshot,
            force: "sql-helper",
            failure: "reject",
            admissions: [],
            progress: () => {},
            retain: () => () => {},
        }),
        (cause: unknown) => {
            assert.ok(cause instanceof SkillsActionError);
            assert.equal(cause.problem.type, "https://problems.plurnk.xyz/skills/functionality/source-moved");
            assert.equal(cause.problem.status, 409);
            assert.equal(cause.problem.commit, commitV1);
            assert.equal(cause.problem.current, commitV2);
            return true;
        },
    );

    // 5. Verification failure surfaces as 422 skill-invalid
    failVerify = true;
    await assert.rejects(
        family.admit(
            { alias: "sql-helper", definition: { name: "sql-helper", source: "docs:///skills/sql-helper" } },
            { workspaceId: 1 },
        ),
        (cause: unknown) => {
            assert.ok(cause instanceof SkillsActionError);
            assert.equal(cause.problem.type, "https://problems.plurnk.xyz/skills/functionality/skill-invalid");
            assert.equal(cause.problem.status, 422);
            return true;
        },
    );
});
