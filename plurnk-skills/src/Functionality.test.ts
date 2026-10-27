import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import { mkdir, mkdtemp, rm, writeFile, chmod, readdir, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import SkillsFunctionality, { serviceSkills } from "./Functionality.ts";
import { SkillsActionError } from "./problems.ts";
import SkillSource from "./SkillSource.ts";
import { parseSkill, SkillResourceError, type SkillTree } from "@plurnk/plurnk-agent-skills";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { FunctionalityAdapter } from "@plurnk/plurnk-modules";
import { GeneratedByteSource, type ResourceTreeSource } from "@plurnk/plurnk-schemes";
import Module from "./Module.ts";
import { setTimeout as delay } from "node:timers/promises";

// ─── Functionality.test.ts ───
{
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
    ]) {
        assert.throws(() => serviceSkills({ ...base, PLURNK_SKILLS_review: JSON.stringify(definition) }), {
            message: "PLURNK_SKILLS_review: invalid skill source or ref.",
        });
    }
});
}

// ─── Module.test.ts ───
{
const setup = async (module: Module, provided: ReadonlyMap<string, SkillTree> = new Map()) => {
    const families: FunctionalityAdapter[] = [];
    const sources: ResourceTreeSource[] = [];
    const seam: Parameters<Module["setup"]>[0] = {
        workspacePaths: async () => ({ home: "/unused", projectRoot: null, configurationRoots: [] }),
        readWorkspacePlugins: async () => ({ plugins: [], reports: [], roots: {}, signature: "empty" }),
        readProvidedSkills: async () => provided,
        workspaceStateDirectory: async () => { throw new Error("Provided resources require no directory."); },
        operatorEnvironment: () => { throw new Error("Provided resources launch no subprocess."); },
        registerFunctionalityAdapter: (family) => {
            families.push(family);
            return {
                invoke: async () => { throw new Error("Setup does not perform family actions."); },
                refresh: async () => {},
            };
        },
        registerResourceTreeScheme: async (name, source) => {
            assert.equal(name, "skill");
            sources.push(source);
        },
    };
    await module.setup(seam);
    assert.equal(families.length, 1);
    assert.equal(sources.length, 1);
    return { family: families[0], source: sources[0], seam };
};

test("{§skills-module} public seams connect ordinary family publication to original resources", async () => {
    const module = Module.init();
    assert.deepEqual(module.contained, []);
    const body = "---\nname: guide\ndescription: Read this guide\n---\nOriginal resource.\n";
    const tree: SkillTree = {
        document: parseSkill("/guide/SKILL.md", "guide", body),
        list: async () => ["SKILL.md"],
        resource: (path) => new GeneratedByteSource(async () => path === "SKILL.md" ? new TextEncoder().encode(body) : null),
    };
    const { family, source, seam } = await setup(module, new Map([["guide", tree]]));
    assert.equal(family.namespaceOwner, "@plurnk/plurnk-skills");
    assert.equal(family.family, "skills");
    const identity = { workspaceId: 1 };
    const available = await family.available(identity);
    assert.deepEqual(available, [{ alias: "guide", definition: { name: "guide" }, enabled: true }]);
    const prepared = await family.prepare({
        signal: new AbortController().signal,
        ...identity, enabled: new Map([["guide", { definition: { name: "guide" } }]]), previous: null,
        failure: "reject", admissions: [], progress: () => {}, retain: () => () => {},
    });
    assert.equal(source.trees(1).size, 0, "preparation alone publishes nothing");
    const undo = prepared.publish();
    assert.equal(source.trees(1).get("guide"), tree, "publication adopts the tree synchronously: no flattening or surrogate source");
    undo?.();
    assert.equal(source.trees(1).size, 0, "a rolled-back publication withdraws the candidate");
    prepared.publish();
    await prepared.commit();
    assert.equal(source.trees(1).get("guide"), tree);
    assert.equal(source.trees(2).size, 0);
    const bytes = source.trees(1).get("guide")!.resource("SKILL.md");
    assert.equal(new TextDecoder().decode(await bytes.read(1, body.length)), body);
    await family.teardown(prepared.snapshot, identity);
    assert.equal(source.trees(1).size, 0, "cooling withdraws the tree through the family lifecycle");
    await assert.rejects(module.setup(seam), /skills module already set up/);
});

test("{§skills-module} invalid configuration is inspectable, reported offline, and repairable", async (t) => {
    const previous = process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS;
        else process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS = previous;
    });
    process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS = "bad";
    const module = Module.init();
    assert.equal(module.contained.length, 1);
    assert.equal(module.contained[0]?.key, "PLURNK_SKILLS_FETCH_TIMEOUT_MS");
    const { family } = await setup(module);
    await assert.rejects(family.available({ workspaceId: 1 }), ConfigurationError);
    process.env.PLURNK_SKILLS_FETCH_TIMEOUT_MS = "1000";
    assert.deepEqual(await family.available({ workspaceId: 1 }), []);
});

test("{§skills-sources} source refusals preserve the skill boundary without hiding unexpected failures", async () => {
    const { source } = await setup(Module.init());
    const address = { authority: "guide", pathname: "/secret" };
    for (const [cause, status, suffix] of [
        [{ code: "ENOENT" }, 404, "entry-not-found"],
        [new SkillResourceError("SKILL_PATH_OUTSIDE_ROOT", "Outside root."), 403, "resource-outside-root"],
        [new SkillResourceError("SKILL_RESOURCE_NOT_FILE", "Not a file."), 400, "resource-invalid"],
    ] as const) {
        const result = source.refusal!(cause, address);
        assert.equal(result?.status, status);
        assert.equal(result?.problem?.type, `https://problems.plurnk.xyz/scheme/skill/${suffix}`);
    }
    assert.equal(source.refusal!(new Error("unexpected source failure"), address), null);
});
}

// ─── SkillSource.test.ts ───
{
// {§skills-sources} Source forms, skill finding and installation containment, on the filesystem alone;
// git and archive fetches are witnessed in plurnk-core/test/intg/Skills.test.ts.







const skill = (name: string, description = `Use ${name}.`): string => `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`;
const localReader = new SkillSource(() => { throw new Error("Reading a local source must not launch a subprocess."); });

const problemType = (code: string) => (error: { problem?: { type?: string } }): boolean =>
    error.problem?.type === `https://problems.plurnk.xyz/skills/functionality/${code}`;

const fixture = async (t: test.TestContext): Promise<string> => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-skill-source-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    return base;
};

test("{§functionality-adapter} a cancelled skill fetch joins its child before removing staging", async (t) => {
    const root = await fixture(t);
    const started = join(root, "started.json");
    const closed = join(root, "closed");
    const executable = join(root, "git");
    await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";
process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(closed)}, "closed"); process.exit(0); }, 50));
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(started)}, JSON.stringify({ checkout: process.argv.at(-1) }));
`);
    await chmod(executable, 0o700);
    const reader = new SkillSource(() => ({ PATH: root }));
    const lifetime = new AbortController();
    const reason = new DOMException("fixture stopping", "AbortError");
    const work = assert.rejects(reader.open({ kind: "git", location: "https://example.test/skills.git" }, { signal: lifetime.signal }), (cause) => cause === reason);
    let checkout: string | undefined;
    try {
        for (let attempt = 0; attempt < 100 && checkout === undefined; attempt++) {
            try { checkout = (JSON.parse(await readFile(started, "utf8")) as { checkout: string }).checkout; }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && !(cause instanceof SyntaxError)) throw cause; }
            if (checkout === undefined) await delay(10);
        }
        assert.ok(checkout, "the fixture child reaches its held fetch");
    } finally { lifetime.abort(reason); }
    await work;
    assert.equal(await readFile(closed, "utf8"), "closed", "abort did not return while the child still owned staging");
    await assert.rejects(stat(dirname(checkout)), { code: "ENOENT" }, "cancelled fetch removed its staging only after child close");
});

test("{§skills-sources} a git remote is a full https or ssh URL; other schemes are refused", async () => {
    const context = { projectRoot: null, home: "/home/ada" };
    for (const remote of ["https://forge.example/acme/skills.git", "ssh://git@forge.example/acme/skills.git", "git@forge.example:acme/skills.git"]) {
        assert.deepEqual(await SkillSource.locate(remote, context), { kind: "git", location: remote });
    }
    for (const refused of ["http://forge.example/acme/skills.git", "git://forge.example/acme/skills.git", "file:///srv/skills.git"]) {
        await assert.rejects(() => SkillSource.locate(refused, context), problemType("source-invalid"), refused);
    }
    await assert.rejects(() => SkillSource.locate("https://token@forge.example/acme/skills.git", context),
        (error: { problem?: { type?: string; detail?: string; source?: string } }) =>
            problemType("source-invalid")(error) && error.problem!.source === undefined && !error.problem!.detail!.includes("token"),
        "a credential in a source URL is refused without being echoed");
    await assert.rejects(() => SkillSource.locate("skills/review", { projectRoot: "/nowhere", home: "/home/ada" }),
        (error: { problem?: { type?: string; detail?: string } }) => problemType("source-missing")(error) && error.problem!.detail === "No folder or file is at 'skills/review'.",
        "a relative source is read as a project path, and its refusal names only what is absent ({§diagnostic-observation})");
    await assert.rejects(() => SkillSource.locate("skills", context), problemType("source-invalid"), "a relative source needs a project root");
});

test("{§skills-sources} a local source is a folder, a SKILL.md, or a zip or tar archive; a relative one is the project's", async (t) => {
    const base = await fixture(t);
    await mkdir(join(base, "kit"));
    await writeFile(join(base, "kit", "SKILL.md"), skill("kit"));
    for (const archive of ["kit.zip", "kit.tar", "kit.tgz", "kit.tar.gz", "kit.tar.xz"]) await writeFile(join(base, archive), "");
    await writeFile(join(base, "notes.txt"), "");
    const context = { projectRoot: base, home: join(base, "home") };
    assert.deepEqual(await SkillSource.locate("kit", context), { kind: "folder", location: join(base, "kit") });
    assert.deepEqual(await SkillSource.locate(join(base, "kit", "SKILL.md"), context), { kind: "skill-file", location: join(base, "kit", "SKILL.md") });
    for (const archive of ["kit.zip", "kit.tar", "kit.tgz", "kit.tar.gz", "kit.tar.xz"]) {
        assert.deepEqual(await SkillSource.locate(archive, context), { kind: "archive", location: join(base, archive) });
    }
    await assert.rejects(() => SkillSource.locate("notes.txt", context), problemType("source-invalid"));
    await mkdir(join(base, "home", "mine"), { recursive: true });
    assert.deepEqual(await SkillSource.locate("~/mine", { projectRoot: null, home: join(base, "home") }), { kind: "folder", location: join(base, "home", "mine") });
});

test("{§skills-sources} local skills retain their standard folder identity; nested examples and .git are not skills", async (t) => {
    const base = await fixture(t);
    const source = join(base, "root-skill");
    await mkdir(join(source, "skills", "alpha", "examples", "inner"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), skill("root-skill"));
    const opened = await localReader.open({ kind: "folder", location: source });
    t.after(() => opened.close());
    assert.deepEqual(opened.skills.map(({ name, dir }) => ({ name, dir })), [{ name: "root-skill", dir: source }],
        "a skill at the root is the source; nothing below it is walked");
    const misnamed = join(base, "checkout-dir");
    await mkdir(misnamed);
    await writeFile(join(misnamed, "SKILL.md"), skill("root-skill"));
    const rejected = await localReader.open({ kind: "skill-file", location: join(misnamed, "SKILL.md") });
    assert.deepEqual(rejected.skills, [], "a SKILL.md is read in its actual directory, not renamed in a temporary copy");
    assert.match(rejected.invalid[0].reason, /must match folder "checkout-dir"/u);
    await rejected.close();

    const tree = join(base, "tree");
    await mkdir(join(tree, "skills", "alpha", "examples", "inner"), { recursive: true });
    await mkdir(join(tree, "skills", "misnamed"), { recursive: true });
    await mkdir(join(tree, ".git", "hidden"), { recursive: true });
    await writeFile(join(tree, "skills", "alpha", "SKILL.md"), skill("alpha", "Alpha."));
    await writeFile(join(tree, "skills", "alpha", "examples", "inner", "SKILL.md"), skill("inner"));
    await writeFile(join(tree, "skills", "misnamed", "SKILL.md"), skill("other"));
    await writeFile(join(tree, ".git", "hidden", "SKILL.md"), skill("hidden"));
    const walked = await localReader.open({ kind: "folder", location: tree });
    t.after(() => walked.close());
    assert.deepEqual(walked.skills.map(({ name, description, dir }) => ({ name, description, dir })), [
        { name: "alpha", description: "Alpha.", dir: join(tree, "skills", "alpha") },
    ], "a skill's own examples are not skills, and .git is never read");
    assert.deepEqual(walked.invalid.map(({ dir }) => dir), [join(tree, "skills", "misnamed")]);
    assert.match(walked.invalid[0].reason, /must match folder "misnamed"/u);
});

test("{§skills-sources} an Agent Plugin source is refused: its skills keep the plugin's identity", async (t) => {
    const base = await fixture(t);
    await mkdir(join(base, "plugin", "skills", "alpha"), { recursive: true });
    await writeFile(join(base, "plugin", "plugin.json"), JSON.stringify({ name: "acme" }));
    await writeFile(join(base, "plugin", "skills", "alpha", "SKILL.md"), skill("alpha"));
    await assert.rejects(() => localReader.open({ kind: "folder", location: join(base, "plugin") }),
        (error: { problem?: { type?: string; detail?: string } }) =>
            problemType("source-is-plugin")(error) && error.problem!.detail === `'${join(base, "plugin")}' is an Agent Plugin, not a skill.`);
});

test("{§skills-sources} fetching uses the supplied operator environment and preserves explicit SSH configuration", async (t) => {
    const base = await fixture(t);
    const report = join(base, "environment.json");
    const commit = "a".repeat(40);
    await writeFile(join(base, "git"), `#!${process.execPath}\n${[
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.SKILL_ENV_REPORT, JSON.stringify({ marker: process.env.SKILL_ENV_MARKER, prompt: process.env.GIT_TERMINAL_PROMPT, ssh: process.env.GIT_SSH_COMMAND, transport: process.env.GIT_SSH }));',
        `console.log(${JSON.stringify(`${commit}\tHEAD`)});`,
    ].join("\n")}\n`, { mode: 0o700 });
    const baseEnv = { PATH: base, SKILL_ENV_REPORT: report, SKILL_ENV_MARKER: "host-admitted", GIT_TERMINAL_PROMPT: "1" };
    for (const overrides of [{}, { GIT_SSH_COMMAND: "operator ssh" }, { GIT_SSH: "/operator/ssh" }]) {
        const source = new SkillSource(() => ({ ...baseEnv, ...overrides }));
        assert.equal(await source.resolveCommit("https://forge.example/skills.git"), commit);
        assert.deepEqual(JSON.parse(await readFile(report, "utf8")), {
            marker: "host-admitted", prompt: "0",
            ...(overrides.GIT_SSH === undefined ? { ssh: overrides.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" } : { transport: overrides.GIT_SSH }),
        });
    }
});

test("{§skills-sources} install places a skill under its name and refuses links out of it, leaving the root clean", async (t) => {
    const base = await fixture(t);
    const root = join(base, "root");
    const kept = join(base, "kept");
    await mkdir(join(kept, "docs"), { recursive: true });
    await writeFile(join(kept, "SKILL.md"), skill("kept"));
    await writeFile(join(kept, "docs", "guide.md"), "Guide.\n");
    await symlink("docs/guide.md", join(kept, "guide.md"));
    assert.equal(await SkillSource.install({ name: "kept", description: "Use kept.", dir: kept }, root), join(root, "kept"));
    assert.deepEqual((await readdir(join(root, "kept"))).toSorted(), ["SKILL.md", "docs", "guide.md"], "an inward link is kept");

    const leaky = join(base, "leaky");
    await mkdir(leaky);
    await writeFile(join(leaky, "SKILL.md"), skill("leaky"));
    await symlink("../../secrets", join(leaky, "secrets"));
    await assert.rejects(() => SkillSource.install({ name: "leaky", description: "Use leaky.", dir: leaky }, root), problemType("source-unsafe"));
    assert.deepEqual(await readdir(root), ["kept"], "a refused install leaves nothing behind");
});
}
