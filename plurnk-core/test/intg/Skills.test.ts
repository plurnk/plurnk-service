import { ownWorker, TEST_OWNER } from "./_approval.ts";
// {§skills-functionality} {§skills-sources} — standard Agent Skills through the shared workspace
// Functionality lifecycle: source roots are inputs, workspace bindings own
// enablement, discovery is inert, and only fetched sources are materialized.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { parsePath } from "@plurnk/plurnk-parser";
import { type ProblemDetails } from "@plurnk/plurnk-contracts";
import { execStmt, findStmt, readStmt } from "./_dsl.ts";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertWorkspace, insertWorker, openMigrated } from "./_db.ts";
import type { Db } from "../../src/core/Db.ts";

const run = promisify(execFile);

const skill = (name: string, description: string, body = `Use ${name}.`): string =>
    ["---", `name: ${name}`, `description: ${description}`, "---", body, ""].join("\n");

const writeSkill = async (root: string, name: string, description: string, body?: string): Promise<void> => {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), skill(name, description, body));
};

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

const rejectedProblem = async (run: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await run(); } catch (error) {
        const problem = (error as { problem?: ProblemDetails }).problem ?? (error as OperationFailureError).result?.problem;
        assert.ok(problem !== undefined, `expected a Problem, got ${String(error)}`);
        return problem;
    }
    assert.fail("Expected the action to reject.");
};

// A fixture repository commits outside the operator's global and system git configuration.
const git = async (cwd: string, ...args: string[]): Promise<string> => (await run("git", [
    "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args,
], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();

// Serves a local repository at an https remote for every git the process spawns, through
// git's own url.<base>.insteadOf; the environment is restored when the test ends.
const forge = (t: test.TestContext, remote: string, repository: string): void => {
    const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
    const saved = names.map((name) => process.env[name]);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${repository}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = remote;
    t.after(() => names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
    }));
};

// A stored (uncompressed) zip archive: the format unzip reads, written without a zip binary.
const zip = (entries: ReadonlyArray<readonly [string, string]>): Buffer => {
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of entries) {
        const file = Buffer.from(name);
        const data = Buffer.from(text);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc32(data), 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(file.length, 26);
        parts.push(local, file, data);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt32LE(crc32(data), 16);
        record.writeUInt32LE(data.length, 20);
        record.writeUInt32LE(data.length, 24);
        record.writeUInt16LE(file.length, 28);
        record.writeUInt32LE(offset, 42);
        central.push(record, file);
        offset += local.length + file.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directory, end]);
};

test("{§agent-skills-name} {§skills-resources}: discovery, installation and URI reads preserve skill identities", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-skills-names-"));
    const home = join(base, "home");
    const project = join(base, "project");
    const source = join(base, "source");
    const names = ["3d-models", "café", "分析", "ｓｋｉｌｌ", "skill"];
    await mkdir(home);
    await mkdir(project);
    for (const name of names) {
        await writeSkill(source, name, `Guide for ${name}`);
        await writeFile(join(source, name, "guide.md"), `Supporting source for ${name}.\n`);
    }
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths: new HostPaths({ home, env: {} }) });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(base, { recursive: true, force: true }); });
    await daemon.start();
    const workspace = await daemon.createWorkspace({ name: "skill-names", projectRoot: project });
    const context = { scope: "workspace" as const, workspaceId: workspace.workspaceId };
    const action = (verb: string, params: Record<string, unknown>) => daemon.invokeModuleAction(`workspace.skills.${verb}`, params, context);
    const read = (target: string) => daemon.dispatchAsClient({ ...workspace, statement: readStmt(parsePath(target), { marks: [1, -1] }) });
    const discovered = await action("discover", { source }) as { candidates: Array<{ alias: string; definition: unknown }> };
    assert.deepEqual(new Set(discovered.candidates.map(({ alias }) => alias)), new Set(names));
    for (const candidate of discovered.candidates) {
        const result = await action("add", { alias: candidate.alias, definition: candidate.definition }) as { status: number };
        assert.equal(result.status, 201);
    }
    const catalog = await daemon.dispatchAsClient({ ...workspace, statement: { ...findStmt(parsePath("skill://*/SKILL.md")), lineMarker: { marks: [1, -1] } } });
    assert.equal(catalog.status, 200, JSON.stringify(catalog));
    assert.ok(Array.isArray(catalog.results));
    const paths = (catalog.results.flat() as Array<{ path: string }>).map(({ path }) => path);
    for (const name of names) {
        const target = `skill://${name}/SKILL.md`;
        const canonical = new URL(target).href;
        assert.ok(paths.includes(canonical), `${name} has a discoverable canonical URI in ${JSON.stringify(paths)}`);
        for (const address of [target, canonical]) {
            const result = await read(address);
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.equal(result.content, skill(name, `Guide for ${name}`).slice(0, -1));
        }
        const sibling = new URL("guide.md", canonical).href;
        assert.equal((await read(sibling)).content, `Supporting source for ${name}.`);
        await action("disable", { alias: name });
        assert.equal((await read(target)).status, 404);
        await action("enable", { alias: name });
        assert.equal((await read(sibling)).content, `Supporting source for ${name}.`);
    }
});

test("{§module-workspace-quiescence}: a busy workspace refuses skill binding changes before external effects", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-skills-busy-"));
    const home = join(base, "home");
    const project = join(base, "project");
    const source = join(base, "source");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeSkill(source, "alpha", "Installed alpha");
    await writeSkill(source, "beta", "Uninstalled beta");
    const hostPaths = new HostPaths({ home, env: {} });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(base, { recursive: true, force: true }); });
    await daemon.start();
    const workspace = await daemon.createWorkspace({ name: "skills-busy", projectRoot: project });
    await ownWorker(db, workspace.workspaceId, workspace.workerId);
    const action = (verb: string, params: Record<string, unknown>) => daemon.invokeModuleAction(`workspace.skills.${verb}`, params, {
        scope: "workspace", workspaceId: workspace.workspaceId,
    });
    await action("add", { alias: "alpha", definition: { name: "alpha", source } });
    const proposal = Promise.withResolvers<number>();
    const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "loop/proposal") proposal.resolve((params as { logEntryId: number }).logEntryId);
    });
    t.after(unsubscribe);
    const pending = daemon.dispatchAsClient({ ...workspace, statement: execStmt("sh", "printf never") });
    const id = await proposal.promise;
    try {
        const originalPolicy = await daemon.readWorkspaceCapabilities({ workspaceId: workspace.workspaceId });
        const deniedPolicyChange = await rejectedProblem(() => daemon.setWorkspaceCapabilities({
            workspaceId: workspace.workspaceId, policy: { deny: [{ runtime: "sh" }] },
        }));
        assert.equal(deniedPolicyChange.type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy");
        assert.deepEqual(await daemon.readWorkspaceCapabilities({ workspaceId: workspace.workspaceId }), originalPolicy,
            "a pending proposal keeps the admission policy under which it was created");
        const removed = await rejectedProblem(() => action("remove", { alias: "alpha" }));
        assert.equal(removed.type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy");
        assert.equal(await exists(join(source, "alpha", "SKILL.md")), true, "refused removal preserves the source");
        const current = await action("list", {}) as { definitions: Array<{ alias: string; origin: string }> };
        assert.ok(current.definitions.some(({ alias, origin }) => alias === "alpha" && origin === "workspace"),
            "refused removal preserves the workspace binding");
        const added = await rejectedProblem(() => action("add", { alias: "beta", definition: { name: "beta", source } }));
        assert.equal(added.type, removed.type);
        assert.equal(await exists(join(hostPaths.projectSkillsDir(project), "beta")), false,
            "refused addition does not install a skill");
        const after = await action("list", {}) as { definitions: Array<{ alias: string }> };
        assert.ok(!after.definitions.some(({ alias }) => alias === "beta"), "refused addition creates no binding");
    } finally {
        await daemon.resolveProposal(id, { decision: "reject" }, { workspaceId: workspace.workspaceId, address: TEST_OWNER });
        await pending;
    }
});

test("{§skills-functionality} {§skills-remove} discovered roots are inputs, add binds, remove reveals inheritance, discovery stays inert", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-skills-family-"));
    const home = join(base, "home");
    const project = join(base, "project");
    const source = join(base, "source");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    const hostPaths = new HostPaths({ home, env: {} });
    const projectRoot = hostPaths.projectSkillsDir(project);
    await writeSkill(projectRoot, "grep", "Find text in the project");
    await writeSkill(hostPaths.globalSkillsDir, "grep", "Find text everywhere");
    await writeSkill(hostPaths.globalSkillsDir, "review", "Review a change");
    await writeSkill(hostPaths.globalSkillsDir, "bad", "Broken", "");
    await writeFile(join(hostPaths.globalSkillsDir, "bad", "SKILL.md"), "# no frontmatter\n");
    await writeSkill(source, "alpha", "Alpha from the source");
    await writeSkill(source, "review", "Review, project edition");

    const db: Db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `skills-${crypto.randomUUID()}`);
    await db.test_set_workspace_root.run({ id: workspaceId, project_root: project });
    const client = await insertWorker(db, workspaceId, null, "client", "client");
    let daemon = new Daemon({ db, provider: null, hostPaths });
    await daemon.start();
    const context = { scope: "workspace" as const, workspaceId };
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`workspace.skills.${verb}`, params, context) as Promise<T>;
    type Listed = { alias: string; origin: string; state: string; definition: { source?: string }; detail?: { path?: string; description: string }; problem?: ProblemDetails };
    const listed = async (): Promise<Listed[]> => (await invoke<{ definitions: Listed[] }>("list", {})).definitions;
    const states = async (): Promise<string[]> => (await listed()).map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
    const dispatch = (statement: ReturnType<typeof readStmt> | ReturnType<typeof findStmt>) =>
        daemon.dispatchAsClient({ workspaceId, workerId: client, statement });
    const document = async (name: string): Promise<string | undefined> => {
        const result = await dispatch(readStmt(parsePath(`skill://${name}/SKILL.md`), { marks: [1, -1] }));
        if (result.status === 404) return undefined;
        assert.equal(result.status, 200, JSON.stringify(result.problem));
        assert.equal(typeof result.content, "string");
        return result.content as string;
    };
    const catalog = async (): Promise<string> => {
        const result = await dispatch(findStmt(parsePath("skill://*/SKILL.md")));
        assert.equal(result.status, 200, JSON.stringify(result.problem));
        assert.equal(typeof result.content, "string");
        return result.content as string;
    };
    try {
        // The installed union is the service baseline: project shadows global;
        // an invalid skill is unavailable on its own, never failing the family.
        assert.ok((await listed()).every(({ state }) => state === "dormant"), "listing does not prepare installed skills");
        await catalog();
        assert.deepEqual(await states(), [
            "bad:service:unavailable",
            "grep:service:active",
            "plurnk:service:active",
            "review:service:active",
        ]);
        const bad = (await listed()).find(({ alias }) => alias === "bad")!;
        assert.equal(bad.problem?.type, "https://problems.plurnk.xyz/skills/functionality/skill-invalid");
        assert.equal((await listed()).find(({ alias }) => alias === "grep")?.definition.source, join(projectRoot, "grep"), "a discovered definition names its actual source");
        assert.match(bad.problem!.detail, /requires YAML frontmatter/);
        assert.match(await catalog() ?? "", /Find text in the project/);
        assert.match(await catalog() ?? "", /skill:\/\/review\/SKILL\.md/);
        assert.doesNotMatch(await catalog() ?? "", /bad/);
        assert.match(await document("grep") ?? "", /description: Find text in the project/);
        assert.equal(await document("bad"), undefined, "an unavailable skill has no model-facing document");

        // Disable withdraws resource access and the catalog row while the definition stays listed.
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "review" })).definition.state, "disabled");
        assert.equal(await document("review"), undefined);
        assert.doesNotMatch(await catalog() ?? "", /review/);
        assert.ok((await states()).includes("review:service:disabled"));

        // Discovery is inert: a source lists its skills; `source` is the one input discovery serves.
        const bySource = await invoke<{ candidates: Array<{ alias: string; summary?: string; definition: object; provenance: { kind: string; source: string } }> }>("discover", { source });
        assert.deepEqual(bySource.candidates.map(({ alias, summary, definition, provenance }) => ({ alias, summary, definition, provenance })), [
            { alias: "alpha", summary: "Alpha from the source", definition: { name: "alpha", source }, provenance: { kind: "source", source } },
            { alias: "review", summary: "Review, project edition", definition: { name: "review", source }, provenance: { kind: "source", source } },
        ]);
        // {§functionality-discover-advertisement} An input the family does not serve is refused by the shared schema check, by name.
        for (const [params, field] of [[{ query: "alpha" }, '"query"'], [{ configuration: { X: "y" } }, '"configuration"']] as const) {
            const refused = await rejectedProblem(() => invoke("discover", params));
            assert.equal(refused.type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
            assert.ok((refused.errors as Array<{ error: string }>).some(({ error }) => error.includes(field)), `the errors name ${field}`);
        }
        assert.equal(await exists(join(projectRoot, "alpha")), false, "discovery installed nothing");
        assert.equal((await rejectedProblem(() => invoke("discover", { source: join(base, "nowhere") }))).type, "https://problems.plurnk.xyz/skills/functionality/source-missing");

        // Admission is exact.
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "beta", definition: { name: "alpha", source } }))).type, "https://problems.plurnk.xyz/skills/functionality/alias-mismatch");
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "alpha", definition: { name: "alpha" } }))).type, "https://problems.plurnk.xyz/skills/functionality/source-required");
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "alpha", definition: { name: "alpha", scope: "nowhere", source } }))).type, "https://problems.plurnk.xyz/functionality/arguments-invalid", "the coordinator validates the definition schema before admission");
        // A source without the named skill rejects the client mutation and persists nothing.
        const failed = await rejectedProblem(() => invoke("add", { alias: "ghost", definition: { name: "ghost", source } }));
        assert.equal(failed.type, "https://problems.plurnk.xyz/skills/functionality/skill-not-found");
        assert.ok(!(await states()).some((state) => state.startsWith("ghost:")), "a failed install leaves no definition");

        const added = await invoke<{ status: number; definition: { origin: string; state: string; definition: { source: string }; detail: { path: string } } }>("add", { alias: "alpha", definition: { name: "alpha", source } });
        assert.equal(added.status, 201);
        assert.equal(added.definition.state, "active");
        assert.equal(added.definition.detail.path, join(source, "alpha"));
        assert.equal(await exists(join(projectRoot, "alpha", "SKILL.md")), false, "local add does not copy into a configuration root");
        assert.match(await document("alpha") ?? "", /Alpha from the source/);
        assert.match(await catalog() ?? "", /skill:\/\/alpha\/SKILL\.md/);
        const repeated = await invoke<{ status: number; definition: { state: string } }>("add", { alias: "alpha", definition: { name: "alpha", source } });
        assert.equal(repeated.status, 200, "reapplying the same workspace definition is idempotent");
        assert.equal(repeated.definition.state, "active");
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "alpha", definition: { name: "alpha", source: join(source, "alpha") } }))).type, "https://problems.plurnk.xyz/functionality/alias-exists");

        // {§skills-remove}
        const shadow = await invoke<{ definition: { origin: string; detail: { description: string } } }>("add", { alias: "review", definition: { name: "review", source } });
        assert.equal(shadow.definition.origin, "workspace");
        assert.equal(shadow.definition.detail.description, "Review, project edition");
        assert.equal(await exists(join(projectRoot, "review", "SKILL.md")), false);
        assert.match(await document("review") ?? "", /project edition/);
        const removed = await invoke<{ removed: boolean }>("remove", { alias: "review" });
        assert.equal(removed.removed, true);
        assert.equal(await exists(join(source, "review", "SKILL.md")), true, "remove leaves the local source intact");
        assert.equal(await exists(join(hostPaths.globalSkillsDir, "review", "SKILL.md")), true, "the global copy was never touched");
        assert.ok((await states()).includes("review:service:active"), "the global skill's enabledness is restored");
        assert.match(await document("review") ?? "", /Review a change/u);
        assert.doesNotMatch(await document("review") ?? "", /project edition/u);
        assert.equal((await rejectedProblem(() => invoke("remove", { alias: "grep" }))).type, "https://problems.plurnk.xyz/functionality/alias-service-owned");

        // Restart: the workspace's own definition survives and is located, not reinstalled.
        await daemon.stop();
        daemon = new Daemon({ db, provider: null, hostPaths });
        await daemon.start();
        assert.ok((await listed()).every(({ state }) => state === "dormant"), "restart inspection does not prepare skills");
        await catalog();
        assert.deepEqual(await states(), [
            "alpha:workspace:active",
            "bad:service:unavailable",
            "grep:service:active",
            "plurnk:service:active",
            "review:service:active",
        ]);
        const recorded = (await listed()).find(({ alias }) => alias === "alpha")!;
        assert.equal(recorded.definition.source, source, "the workspace definition records its source");

        // Removing a binding with no inherited definition withdraws its resources.
        await invoke("remove", { alias: "alpha" });
        assert.equal(await exists(join(projectRoot, "alpha")), false);
        assert.ok(!(await states()).some((state) => state.startsWith("alpha:")));
        assert.equal(await document("alpha"), undefined);
        assert.match(await readFile(join(source, "alpha", "SKILL.md"), "utf8"), /Alpha from the source/u);
    } finally {
        await daemon.stop();
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});

test("{§skills-functionality} a headless workspace accepts absolute local references; relative sources require a project", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-skills-headless-"));
    const home = join(base, "home");
    await mkdir(home, { recursive: true });
    const hostPaths = new HostPaths({ home, env: {} });
    await writeSkill(base, "alpha", "A headless reference");
    const db: Db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `skills-headless-${crypto.randomUUID()}`);
    const client = await insertWorker(db, workspaceId, null, "client", "client");
    const daemon = new Daemon({ db, provider: null, hostPaths });
    await daemon.start();
    const context = { scope: "workspace" as const, workspaceId };
    try {
        const list = await daemon.invokeModuleAction("workspace.skills.list", {}, context) as { definitions: Array<{ alias: string; state: string; origin: string }> };
        assert.deepEqual(list.definitions.map(({ alias, state, origin }) => ({ alias, state, origin })), [{ alias: "plurnk", state: "dormant", origin: "service" }]);
        const catalog = await daemon.dispatchAsClient({ workspaceId, workerId: client, statement: findStmt(parsePath("skill://*/SKILL.md")) });
        assert.equal(catalog.status, 200);
        assert.deepEqual((catalog.results as Array<Array<{ path: string }>>).flat().map(({ path }) => path), ["skill://plurnk/SKILL.md"]);
        const refused = await rejectedProblem(() => daemon.invokeModuleAction("workspace.skills.add", { alias: "alpha", definition: { name: "alpha", source: "acme/kit" } }, context));
        assert.equal(refused.type, "https://problems.plurnk.xyz/skills/functionality/source-invalid");
        const added = await daemon.invokeModuleAction("workspace.skills.add", {
            alias: "alpha", definition: { name: "alpha", source: join(base, "alpha") },
        }, context) as { status: number };
        assert.equal(added.status, 201);
        const read = await daemon.dispatchAsClient({ workspaceId, workerId: client, statement: readStmt(parsePath("skill://alpha/SKILL.md")) });
        assert.equal(read.status, 200);
        assert.equal(typeof read.content, "string");
        assert.match(read.content as string, /A headless reference/u);
    } finally {
        await daemon.stop();
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});

test("{§agent-roots} root selection controls discovery, not explicitly added local references", async (t) => {
    const previous = process.env.PLURNK_SERVICE_ROOTS;
    process.env.PLURNK_SERVICE_ROOTS = "project";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_ROOTS;
        else process.env.PLURNK_SERVICE_ROOTS = previous;
    });
    const base = await mkdtemp(join(tmpdir(), "plurnk-skills-unread-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: join(base, "home"), env: {} });
    await mkdir(join(hostPaths.plurnkSkillsDir, "beta"), { recursive: true });
    await writeFile(join(hostPaths.plurnkSkillsDir, "beta", "SKILL.md"), "---\nname: beta\ndescription: Installed at an unread root.\n---\nBody.\n");
    const db: Db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `skills-unread-${crypto.randomUUID()}`);
    const daemon = new Daemon({ db, provider: null, hostPaths });
    await daemon.start();
    t.after(async () => { await daemon.stop(); await db.close(); });
    const context = { scope: "workspace" as const, workspaceId };
    const list = await daemon.invokeModuleAction("workspace.skills.list", {}, context) as { definitions: Array<{ alias: string }> };
    assert.deepEqual(list.definitions.map(({ alias }) => alias), ["plurnk"], "the plurnk root's skill is not read");
    const added = await daemon.invokeModuleAction("workspace.skills.add", {
        definition: { name: "beta", source: join(hostPaths.plurnkSkillsDir, "beta") },
    }, context) as { status: number; definition: { state: string; detail: { path: string } } };
    assert.equal(added.status, 201);
    assert.equal(added.definition.state, "active");
    assert.equal(added.definition.detail.path, join(hostPaths.plurnkSkillsDir, "beta"));
});

// A workspace rooted in a fresh project with a private home; the daemon slot restarts in place.
const skillsWorkspace = async (t: test.TestContext, label: string) => {
    const base = await mkdtemp(join(tmpdir(), `plurnk-skills-${label}-`));
    const home = join(base, "home");
    const project = join(base, "project");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    const hostPaths = new HostPaths({ home, env: {} });
    const db = await openMigrated();
    const slot = { daemon: new Daemon({ db, provider: null, hostPaths }) };
    t.after(async () => { await slot.daemon.stop(); await db.close(); await rm(base, { recursive: true, force: true }); });
    await slot.daemon.start();
    const workspace = await slot.daemon.createWorkspace({ name: `skills-${label}`, projectRoot: project });
    const action = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        slot.daemon.invokeModuleAction(`workspace.skills.${verb}`, params, { scope: "workspace", workspaceId: workspace.workspaceId }) as Promise<T>;
    type Listed = { alias: string; origin: string; state: string; definition: { source?: string; commit?: string }; detail?: { path?: string }; problem?: ProblemDetails };
    const listed = async (): Promise<Listed[]> => (await action<{ definitions: Listed[] }>("list", {})).definitions;
    // Resource access prepares the family, as a model turn does.
    const prepare = async (): Promise<void> => {
        const result = await slot.daemon.dispatchAsClient({ ...workspace, statement: findStmt(parsePath("skill://*/SKILL.md")) });
        assert.equal(result.status, 200, JSON.stringify(result.problem));
    };
    const restart = async (): Promise<void> => {
        await slot.daemon.stop();
        slot.daemon = new Daemon({ db, provider: null, hostPaths });
        await slot.daemon.start();
    };
    return { base, home, project, hostPaths, projectSkills: hostPaths.projectSkillsDir(project), action, listed, prepare, restart };
};

const PROBLEM = "https://problems.plurnk.xyz/skills/functionality/";

test("{§skills-functionality} nearer roots shadow farther roots; adding a reference writes to neither", async (t) => {
    const s = await skillsWorkspace(t, "plurnk-root");
    await writeSkill(s.hostPaths.plurnkSkillsDir, "grep", "Find text, plurnk edition");
    await writeSkill(s.hostPaths.globalSkillsDir, "grep", "Find text everywhere");
    await writeSkill(s.hostPaths.globalSkillsDir, "review", "Review a change");
    await writeSkill(join(s.base, "source"), "lint", "Lint the project");
    await s.prepare();
    const states = async (): Promise<string[]> => (await s.listed()).map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
    assert.deepEqual(await states(), ["grep:service:active", "plurnk:service:active", "review:service:active"],
        "the plurnk root shadows the global root by name");
    assert.equal((await s.listed()).find(({ alias }) => alias === "grep")?.definition.source, join(s.hostPaths.plurnkSkillsDir, "grep"));
    const added = await s.action<{ status: number; definition: { detail: { path: string } } }>("add", { alias: "lint", definition: { name: "lint", source: join(s.base, "source") } });
    assert.equal(added.status, 201);
    assert.equal(added.definition.detail.path, join(s.base, "source", "lint"));
    assert.ok((await states()).includes("lint:workspace:active"));
    await s.action("remove", { alias: "lint" });
    assert.equal(await exists(join(s.hostPaths.plurnkSkillsDir, "lint")), false, "the plurnk root was not changed");
    assert.equal(await exists(join(s.base, "source", "lint", "SKILL.md")), true, "remove retains the local source");
});

test("{§skills-sources} a git source is fetched at its ref, its commit is recorded, and a moved ref never installs silently", async (t) => {
    const s = await skillsWorkspace(t, "git");
    const repository = join(s.base, "repository");
    await git(s.base, "init", "-q", "-b", "main", repository);
    await writeSkill(join(repository, "skills"), "alpha", "Alpha, first edition");
    await writeSkill(join(repository, "skills"), "beta", "Beta, first edition");
    await git(repository, "add", "-A");
    await git(repository, "commit", "-q", "-m", "first");
    await git(repository, "tag", "-a", "v1", "-m", "v1");
    const first = await git(repository, "rev-parse", "HEAD");
    await writeSkill(join(repository, "skills"), "beta", "Beta, second edition");
    await git(repository, "commit", "-q", "-am", "second");
    const second = await git(repository, "rev-parse", "HEAD");
    const remote = "https://forge.test/acme/skills.git";
    forge(t, remote, repository);

    const discovered = await s.action<{ candidates: Array<{ alias: string; summary: string }> }>("discover", { source: remote });
    assert.deepEqual(discovered.candidates.map(({ alias, summary }) => ({ alias, summary })), [
        { alias: "alpha", summary: "Alpha, first edition" },
        { alias: "beta", summary: "Beta, second edition" },
    ], "discovery reads the default branch");
    type Added = { status: number; definition: { definition: { commit?: string }; detail: { path: string } } };
    const alpha = await s.action<Added>("add", { alias: "alpha", definition: { name: "alpha", source: remote } });
    assert.equal(alpha.status, 201);
    assert.equal(alpha.definition.definition.commit, second, "the default branch's commit is recorded");
    const beta = await s.action<Added>("add", { alias: "beta", definition: { name: "beta", source: remote, ref: "v1" } });
    assert.equal(beta.definition.definition.commit, first, "an annotated tag records the commit it names");
    const alphaPath = alpha.definition.detail.path;
    const betaPath = beta.definition.detail.path;
    for (const path of [alphaPath, betaPath]) assert.ok(path.startsWith(`${s.hostPaths.stateDir}/workspaces/`), "fetched skills belong to workspace storage");
    assert.equal(await exists(s.projectSkills), false, "fetch does not create a project installation");
    assert.match(await readFile(join(betaPath, "SKILL.md"), "utf8"), /Beta, first edition/u);
    assert.equal(await exists(join(alphaPath, ".git")), false, "a checkout's .git never enters a skill");
    const again = await s.action<Added>("add", { alias: "alpha", definition: { name: "alpha", source: remote } });
    assert.equal(again.status, 200, "re-adding at an unmoved ref is idempotent");
    assert.equal((await rejectedProblem(() => s.action("add", { alias: "gamma", definition: { name: "gamma", source: remote, ref: "nope" } }))).type, `${PROBLEM}ref-missing`);

    // The branch moves on and the copy disappears: nothing the definition never named is installed.
    await rm(alphaPath, { recursive: true });
    await writeSkill(join(repository, "skills"), "alpha", "Alpha, third edition");
    await git(repository, "commit", "-q", "-am", "third");
    await s.restart();
    await s.prepare();
    const listed = await s.listed();
    const moved = listed.find(({ alias }) => alias === "alpha")!;
    assert.equal(moved.state, "unavailable");
    assert.equal(moved.problem?.type, `${PROBLEM}source-moved`);
    assert.equal(await exists(alphaPath), false, "nothing was installed from the moved branch");
    assert.equal(listed.find(({ alias }) => alias === "beta")?.state, "active", "a tag that did not move stays put");
});

test("{§skills-configuration} a configured Git snapshot survives enable and restart; changing its definition fetches a separate revision", async (t) => {
    const s = await skillsWorkspace(t, "git-configured");
    const repository = join(s.base, "repository");
    await git(s.base, "init", "-q", "-b", "main", repository);
    await writeFile(join(repository, "SKILL.md"), skill("alpha", "First revision"));
    await git(repository, "add", "-A");
    await git(repository, "commit", "-q", "-m", "first");
    const remote = "https://forge.test/acme/configured.git";
    forge(t, remote, repository);
    const previous = process.env.PLURNK_SKILLS_alpha;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SKILLS_alpha;
        else process.env.PLURNK_SKILLS_alpha = previous;
    });
    const definition = { name: "alpha", source: remote };
    process.env.PLURNK_SKILLS_alpha = JSON.stringify(definition);
    assert.equal((await s.listed()).find(({ alias }) => alias === "alpha")?.state, "dormant");
    await s.prepare();
    const first = (await s.listed()).find(({ alias }) => alias === "alpha")!;
    assert.equal(first.state, "active");
    assert.deepEqual(first.definition, definition, "materialization does not mutate the configured definition");
    const original = first.detail!.path!;
    assert.match(await readFile(join(original, "SKILL.md"), "utf8"), /First revision/u);
    await writeFile(join(repository, "SKILL.md"), skill("alpha", "Second revision"));
    await git(repository, "commit", "-q", "-am", "second");
    await git(repository, "tag", "v2");
    await s.action("disable", { alias: "alpha" });
    await s.action("enable", { alias: "alpha" });
    assert.equal((await s.listed()).find(({ alias }) => alias === "alpha")?.detail?.path, original);
    await s.restart();
    await s.prepare();
    assert.equal((await s.listed()).find(({ alias }) => alias === "alpha")?.detail?.path, original);
    assert.match(await readFile(join(original, "SKILL.md"), "utf8"), /First revision/u);
    process.env.PLURNK_SKILLS_alpha = JSON.stringify({ ...definition, ref: "v2" });
    await s.action("enable", { alias: "alpha" });
    const changed = (await s.listed()).find(({ alias }) => alias === "alpha")!.detail!.path!;
    assert.notEqual(changed, original, "a changed source definition cannot reuse the previous materialization");
    assert.match(await readFile(join(changed, "SKILL.md"), "utf8"), /Second revision/u);
    assert.match(await readFile(join(original, "SKILL.md"), "utf8"), /First revision/u, "retained source evidence is not overwritten");
    assert.equal(await exists(s.projectSkills), false);
});

test("{§skills-configuration} an archive snapshot survives source changes and removal; a new source definition materializes new content", async (t) => {
    const s = await skillsWorkspace(t, "archive-configured");
    const source = join(s.base, "first.zip");
    const replacement = join(s.base, "second.zip");
    await writeFile(source, zip([["alpha/SKILL.md", skill("alpha", "First edition")]]));
    const previous = process.env.PLURNK_SKILLS_alpha;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SKILLS_alpha;
        else process.env.PLURNK_SKILLS_alpha = previous;
    });
    const definition = { name: "alpha", source };
    process.env.PLURNK_SKILLS_alpha = JSON.stringify(definition);
    await s.prepare();
    const original = (await s.listed()).find(({ alias }) => alias === "alpha")!.detail!.path!;
    await writeFile(source, zip([["alpha/SKILL.md", skill("alpha", "Changed in place")]]));
    await s.action("disable", { alias: "alpha" });
    await s.action("enable", { alias: "alpha" });
    assert.match(await readFile(join(original, "SKILL.md"), "utf8"), /First edition/u);
    await rm(source);
    await s.restart();
    await s.prepare();
    const retained = (await s.listed()).find(({ alias }) => alias === "alpha")!;
    assert.equal(retained.state, "active", "source availability is not a dependency of a retained copy");
    assert.equal(retained.detail?.path, original);
    assert.deepEqual(retained.definition, definition);
    assert.match(await readFile(join(original, "SKILL.md"), "utf8"), /First edition/u);
    await writeFile(replacement, zip([["alpha/SKILL.md", skill("alpha", "Replacement edition")]]));
    process.env.PLURNK_SKILLS_alpha = JSON.stringify({ ...definition, source: replacement });
    await s.action("enable", { alias: "alpha" });
    const changed = (await s.listed()).find(({ alias }) => alias === "alpha")!.detail!.path!;
    assert.notEqual(changed, original);
    assert.match(await readFile(join(changed, "SKILL.md"), "utf8"), /Replacement edition/u);
    assert.match(await readFile(join(original, "SKILL.md"), "utf8"), /First edition/u);
});

test("{§skills-sources} a lone SKILL.md, a tar archive and a zip archive each add their skill", async (t) => {
    const s = await skillsWorkspace(t, "files");
    const files = join(s.base, "files");
    await writeSkill(files, "solo", "A lone skill");
    const tree = join(s.base, "tree");
    await writeSkill(join(tree, "kit-1.0", "skills"), "tarred", "From a tarball");
    await run("tar", ["-czf", join(files, "kit.tar.gz"), "-C", tree, "kit-1.0"]);
    await writeFile(join(files, "kit.zip"), zip([["zipped/SKILL.md", skill("zipped", "From a zip")], ["zipped/notes/guide.md", "Guide.\n"]]));
    const paths = new Map<string, string>();
    for (const [alias, source, description] of [
        ["solo", join(files, "solo", "SKILL.md"), "A lone skill"],
        ["tarred", join(files, "kit.tar.gz"), "From a tarball"],
        ["zipped", join(files, "kit.zip"), "From a zip"],
    ] as const) {
        const discovered = await s.action<{ candidates: Array<{ alias: string }> }>("discover", { source });
        assert.deepEqual(discovered.candidates.map(({ alias: name }) => name), [alias], source);
        const added = await s.action<{ status: number; definition: { detail: { path: string } } }>("add", { alias, definition: { name: alias, source } });
        assert.equal(added.status, 201, source);
        const path = added.definition.detail.path;
        paths.set(alias, path);
        assert.match(await readFile(join(path, "SKILL.md"), "utf8"), new RegExp(description, "u"));
        if (alias === "solo") assert.equal(path, join(files, "solo"));
        else assert.ok(path.startsWith(`${s.hostPaths.stateDir}/workspaces/`));
    }
    assert.equal(await readFile(join(paths.get("zipped")!, "notes", "guide.md"), "utf8"), "Guide.\n", "an archive's supporting files come along");
    assert.equal(await exists(s.projectSkills), false, "none of the sources writes to a project installation");
});

test("{§skills-sources} add refuses a plugin, a link out of its skill, shorthand, an insecure remote, a stray ref and a supplied commit", async (t) => {
    const s = await skillsWorkspace(t, "refusals");
    const sources = join(s.base, "sources");
    await writeSkill(join(sources, "plugin", "skills"), "helper", "A plugin's skill");
    await writeFile(join(sources, "plugin", "plugin.json"), JSON.stringify({ name: "acme-plugin" }));
    await writeSkill(join(sources, "leaky-kit"), "leaky", "Leaks");
    await symlink("../../../home", join(sources, "leaky-kit", "leaky", "home"));
    await writeSkill(join(sources, "kit"), "plain", "Plain");
    const refused = (definition: Readonly<Record<string, unknown>>) => rejectedProblem(() => s.action("add", { alias: definition.name, definition }));
    assert.equal((await refused({ name: "helper", source: join(sources, "plugin") })).type, `${PROBLEM}source-is-plugin`);
    assert.equal((await refused({ name: "leaky", source: join(sources, "leaky-kit") })).type, `${PROBLEM}source-unsafe`);
    assert.equal(await exists(join(s.projectSkills, "leaky")), false, "a refused install leaves nothing behind");
    const shorthand = await refused({ name: "plain", source: "acme/kit" });
    assert.equal(shorthand.type, `${PROBLEM}source-missing`);
    assert.equal(shorthand.detail, "No folder or file is at 'acme/kit'.");
    assert.equal((await refused({ name: "plain", source: "http://forge.test/acme/kit.git" })).type, `${PROBLEM}source-invalid`);
    assert.equal((await refused({ name: "plain", source: join(sources, "kit"), ref: "main" })).type, `${PROBLEM}definition-invalid`);
    assert.equal((await refused({ name: "plain", source: "https://forge.test/acme/kit.git", commit: "0".repeat(40) })).type, `${PROBLEM}definition-invalid`);
    assert.deepEqual((await s.listed()).map(({ alias }) => alias), ["plurnk"], "no refused addition persisted");
});
