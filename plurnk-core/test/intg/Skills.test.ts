import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import AdministrativeLoop from "../../src/core/AdministrativeLoop.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Envelope from "../../src/server/envelope.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import MembersFunctionality from "../../src/server/MembersFunctionality.ts";
import { ownSession, TEST_OWNER, serverProposals } from "./_approval.ts";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { type PlurnkStatement, type ProblemDetails, type FunctionalityListResult, Problems, type FunctionalityMutationResult } from "@plurnk/plurnk-contracts";
import { findStmt, readStmt } from "./_dsl.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertWorkspace, openMigrated, insertLoop, insertTurn, insertSession, seedEntryWithChannel, rootWorkspace } from "./_db.ts";
import { Mock, type MockResponse, type ProviderAlias } from "@plurnk/plurnk-providers";
import { makeMockResponse, fixtureExecutors, userText, makeRawMockResponse } from "./_mock.ts";
import { viableWindow } from "./_provider.ts";
import { waitForDb, connect, rpcCall, runLoopToTerminal, withDaemon, waitFor } from "./_rpc.ts";
import { namedModelSession, modelOperation } from "./_sessions.ts";
import { type Db } from "../../src/core/Db.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { awaitExecOutcome } from "./_execs.ts";
import { mcpFixture, stdioEntry } from "./_mcp-config.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";

describe("Skills", () => {
// {§skills-functionality} {§skills-sources} — standard Agent Skills through the shared workspace
// Functionality lifecycle: source roots are inputs, workspace bindings own
// enablement, discovery is inert, and only fetched sources are materialized.





















const run = promisify(execFile);

const skill = (name: string, description: string, body = `Use ${name}.`): string =>
    ["---", `name: ${name}`, `description: ${description}`, "---", body, ""].join("\n");

const writeSkill = async (root: string, name: string, description: string, body?: string): Promise<void> => {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), skill(name, description, body));
};

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

const rejectedProblem = async (attempt: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await attempt(); } catch (error) {
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
    const operate = async (statement: PlurnkStatement) =>
        (await daemon.dispatchClientAction({ workspaceId: workspace.workspaceId, actor: TEST_OWNER, statements: [statement] }))[0];
    const read = (target: string) => operate(readStmt(parsePath(target), { marks: [1, -1] }));
    const discovered = await action("discover", { source }) as { candidates: Array<{ alias: string; definition: unknown }> };
    assert.deepEqual(new Set(discovered.candidates.map(({ alias }) => alias)), new Set(names));
    for (const candidate of discovered.candidates) {
        const result = await action("add", { alias: candidate.alias, definition: candidate.definition }) as { status: number };
        assert.equal(result.status, 201);
    }
    const catalog = await operate({ ...findStmt(parsePath("skill://*/SKILL.md")), lineMarker: { marks: [1, -1] } });
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

test("{§module-workspace-residency}: a busy workspace refuses skill binding changes before external effects", async (t) => {
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
    // A model turn whose execution waits for its owner's review keeps the workspace busy.
    const provider = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````sh\nprintf never\n````"),
        makeMockResponse("````SEND [200]\nThe execution was declined.\n````"),
    ] });
    const daemon = new Daemon({ db, provider, hostPaths });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(base, { recursive: true, force: true }); });
    await daemon.start();
    const workspace = await daemon.createWorkspace({ name: "skills-busy", projectRoot: project });
    const model = await namedModelSession(daemon, workspace.workspaceId, "main");
    await ownSession(db, workspace.workspaceId, model);
    const action = (verb: string, params: Record<string, unknown>) => daemon.invokeModuleAction(`workspace.skills.${verb}`, params, {
        scope: "workspace", workspaceId: workspace.workspaceId,
    });
    await action("add", { alias: "alpha", definition: { name: "alpha", source } });
    const proposal = Promise.withResolvers<number>();
    const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "loop/proposal") proposal.resolve((params as { logEntryId: number }).logEntryId);
    });
    t.after(unsubscribe);
    const { loopId } = await daemon.runLoop({ workspaceId: workspace.workspaceId, sessionId: model, prompt: "Run the command." });
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
        await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: loopId }), (row) => row?.status !== 102);
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
    let daemon = new Daemon({ db, provider: null, hostPaths });
    await daemon.start();
    const context = { scope: "workspace" as const, workspaceId };
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`workspace.skills.${verb}`, params, context) as Promise<T>;
    type Listed = { alias: string; origin: string; state: string; definition: { source?: string }; detail?: { path?: string; description: string }; problem?: ProblemDetails };
    const listed = async (): Promise<Listed[]> => (await invoke<{ definitions: Listed[] }>("list", {})).definitions;
    const states = async (): Promise<string[]> => (await listed()).map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
    const dispatch = async (statement: ReturnType<typeof readStmt> | ReturnType<typeof findStmt>) =>
        (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [statement] }))[0];
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
        assert.match(bad.problem.detail, /requires YAML frontmatter/);
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
        // {§functionality-replacement} An input the family does not serve is refused by the shared schema check, by name.
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
    const daemon = new Daemon({ db, provider: null, hostPaths });
    await daemon.start();
    const context = { scope: "workspace" as const, workspaceId };
    try {
        const list = await daemon.invokeModuleAction("workspace.skills.list", {}, context) as { definitions: Array<{ alias: string; state: string; origin: string }> };
        assert.deepEqual(list.definitions.map(({ alias, state, origin }) => ({ alias, state, origin })), [{ alias: "plurnk", state: "dormant", origin: "service" }]);
        const [catalog] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [findStmt(parsePath("skill://*/SKILL.md"))] });
        assert.ok(catalog !== undefined);
        assert.equal(catalog.status, 200);
        assert.deepEqual((catalog.results as Array<Array<{ path: string }>>).flat().map(({ path }) => path), ["skill://plurnk/SKILL.md"]);
        const refused = await rejectedProblem(() => daemon.invokeModuleAction("workspace.skills.add", { alias: "alpha", definition: { name: "alpha", source: "acme/kit" } }, context));
        assert.equal(refused.type, "https://problems.plurnk.xyz/skills/functionality/source-invalid");
        const added = await daemon.invokeModuleAction("workspace.skills.add", {
            alias: "alpha", definition: { name: "alpha", source: join(base, "alpha") },
        }, context) as { status: number };
        assert.equal(added.status, 201);
        const [read] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [readStmt(parsePath("skill://alpha/SKILL.md"))] });
        assert.ok(read !== undefined);
        assert.equal(read.status, 200);
        assert.equal(typeof read.content, "string");
        assert.match(read.content as string, /A headless reference/u);
    } finally {
        await daemon.stop();
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});

test("{§functionality-inspection} root selection controls discovery, not explicitly added local references", async (t) => {
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
        const [result] = await slot.daemon.dispatchClientAction({ workspaceId: workspace.workspaceId, actor: TEST_OWNER, statements: [findStmt(parsePath("skill://*/SKILL.md"))] });
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
    assert.equal(moved.problem?.recovery, "Use plurnk (skills) replace with the complete source definition to take the current commit.");
    assert.equal(await exists(alphaPath), false, "nothing was installed from the moved branch");
    assert.equal(listed.find(({ alias }) => alias === "beta")?.state, "active", "a tag that did not move stays put");
    const refreshed = await s.action<Added>("replace", { alias: "alpha", definition: { name: "alpha", source: remote } });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.definition.definition.commit, await git(repository, "rev-parse", "HEAD"));
    assert.match(await readFile(join(refreshed.definition.detail.path, "SKILL.md"), "utf8"), /Alpha, third edition/u,
        "replacement follows the recovery without removing the definition first");
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
});

describe("Engine.operation-target-groups", () => {
const response = (content: string): MockResponse => ({
    assistant: { content, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `target-groups-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "exercise target groups");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, workspaceId, sessionId, loopId, engine };
};

const seedLogRead = async (
    db: Db,
    sessionId: number,
    loopId: number,
    turnId: number,
    sequence: number,
): Promise<number> => {
    const row = await db.engine_insert_log_entry.get<{ id: number }>({
        session_id: sessionId,
        loop_id: loopId,
        turn_id: turnId,
        sequence,
        origin: "model",
        source: null,
        model_call_id: null,
        op: "READ",
        scheme: "workspace",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: `/source-${sequence}.md`,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: `\`\`\`\`READ (workspace:///source-${sequence}.md)\`\`\`\``,
        mimetype_tx: "text/vnd.plurnk",
        rx: JSON.stringify({
            status: 200,
            content: `line from source ${sequence}`,
            mimetype: "text/plain",
            startLine: 1,
        }),
        mimetype_rx: "application/json",
        status_rx: 200,
        weight: 1,
        state: "resolved",
        outcome: null,
        attrs: "{}",
    });
    if (row === undefined) throw new Error("READ fixture insert returned no row");
    return row.id;
};

test("{§slot-order}: one admitted READ dispatches every explicit URI member", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, {
            workspaceId,
            pathname: "/alpha.md",
            content: "alpha",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            pathname: "/beta.md",
            content: "beta",
        });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response("\n````READ (workspace:///alpha.md workspace:///beta.md)````\n````NOTE\nBoth reads are pending review.\n````")],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "Read both resources." }],
        });
        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            attrs: string;
            pathname: string | null;
            status_rx: number;
        }>({ turn_id: result.turnId });

        assert.deepEqual(
            rows
                .filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))
                .map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [
                { pathname: "/alpha.md", status: 200 },
                { pathname: "/beta.md", status: 200 },
            ],
        );
    } finally {
        await db.close();
    }
});

test("{§slot-order}: one admitted scoped KILL curates every explicit URI member", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 2);
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response("\n````KILL (log:///1/1/1/READ, log:///1/1/2/READ) <1,-1>````\n````NOTE\nBoth read bodies are suppressed.\n````")],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "Curate both reads." }],
        });
        const rendered = await db.engine_render_log.all<{ id: number; folded: string }>({
            session_id: sessionId,
        });
        const foldedById = new Map(rendered.map(({ id, folded }) => [id, folded]));
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null }>({
            turn_id: result.turnId,
        });

        assert.equal(foldedById.get(firstId), "[[1,-1]]");
        assert.equal(foldedById.get(secondId), "[[1,-1]]");
        assert.equal(rows.filter(({ op }) => op === "KILL").length, 2);
    } finally {
        await db.close();
    }
});

test("{§slot-order}: one admitted KILL dispatches every explicit URI member independently", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 2);
        const source = "\n````KILL (log:///1/1/99/READ,log:///1/1/1/READ log:///1/1/2/READ)````\n````NOTE\nReview the independent KILL outcomes.\n````";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response(source)],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "user", content: "Retire the selected history." }],
        });
        const rows = await db.test_log_entries_by_turn.all<{
            id: number;
            op: string | null;
            pathname: string | null;
            status_rx: number;
            attrs: string;
            rx: string;
        }>({ turn_id: result.turnId });
        const kills = rows.filter(({ op }) => op === "KILL");
        assert.deepEqual(
            kills.map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [
                { pathname: "/1/1/99/READ", status: 404 },
                { pathname: "/1/1/1/READ", status: 200 },
                { pathname: "/1/1/2/READ", status: 200 },
            ],
            "one failed member does not hide either later successful KILL",
        );

        const sources = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({
            turn_id: sourceTurnId,
        });
        assert.deepEqual(
            sources.map(({ id, active }) => ({ id, active })),
            [
                { id: firstId, active: 0 },
                { id: secondId, active: 0 },
            ],
            "both durable source events leave only the active projection",
        );

        const effects = (await db.test_log_curation_effects_by_session.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: number;
            active_after: number;
            op: string;
        }>({ session_id: sessionId })).filter(({ op }) => op === "KILL");
        assert.deepEqual(
            effects.map(({ operation_log_entry_id, target_log_entry_id, active_before, active_after }) => ({
                operation_log_entry_id,
                target_log_entry_id,
                active_before,
                active_after,
            })),
            [
                { operation_log_entry_id: kills[1].id, target_log_entry_id: firstId, active_before: 1, active_after: 0 },
                { operation_log_entry_id: kills[2].id, target_log_entry_id: secondId, active_before: 1, active_after: 0 },
            ],
            "each successful member owns its exact append-only curation effect",
        );

        const programs = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        assert.ok(programs.some((row) => row.kind === "ops" && row.content === source), "the authored grouped program remains exact and unexpanded");
    } finally {
        await db.close();
    }
});

test("{§slot-order} {§slot-order}: a KILL written one path per slot curates every member, the scope binding to its slot; the program stays as authored", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, sessionId, loopId, sourceTurnId, 2);
        const heading = "KILL (log:///1/1/1/READ) (log:///1/1/2/READ) <1,-1>";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response(`\n\`\`\`\`${heading}\`\`\`\`\n\`\`\`\`NOTE\nThe first is retired, the second trimmed.\n\`\`\`\``)],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Curate both reads." }] });
        const rows = await db.test_log_entries_by_loop.all<{ id: number; op: string | null; turn_id: number; status_rx: number; folded: string; active: number }>({ loop_id: loopId });
        const byId = new Map(rows.map((row) => [row.id, row]));
        assert.equal(byId.get(firstId)?.active, 0, "an unscoped member retires its row whole");
        assert.equal(byId.get(secondId)?.active, 1);
        assert.equal(byId.get(secondId)?.folded, "[[1,-1]]", "the scope binds to the slot it follows");
        assert.deepEqual(rows.filter((row) => row.turn_id === result.turnId && row.op === "KILL").map(({ status_rx }) => status_rx), [200, 200], "one row per member");
        const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        const ops = programs.find(({ turn_id, kind }) => turn_id === result.turnId && kind === "ops");
        assert.ok(ops !== undefined && ops.content.includes(heading), "the stored program is the authored group, unexpanded");
    } finally {
        await db.close();
    }
});

test("{§slot-order} {§slot-order}: a READ written one path per slot lands one row per member", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content: "alpha" });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content: "beta" });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response("\n````READ (workspace:///alpha.md) (workspace:///beta.md)````\n````NOTE\nBoth reads are pending review.\n````")],
        });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Read both resources." }] });
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string; pathname: string | null; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(
            rows.filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row)).map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [{ pathname: "/alpha.md", status: 200 }, { pathname: "/beta.md", status: 200 }],
        );
    } finally {
        await db.close();
    }
});

test("{§slot-order}: READ keeps each scope while applying the heading matcher to every member", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const content = "outside\nlocal\nshared\nlocal\nshared\noutside";
        await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content });
        const source = "```READ (workspace:///alpha.md) <2,3> (workspace:///beta.md) <4,5> /shared/\n```";
        const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Read the selected lines." }] });
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string; pathname: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        const reads = rows.filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row));
        assert.deepEqual(reads.map(({ pathname, status_rx, rx }) => [pathname, status_rx, JSON.parse(rx).content]),
            [["/alpha.md", 200, "shared"], ["/beta.md", 200, "shared"]]);
        assert.deepEqual(reads.map(({ rx }) => JSON.parse(rx).lineOrdinals), [[3], [5]]);
    } finally { await db.close(); }
});

test("{§parse-recovery}: an ambiguous grouped KILL changes no member, while its sibling NOTE still executes", async () => {
    const { db, workspaceId, sessionId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const ids = [await seedLogRead(db, sessionId, loopId, sourceTurnId, 1), await seedLogRead(db, sessionId, loopId, sourceTurnId, 2)];
        const source = '```KILL (log:///1/1/1/READ) (log:///1/1/2/READ) /source/ <1,3>\n```\n\n```NOTE\nsibling retained\n```';
        const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Curate selected lines." }] });
        const originals = await db.test_log_entries_by_turn.all<{ id: number; active: number; folded: string }>({ turn_id: sourceTurnId });
        assert.deepEqual(originals.filter(({ id }) => ids.includes(id)).map(({ id, active, folded }) => [id, active, folded]),
            ids.map((id) => [id, 1, "[]"]));
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.some(({ op }) => op === "KILL"), false);
        assert.ok(rows.some(({ op, status_rx }) => op === "NOTE" && status_rx === 200));
        assert.ok(rows.some(({ status_rx, rx }) => status_rx >= 400 && rx.includes("The scope `<1,3>` follows the shared pattern of a target group.")));
    } finally { await db.close(); }
});

for (const limit of [0, 1, 2]) {
    test(`{§operator-config-workspace-settings} {§slot-order}: limit ${limit} counts compiled targets, not headings`, async () => {
        const original = process.env.PLURNK_SERVICE_MAX_COMMANDS;
        process.env.PLURNK_SERVICE_MAX_COMMANDS = limit === 0 ? "-1" : String(limit);
        const { db, workspaceId, sessionId, loopId, engine } = await setup();
        try {
            if (limit === 0) await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ maxCommands: 0 }) });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content: "alpha" });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content: "beta" });
            const source = "```READ (workspace:///alpha.md) (workspace:///beta.md)\n```\n\n```NOTE\nafter the group\n```\n\n```SEND [200]\n```\n\n```WAIT\n```";
            const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
            const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Read both resources." }] });
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string; pathname: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
            const reads = rows.filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row));
            assert.deepEqual(reads.map(({ pathname, status_rx }) => [pathname, status_rx]),
                [["/alpha.md", 200], ["/beta.md", 200]].slice(0, limit));
            assert.equal(rows.some(({ op }) => op === "NOTE"), false);
            assert.equal(rows.some(({ op, origin }) => origin === "model" && op === "SEND"), false, "reply delivery counts as an operation");
            assert.ok(rows.some(({ op }) => op === "WAIT"), "the yield remains outside the action cap");
            const error = rows.map(({ rx }) => JSON.parse(rx)).find((rx) => rx.problem?.type.endsWith("max-commands-exceeded"));
            assert.ok(error !== undefined, "omitted operations have the ordinary durable limit notice");
            assert.equal(error.problem.omittedOperations, 4 - limit);
            assert.notEqual(result.status, 200, "dropped work cannot be reported as completed");
        } finally {
            await db.close();
            if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
            else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
        }
    });
}
});

describe("Engine.tree-cap", () => {
// {§operator-config-workspace-settings} — the ceiling is the session tree's budget of model calls: BARE
// calls and a child's turns spend it, and a batch stops opening calls at the ceiling.











const declaredProviderEnv = new Map<string, string | undefined>();
test.afterEach(() => {
    for (const [key, value] of declaredProviderEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    declaredProviderEnv.clear();
});
const declaredProvider = (name: string, model: string): ProviderAlias => {
    const spec = { alias: `${name}-${crypto.randomUUID()}`, provider: "openai", model };
    const key = `PLURNK_MODEL_${spec.alias}`;
    declaredProviderEnv.set(key, process.env[key]);
    process.env[key] = `${spec.provider}/${spec.model}`;
    return spec;
};

const modelUnderRuntime = async (db: Db, workspaceId: number): Promise<number> => {
    const runtimeId = await RuntimeSession.ensure(db, workspaceId);
    const bookkeeping = await AdministrativeLoop.open(db, runtimeId);
    await Envelope.closeClientLoop(db, bookkeeping.id, { status: 200 });
    return insertSession(db, workspaceId, runtimeId, "model-tree", "model");
};

test("{§operator-config-workspace-settings}: runtime ancestry does not replace the shared child/grandchild ceiling", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32_768, responses: [
        makeMockResponse("````WORK (session://child)\nDelegate to a grandchild.\n````\n\n````WAIT\n````"),
        makeMockResponse("````WORK (session://grandchild)\nDo the leaf work.\n````\n\n````WAIT\n````"),
        makeMockResponse("````NOTE\nLeaf work is in progress.\n````"),
        makeMockResponse("````SEND [200]\nLeaf work is complete.\n````"),
        makeMockResponse("````SEND [200]\nThis fifth call exceeds the explicit ceiling.\n````"),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `runtime-tree-${crypto.randomUUID()}` });
            const { id: workspaceId } = created.result as { id: number };
            const sessionId = await modelUnderRuntime(db, workspaceId);
            const result = await runLoopToTerminal(ws, 2, {
                sessionId, prompt: "delegate twice", maxTurns: 4,
            }, { timeoutMs: 20_000 });
            assert.equal(result.finalStatus, 429);
            assert.equal(result.hitMaxTurns, true);
            assert.deepEqual(
                [result.result.problem?.treeModelCalls, result.result.problem?.maximumTurns],
                [4, 4],
                "one parent call, one child call and two grandchild calls exhaust the same ceiling",
            );
            assert.equal(mock.received.length, 4, "the runtime ancestor cannot make the model tree uncapped");
            assert.equal(mock.remaining, 1);
            const sessions = await db.test_sessions_with_parent.all<{ id: number; name: string; parent_session_id: number | null }>({});
            const child = sessions.find(({ name }) => name === "child");
            const grandchild = sessions.find(({ name }) => name === "grandchild");
            assert.equal(child?.parent_session_id, sessionId);
            assert.equal(grandchild?.parent_session_id, child?.id);
        } finally { ws.close(); }
    });
});

test("{§operator-config-workspace-settings}: BARE under the runtime actor still respects the model tree's cap", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const childSpec = declaredProvider("runtime-bare", "runtime-bare-model");
    const parent = new Mock({ contextWindow: 32_768, responses: [
        makeMockResponse("````BARE\nOne allowed answer.\n````\n\n````BARE\nNo room for another answer.\n````\n\n````NOTE\nReview the results.\n````"),
        makeMockResponse("````SEND [200]\nThis call must not run.\n````"),
    ] });
    const child = new Mock({ contextWindow: 8_192, responses: [
        { assistant: { content: "allowed", reasoning: null } },
        { assistant: { content: "beyond the ceiling", reasoning: null } },
    ] });
    ProviderInstantiate.registerInstance(child, childSpec);
    await withDaemon(parent, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `runtime-bare-${crypto.randomUUID()}` });
            const { id: workspaceId } = created.result as { id: number };
            const sessionId = await modelUnderRuntime(db, workspaceId);
            const result = await runLoopToTerminal(ws, 2, {
                sessionId, prompt: "answer twice", childSelector: childSpec.alias,
                maxTurns: 2,
            });
            assert.equal(result.finalStatus, 429);
            assert.equal(result.hitMaxTurns, true);
            assert.equal(parent.received.length, 1);
            assert.equal(child.received.length, 1);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: result.loopId });
            assert.deepEqual(rows.filter(({ op }) => op === "BARE").map(({ status_rx }) => status_rx), [200, 429]);
        } finally { ws.close(); }
    });
});

test("{§operator-config-workspace-settings}: BARE calls spend the loop's budget, and a batch is refused past the ceiling", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const parentSpec = declaredProvider("tree-cap-parent", "tree-cap-parent-model");
    const childSpec = declaredProvider("tree-cap-child", "tree-cap-child-model");
    const parent = new Mock({ contextWindow: 16_384, responses: [
        makeMockResponse("````BARE\nfirst\n````\n\n````BARE\nsecond\n````\n\n````BARE\nthird\n````\n\n````NOTE\nthree isolated calls\n````"),
        makeMockResponse("````NOTE\nstill going\n````"),
        makeMockResponse("````NOTE\nstill going\n````"),
    ] });
    const child = new Mock({ contextWindow: 8_192, responses: [
        { assistant: { content: "one", reasoning: null } },
        { assistant: { content: "two", reasoning: null } },
        { assistant: { content: "three", reasoning: null } },
    ] });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tree-cap-bare-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "spend the budget on isolated calls",
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
                maxTurns: 3,

            }, { timeoutMs: 20_000 });
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 429, "the tree's ceiling ends the loop at 429 {§tokenomics}");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
            const bares = rows.filter((row) => row.op === "BARE" && row.origin === "model");
            assert.deepEqual(bares.map((row) => row.status_rx), [200, 200, 429],
                "turn 1 is call one; the first two BAREs are calls two and three; the third meets the ceiling and makes no call");
            const refused = JSON.parse(bares[2].rx) as { problem: { type: string; treeModelCalls: number; maximumTurns: number } };
            assert.match(refused.problem.type, /\/max-turns$/u);
            assert.deepEqual([refused.problem.treeModelCalls, refused.problem.maximumTurns], [3, 3]);
            assert.equal(child.received.length, 2, "the refused BARE never reached the child provider");
            assert.equal(parent.remaining, 2, "the parent's second turn was never requested: the ceiling was met before it");
        } finally { ws.close(); }
    });
});

test("{§operator-config-workspace-settings}: a child's turns spend the parent's budget", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16_384, responses: [
        makeMockResponse("````WORK (session://helper)\nDo one small thing.\n````\n\n````WAIT\ndelegated\n````", 10),
        makeMockResponse("````NOTE\nchild working\n````", 10),
        makeMockResponse("````SEND [200]\nchild done\n````", 10),
        makeMockResponse("````NOTE\nparent continues\n````", 10),
        makeMockResponse("````NOTE\nnever requested: the tree's ceiling is met first\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tree-cap-child-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, { prompt: "delegate", maxTurns: 4 }, { timeoutMs: 20_000 });
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 429);
            const problem = (result.result as { problem?: { treeModelCalls?: number; maximumTurns?: number } }).problem;
            assert.deepEqual([problem?.treeModelCalls, problem?.maximumTurns], [4, 4], "two parent turns and two child turns met a ceiling of four");
            const parentTurns = await db.lifecycle_loop_model_turn_count.get<{ count: number }>({ loop_id: result.loopId });
            assert.equal(parentTurns?.count, 2, "the parent itself ran two turns; the child's two were counted against the same budget");
            assert.equal(mock.remaining, 1, "the fifth response was never requested");
        } finally { ws.close(); }
    });
});
});

describe("mcp-configuration", () => {
// {§mcp-configuration} {§functionality-inspection}















const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

test("{§mcp-file-configuration} a global mcp.json supplies callable servers without a plugin or environment definition", { timeout: 30_000 }, async (t) => {
    const roots = process.env.PLURNK_SERVICE_ROOTS;
    process.env.PLURNK_SERVICE_ROOTS = "global";
    t.after(() => { if (roots === undefined) delete process.env.PLURNK_SERVICE_ROOTS; else process.env.PLURNK_SERVICE_ROOTS = roots; });
    const { hostPaths, env } = await mcpFixture(t, {});
    const directory = join(hostPaths.home, ".agents");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "mcp.json");
    const contents = JSON.stringify({ mcpServers: { fixture: stdioEntry("echo-server.mjs") } });
    await writeFile(file, contents);
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-file-${crypto.randomUUID()}`);
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const list = await daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult;
    assert.deepEqual(list.definitions.map(({ alias, origin, state, provenance }) => ({ alias, origin, state, provenance })), [{
        alias: "fixture", origin: "service", state: "dormant",
        provenance: { kind: "file", source: file, reference: "/mcpServers/fixture" },
    }]);
    const [result] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parseOne("````fixture (echo)\n{\"message\":\"file-backed\"}\n````")] });
    assert.equal(result.status, 200);
    const output = await awaitExecOutcome(db, { workspaceId, scheme: "fixture", channel: "json", after: 0 });
    assert.deepEqual(output.content, [{ type: "text", text: "file-backed" }]);
    assert.equal(await readFile(file, "utf8"), contents, "loading and invoking never rewrite operator configuration");
});

test("{§mcp-file-configuration} workspace and environment overrides restore the current file definition and enabledness", async (t) => {
    const { hostPaths, env } = await mcpFixture(t, {});
    const project = join(hostPaths.home, "project");
    const directories = [join(project, ".agents"), hostPaths.configDir, join(hostPaths.home, ".agents")];
    for (const directory of directories) await mkdir(directory, { recursive: true });
    for (const [index, directory] of directories.entries()) {
        await writeFile(join(directory, "mcp.json"), JSON.stringify({ mcpServers: { fixture: stdioEntry("echo-server.mjs", { SOURCE: String(index) }) } }));
    }
    env.PLURNK_MCP_ENABLED = "0";
    const db = await openMigrated();
    let daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const workspace = await daemon.createWorkspace({ name: "file-cascade", projectRoot: project });
    const headless = await daemon.createWorkspace({ name: "file-headless", projectRoot: null });
    const invoke = (verb: string, params = {}, workspaceId = workspace.workspaceId) =>
        daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId });
    const list = async (workspaceId?: number) => (await invoke("list", {}, workspaceId) as FunctionalityListResult).definitions;
    assert.equal((await list())[0].provenance?.source, join(directories[0], "mcp.json"));
    assert.equal((await list(headless.workspaceId))[0].provenance?.source, join(directories[1], "mcp.json"));
    assert.equal((await list())[0].state, "disabled");
    env.PLURNK_MCP_fixture = JSON.stringify({ name: "fixture", ...stdioEntry("echo-server.mjs", { SOURCE: "environment" }) });
    assert.deepEqual((await list())[0].provenance, { kind: "environment", source: "PLURNK_MCP_fixture" });
    const local = { name: "fixture", ...stdioEntry("echo-server.mjs", { SOURCE: "local" }) };
    await invoke("add", { alias: "fixture", definition: local });
    assert.equal((await list())[0].origin, "workspace");
    assert.equal((await list())[0].provenance, undefined);
    delete env.PLURNK_MCP_fixture;
    await rm(join(directories[0], "mcp.json"));
    await invoke("remove", { alias: "fixture" });
    const restored = (await list())[0];
    assert.equal(restored.state, "disabled");
    assert.equal(restored.provenance?.source, join(directories[1], "mcp.json"));
    assert.deepEqual(restored.definition, { name: "fixture", ...stdioEntry("echo-server.mjs", { SOURCE: "1" }) });
    await daemon.stop();
    daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    await daemon.start();
    assert.equal((await list())[0].state, "disabled", "restart preserves inherited enabledness without a local mask");
    await rm(join(directories[1], "mcp.json"));
    assert.equal((await list())[0].provenance?.source, join(directories[2], "mcp.json"));
    assert.deepEqual(await readdir(directories[2]), ["mcp.json"], "workspace mutations never manufacture plugin files");
});

test("{§mcp-file-configuration} malformed files leave chat usable and normal turns publish repairs, changes, and removal", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const { hostPaths, env } = await mcpFixture(t, {});
    const directory = join(hostPaths.home, ".agents");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "mcp.json");
    await writeFile(file, "not json");
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-file-repair-${crypto.randomUUID()}`);
    const model = await insertSession(db, workspaceId, null, "primary", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 5 }, () => makeMockResponse("````SEND [200]\nConfiguration checked.\n````")) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    const ended: number[] = [];
    const unsubscribe = daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") ended.push((params as { loopId: number }).loopId); });
    t.after(unsubscribe);
    await daemon.start();
    const turn = async () => {
        const started = await daemon.runLoop({ workspaceId, sessionId: model, prompt: "Inspect configuration." });
        await waitFor(() => ended, (ids) => ids.includes(started.loopId), { timeoutMs: 10_000 });
    };
    const list = async () => (await daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult).definitions;
    const rejectsConfiguration = () => assert.rejects(list(), (cause: unknown) => {
        const problem = Problems.fromError(cause);
        assert.equal(problem?.type, "https://problems.plurnk.xyz/functionality/configuration-invalid");
        assert.ok(problem.detail?.includes(file));
        return true;
    });
    await rejectsConfiguration();
    await turn();
    assert.ok(userText(provider.received[0]).includes(file), "the model can locate and repair the malformed file");
    const save = (name: string) => writeFile(file, JSON.stringify({ mcpServers: { [name]: stdioEntry("echo-server.mjs") } }));
    await save("first");
    assert.deepEqual((await list()).map(({ alias, state }) => [alias, state]), [["first", "dormant"]],
        "a repaired source is inspectable before another turn; its obsolete parse error cannot override fresh resolution");
    assert.equal(daemon.schemes.has("first", workspaceId), false, "inspection does not publish the repaired server");
    await turn();
    assert.deepEqual((await list()).map(({ alias, state }) => [alias, state]), [["first", "active"]]);
    await save("second");
    assert.equal((await list())[0].state, "dormant", "inspection does not pretend a changed definition is already active");
    await turn();
    assert.deepEqual((await list()).map(({ alias, state }) => [alias, state]), [["second", "active"]]);
    await writeFile(file, "not json again");
    await turn();
    await rejectsConfiguration();
    await rm(file);
    assert.deepEqual(await list(), [], "removing a malformed source also clears its inspection failure before publication");
    await turn();
    assert.deepEqual(await list(), []);
    assert.equal(provider.received.length, 5, "every configuration state left inference usable");
});

test("{§configuration-repair-path} a model's EDIT and same-turn list observe the repair before the next turn activates its tool", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const { hostPaths, env } = await mcpFixture(t, {});
    const project = join(hostPaths.home, "project");
    const file = join(project, ".agents", "mcp.json");
    await mkdir(join(project, ".agents"), { recursive: true });
    await writeFile(file, "not json");
    const content = JSON.stringify({ mcpServers: { repaired: stdioEntry("echo-server.mjs") } });
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse(`\`\`\`\`EDIT (.agents/mcp.json) <1,-1>\n${content}\n\`\`\`\`\n\n\`\`\`\`plurnk (mcp)\n\`\`\`\``),
        makeMockResponse("````repaired (echo)\n{\"message\":\"same-turn-repair\"}\n````"),
        makeMockResponse("````SEND [200]\nConfiguration repaired.\n````"),
    ] });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "same-turn-repair", projectRoot: project });
    await daemon.invokeModuleAction("workspace.members.add", { files: [".agents/mcp.json"] }, { scope: "workspace", workspaceId });
    const sessionId = await insertSession(db, workspaceId, null, "repairer", "model");
    const finalStatuses: number[] = [];
    const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
        if (method === "loop/terminated") finalStatuses.push((params as { result: { status: number } }).result.status);
    });
    t.after(unsubscribe);
    await daemon.runLoop({ workspaceId, sessionId, prompt: "Repair the MCP file and verify its tool." });
    await waitFor(() => finalStatuses, (statuses) => statuses.length > 0, { timeoutMs: 15_000 });
    assert.deepEqual(finalStatuses, [200]);
    const log = await daemon.readLog({ workspaceId, sessionId, limit: 100 });
    assert.equal(await readFile(file, "utf8"), content, JSON.stringify(log.filter(({ op }) => op === "EDIT")));
    const inspected = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk" });
    assert.deepEqual((inspected.definitions as FunctionalityListResult["definitions"]).map(({ alias, state }) => [alias, state]),
        [["repaired", "dormant"]], "the manager's own same-turn result observes fresh configuration without premature publication");
    const echoed = await awaitExecOutcome(db, { workspaceId, scheme: "repaired", channel: "json" });
    assert.deepEqual(echoed.content, [{ type: "text", text: "same-turn-repair" }]);
    assert.equal(provider.received.length, 3, "no stale-source recovery turn is necessary");
});

test("{§mcp-configuration} configured servers and workspace additions are callable without altering plugin installations", { timeout: 60_000 }, async (t) => {
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-configuration-${crypto.randomUUID()}`);
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 6 }, () => makeMockResponse("````SEND [200]\ndone\n````", 20)) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: mcpEnv }), "@plurnk/plurnk-mcp");
    const directory = join(hostPaths.plurnkPluginsDir, "added");
    await mkdir(directory, { recursive: true });
    const manifest = JSON.stringify({ name: "added", description: "Independent plugin installation." });
    await writeFile(join(directory, "plugin.json"), manifest);
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId }) as Promise<T>;
    type Listed = { alias: string; origin: string; state: string };
    const listed = async (): Promise<Listed[]> => (await invoke<{ definitions: Listed[] }>("list", {})).definitions;
    const call = async (server: string, tool: string) => {
        const before = (await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: server, prefix: "/%" })).length;
        const [result] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parseOne(`\`\`\`\`${server} (${tool})\n{"message":"configuration"}\n\`\`\`\``)] });
        assert.ok(result !== undefined);
        if (result.status === 200) {
            const output = await awaitExecOutcome(db, { workspaceId, scheme: server, channel: "json", after: before });
            assert.deepEqual(output.content, [{ type: "text", text: "configuration" }]);
        }
        return result;
    };

    assert.deepEqual(
        daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.mcp.")).toSorted(),
        ["add", "complete", "disable", "enable", "list", "oauth.begin", "oauth.complete", "remove", "replace"].map((verb) => `workspace.mcp.${verb}`),
        "with no registry the mcp family has every lifecycle verb but discover, beside its protocol continuations",
    );
    assert.deepEqual((await listed()).map(({ alias, origin, state }) => ({ alias, origin, state })), [{ alias: "fixture", origin: "service", state: "dormant" }]);
    assert.equal((await call("fixture", "echo")).status, 200, "the configured server runs its read-only tool on first use");
    assert.equal((await listed())[0]?.state, "active");
    // {§functionality-replacement} With no registry the manager teaches no discover.
    const references = await daemon.engine.referenceEntries(workspaceId);
    const mcpSchema = references.find(({ pathname }) => pathname === "/_plurnk/tools/plurnk/mcp.json")?.content ?? "";
    const parsedSchema = JSON.parse(mcpSchema) as { properties: { verb: { enum: string[] } }; description: string };
    assert.deepEqual(parsedSchema.properties.verb.enum, ["list", "add", "replace", "enable", "disable", "remove"], "the tool schema names the verbs the family serves");
    assert.doesNotMatch(parsedSchema.description, /`discover`: Return inert candidates/u, "the verb teaching has no discover");
    const [unserved] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parseOne("````plurnk (mcp)\n{\"verb\": \"discover\", \"query\": \"echo\"}\n````")] });
    assert.ok(unserved !== undefined);
    assert.equal(unserved.status, 400, "a discover the family does not serve is refused as an unknown verb");
    assert.match(String((unserved as { problem?: { type?: string } }).problem?.type), /\/verb-unknown$/u);
    assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "fixture" })).definition.state, "disabled");
    assert.ok((await call("fixture", "echo")).status >= 400, "a disabled server's tool is absent");
    assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: "fixture" })).definition.state, "active");

    const entry = stdioEntry("echo-server.mjs");
    const added = await invoke<{ status: number; definition: { state: string } }>("add", { alias: "added", definition: { name: "added", ...entry } });
    assert.equal(added.status, 201);
    assert.equal(added.definition.state, "active");
    assert.equal((await listed()).find(({ alias }) => alias === "added")?.origin, "workspace");
    assert.equal(await readFile(join(directory, "plugin.json"), "utf8"), manifest);
    assert.deepEqual(await readdir(directory), ["plugin.json"], "MCP add writes no plugin files");
    assert.equal((await call("added", "echo")).status, 200, "the workspace addition launches directly");
    assert.equal((await invoke<{ removed: boolean }>("remove", { alias: "added" })).removed, true);
    assert.equal(await readFile(join(directory, "plugin.json"), "utf8"), manifest, "MCP remove preserves the independent plugin");
    assert.deepEqual((await listed()).map(({ alias }) => alias), ["fixture"]);
});

test("{§functionality-inspection} {§functionality-inspection} changed baseline definitions publish at the next turn, even after list saw them first", { timeout: 60_000 }, async (t) => {
    serverProposals(t, "accept");
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `mcp-hotload-${crypto.randomUUID()}`);
    const model = await insertSession(db, workspaceId, null, "primary", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: Array.from({ length: 6 }, () => makeMockResponse("````SEND [200]\ndone\n````", 20)) });
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: mcpEnv }), "@plurnk/plurnk-mcp");
    const events: Array<{ method: string; params: unknown }> = [];
    const unsubscribe = daemon.subscribeToEvents((_w, method, params) => { events.push({ method, params }); });
    t.after(async () => { unsubscribe(); await daemon.stop(); await db.close(); });
    await daemon.start();
    type Listed = { alias: string; state: string };
    const states = async (): Promise<Listed[]> => ((await daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId })) as { definitions: Listed[] }).definitions.map(({ alias, state }) => ({ alias, state }));
    const turn = async (): Promise<void> => {
        const started = await daemon.runLoop({ workspaceId, sessionId: model, prompt: "hotload" });
        await waitFor(() => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === started.loopId), (list) => list.length > 0, { timeoutMs: 20_000 });
    };

    await turn();
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }]);
    mcpEnv.PLURNK_MCP_second = JSON.stringify({ name: "second", ...stdioEntry("echo-server.mjs") });
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }, { alias: "second", state: "dormant" }],
        "inspection shows an out-of-band arrival as dormant until a turn publishes it");
    await turn();
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }, { alias: "second", state: "active" }],
        "the next turn publishes the definition that list had already seen");
    delete mcpEnv.PLURNK_MCP_second;
    await turn();
    assert.deepEqual(await states(), [{ alias: "fixture", state: "active" }], "a baseline removed between turns leaves at the next one");
});
});

describe("members-functionality", () => {
// {§tools-resource-materialization} {§functionality-replacement} {§tools-resource-materialization} {§tools-resource-materialization}





















const execFileP = promisify(execFile);

type Definition = { alias: string; origin: string; state: string; definition?: { glob: string; provenance?: { kind: string } }; detail?: { effect: string; pattern: string; matched: number; files: string[]; ignored: number } };
type Candidate = { alias?: string; definition: { glob: string }; provenance: { kind: string; source: string }; summary?: string };
type Receipt = { status: number; family: string; alias?: string; definitions?: Definition[]; removed?: true };

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

const workspaceContext = (workspaceId: number) => ({ scope: "workspace" as const, workspaceId });

// A git project: README.md and big/tokenizer.json committed; loose.md, loose2.md, docs/guide.md
// untracked; ignored.log ignored.
const gitProject = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-members-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored.log\n");
    await writeFile(join(root, "README.md"), "# tracked\n");
    await mkdir(join(root, "big"), { recursive: true });
    await writeFile(join(root, "big", "tokenizer.json"), "{\"vocab\":[]}\n");
    await git(["add", ".gitignore", "README.md", "big/tokenizer.json"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "chore: seed"]);
    await writeFile(join(root, "loose.md"), "# loose\n");
    await writeFile(join(root, "loose2.md"), "# loose two\n");
    await writeFile(join(root, "ignored.log"), "secret\n");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "# guide\n");
    return root;
};

const withEnv = async (overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> => {
    const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { await run(); } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const memberOf = async (db: Db, workspaceId: number, pathname: string): Promise<boolean> =>
    (await db.crud_find_workspace_entry.get<{ id: number }>({
        workspace_id: workspaceId, scheme: "file", authority: "", pathname,
    })) !== undefined;

for (const decision of ["auto", "accept", "reject"] as const) test(`{§op-methods-op-dispatch} members ${decision} settles before a READ in the same model turn`, { timeout: 30_000 }, async (t) => {
    serverProposals(t, decision === "auto" ? "accept" : "review");
    const root = await gitProject();
    await withEnv({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "root", PLURNK_SERVICE_GIT_AUTO: "1" }, async () => {
        const db = await openMigrated();
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeRawMockResponse([
                PlurnkParser.frame("plurnk (members)", JSON.stringify({ verb: "add", files: ["loose.md"] })),
                PlurnkParser.frame("READ (loose.md)", ""),
                PlurnkParser.frame("NOTE", "Review the admitted file."),
            ].join("\n\n")),
            makeMockResponse(PlurnkParser.frame("SEND [200]", "Read the file.")),
        ] });
        const daemon = new Daemon({ db, provider });
        const results: Array<{ status: number; body?: string }> = [];
        try {
            const workspaceId = await insertWorkspace(db, "ordered-members");
            await rootWorkspace(db, workspaceId, root);
            const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
            if (decision !== "auto") await ownSession(db, workspaceId, sessionId);
            daemon.subscribeToEvents((_id, method, params) => {
                if (method !== "operation/event") return;
                const event = params as { phase: string; origin: string; statement: PlurnkStatement; result?: { status: number; body?: string } };
                if (event.phase === "settled" && event.origin === "model" && event.statement.op === "READ" && event.result !== undefined) results.push(event.result);
            });
            await daemon.start();
            const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Admit loose.md and read it.", maxTurns: 2 });
            if (decision !== "auto") {
                const proposals = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1);
                assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "nothing publishes before approval");
                assert.deepEqual(results, [], "the next READ waits for the decision");
                await daemon.resolveProposal(proposals[0].logEntryId, { decision }, { workspaceId, address: TEST_OWNER });
                if (decision === "reject") {
                    // {§membership-auto-add} — the READ of the file still unadmitted proposes its admission in its turn,
                    // after the rejection settled; refused as well, the READ settles rejected.
                    const again = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1 && items[0].op === "READ");
                    assert.deepEqual(results, [], "the READ waits for its own decision");
                    await daemon.resolveProposal(again[0].logEntryId, { decision: "reject" }, { workspaceId, address: TEST_OWNER });
                }
            }
            const lifecycle = new LoopLifecycle(db);
            await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
            assert.deepEqual(results.map(({ status }) => status), [decision === "reject" ? 400 : 200], "the read observes the settled decision, not a merely started manager stream");
            assert.equal(await memberOf(db, workspaceId, "loose.md"), decision !== "reject");
        } finally { await daemon.stop(); await db.close(); }
    }).finally(() => rm(root, { recursive: true, force: true }));
});

const rows = async (db: Db, workspaceId: number): Promise<string[]> =>
    (await db.crud_list_workspace_constraints.all<{ effect: string; glob: string; source: string }>({ workspace_id: workspaceId }))
        .map(({ effect, glob, source }) => `${effect} ${glob} ${source}`);

const problemOf = async (run: () => Promise<unknown>): Promise<{ type?: string; status?: number; detail?: string; recovery?: string; alias?: string }> => {
    const error = await run().then(() => null, (cause: unknown) => cause);
    assert.ok(error instanceof OperationFailureError, `expected an OperationFailureError, got ${String(error)}`);
    return { ...error.result.problem, status: error.result.status };
};

test("{§find} members discovery, scans, exclusions and SQL agree on escaped filenames", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "plurnk-members-glob-"));
    const root = join(temporary, String.raw`base\[1]`);
    const intended = String.raw`dir\name/a.txt`;
    const neighbor = "dir/name/a.txt";
    const pattern = String.raw`dir\\name/*.txt`;
    const names = [intended, neighbor, "dirname/a.txt", "a*.txt", "a/b.txt"];
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        for (const name of names) {
            await mkdir(dirname(join(root, name)), { recursive: true });
            await writeFile(join(root, name), name);
        }
        const workspaceId = await insertWorkspace(db, "members-escaped");
        await rootWorkspace(db, workspaceId, root);
        await daemon.start();
        const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
            daemon.invokeModuleAction(`workspace.members.${verb}`, params, workspaceContext(workspaceId)) as Promise<T>;
        const add = (...files: string[]) => invoke("add", { files });
        const definitions = async () => (await invoke<{ definitions: Definition[] }>("list", {})).definitions;
        const discover = async (query: string) => (await invoke<{ candidates: Candidate[] }>("discover", { query })).candidates[0];

        const preview = await discover(String.raw`dir\\name/a.txt`);
        assert.equal(preview.provenance.kind, "preview", "escape syntax is classified at the shared boundary");
        assert.match(preview.summary!, /^would include 1 file/u);
        await add(pattern);
        assert.equal(await memberOf(db, workspaceId, intended), true);
        assert.equal(await memberOf(db, workspaceId, neighbor), false);
        assert.deepEqual((await definitions()).find(({ alias }) => alias === pattern)?.detail?.files, [intended]);
        assert.deepEqual(await db.crud_constraint_including_by_definition.get({ workspace_id: workspaceId, key: intended }), { included: 1 });
        assert.equal(await db.crud_constraint_including_by_definition.get({ workspace_id: workspaceId, key: neighbor }), undefined);

        await add(String.raw`a\*.txt`);
        assert.equal(await memberOf(db, workspaceId, "a*.txt"), true);
        assert.equal(await memberOf(db, workspaceId, "a/b.txt"), false);
        await add("dir/name/*.txt");
        const exclusionPreview = await discover(`!${pattern}`);
        assert.match(exclusionPreview.summary!, /^would exclude 1 member/u);
        await add(`!${pattern}`);
        assert.equal(await memberOf(db, workspaceId, intended), false);
        assert.equal(await memberOf(db, workspaceId, neighbor), true);
        assert.deepEqual((await definitions()).find(({ alias }) => alias === `!${pattern}`)?.detail?.files, [intended]);
        assert.deepEqual(await db.crud_constraint_excluding.get({ workspace_id: workspaceId, key: intended }), { glob: pattern });
        assert.equal(await db.crud_constraint_excluding.get({ workspace_id: workspaceId, key: neighbor }), undefined);
    } finally {
        await daemon.stop();
        await db.close();
        await rm(temporary, { recursive: true, force: true });
    }
});

for (const boundary of ["startup", "workspace inspection"] as const) {
    test(`{§configuration-repair-path} ${boundary} preserves inspection of invalid members without publishing a winner`, async () => {
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider: null });
        try {
            const workspaceId = await insertWorkspace(db, "ambiguous-members");
            if (boundary === "workspace inspection") await daemon.start();
            await withEnv({
                PLURNK_MEMBERS_DOCS: "docs/**",
                PLURNK_MEMBERS_docs: "src/**",
                PLURNK_MEMBERS_ENABLED: "1",
            }, async () => {
                if (boundary === "startup") await daemon.start();
                await assert.rejects(
                    () => daemon.invokeModuleAction(
                        "workspace.members.list", {}, workspaceContext(workspaceId),
                    ),
                    (error: unknown) => {
                        assert.ok(error instanceof OperationFailureError);
                        assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/functionality/configuration-invalid");
                        assert.equal(error.result.problem.detail, "PLURNK_MEMBERS_DOCS is not a declared control; use a lowercase resource alias with underscores for hyphens and uppercase setting names.");
                        return true;
                    },
                );
                assert.deepEqual(await rows(db, workspaceId), [], "neither ambiguous definition changes membership");
            });
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
}

test("{§tools-resource-materialization} {§functionality-replacement} client and model share one surface named by globs; the ceiling, the union, exclusion, ignore, list, and discover hold", async () => {
    const root = await gitProject();
    await withEnv({
        PLURNK_SERVICE_GIT_ALLOWED: "1",
        PLURNK_SERVICE_GIT_AUTO: "1",
        PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "none",
        PLURNK_MEMBERS_docs: "docs/**",
        PLURNK_MEMBERS_ENABLED: "1",
    }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `members-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const model = await insertSession(db, workspaceId, null, "model", "model");
        await ownSession(db, workspaceId, model);
        const daemon = new Daemon({ db, provider: null });
        await daemon.start();
        const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>, _sessionId = model): Promise<T> =>
            daemon.invokeModuleAction(`workspace.members.${verb}`, params, workspaceContext(workspaceId)) as Promise<T>;
        const definitions = async (sessionId = model) => (await invoke<{ definitions: Definition[] }>("list", {}, sessionId)).definitions;
        const states = async (sessionId = model) => (await definitions(sessionId)).map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
        const discover = async (query: string) => (await invoke<{ candidates: Candidate[] }>("discover", { query })).candidates[0];
        // The model's own surface: its operations, reviewed by its owner.
        const operate = (program: string) => modelOperation(daemon, db, { workspaceId, sessionId: model, statement: parseOne(program) });
        const proposals: number[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
        });
        // The dispatched result and the completed JSON output report the same settlement.
        const outputs = async () => (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" })).length;
        const accepted = async (program: string) => {
            const seen = proposals.length;
            const before = await outputs();
            const pending = operate(program);
            while (proposals.length === seen) await new Promise((resolve) => setTimeout(resolve, 5));
            await daemon.resolveProposal(proposals[seen], { decision: "accept" }, { workspaceId, address: TEST_OWNER });
            const result = await pending;
            const outcome = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk", after: before, timeoutMs: 60_000 }) as Receipt & { problem?: { type?: string; recovery?: string } };
            return { result, outcome };
        };
        const modelAdd = (...files: string[]) => accepted(`\`\`\`\`plurnk (members)\n${JSON.stringify({ verb: "add", files })}\n\`\`\`\``);
        try {
            // {§functionality-replacement} — the surface: no replace, and the add and select inputs are the family's own.
            assert.deepEqual(
                daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.members.")).toSorted(),
                ["add", "disable", "discover", "enable", "list", "remove"].map((verb) => `workspace.members.${verb}`),
            );

            // The baseline: tracked is a member, loose is not ({§membership}).
            assert.equal(await memberOf(db, workspaceId, "README.md"), true);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "an untracked file is dark until added");
            // Service definitions from the operator's env ride like PLURNK_MCP_*: docs/** is enabled by
            // default, named by its glob, and list says what it resolved to and which key declared it.
            assert.deepEqual(await states(), ["docs/**:service:dormant"]);
            await invoke("enable", { file: "docs/**" });
            assert.deepEqual(await states(), ["docs/**:service:active"]);
            const invalid = await problemOf(() => invoke("add", { alias: "docs", definition: { glob: "docs/**" } }));
            assert.equal(invalid.type, "https://problems.plurnk.xyz/functionality/arguments-invalid", "an alias-named body is not the add input");
            assert.equal((await problemOf(() => invoke("enable", { alias: "docs" }))).type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
            assert.equal((await problemOf(() => invoke("add", { files: [] }))).type, "https://problems.plurnk.xyz/functionality/arguments-invalid", "add names at least one glob");
            assert.deepEqual((await definitions())[0]?.definition, { glob: "docs/**", provenance: { kind: "service-configuration" } });
            assert.deepEqual((await definitions() as Array<{ provenance?: object }>)[0]?.provenance, { kind: "environment", source: "PLURNK_MEMBERS_docs" });
            await daemon.settleFunctionality(workspaceId);
            // {§functionality-model-projection} — the tool schema teaches tracked-or-picked and the scope
            // lattice beneath its generated verb list, from plurnk-core/docs/members.md.
            const membersDoc = (await daemon.engine.referenceEntries(workspaceId)).find(({ pathname }) => pathname === "/_plurnk/tools/plurnk/members.json");
            assert.ok(membersDoc, "the members tool schema is a reference entry");
            const membersSchema = JSON.parse(membersDoc.content) as { description: string; properties: Record<string, unknown> };
            assert.match(membersSchema.description, /## When a file you need is not a member/u, "the body teaches the recovery when a file is not a member");
            assert.match(membersSchema.description, /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE/u, "the body names the scope ceiling");
            assert.doesNotMatch(membersSchema.description, /git add/u, "no recovery asks the model to change the repository");
            assert.ok(Object.hasOwn(membersSchema.properties, "files"), "the schema teaches the family's own add input");
            assert.ok(Object.hasOwn(membersSchema.properties, "file"), "and its select input");
            assert.doesNotMatch(membersDoc.content, /replace/u, "the family serves no replace, so nothing teaches one");
            assert.ok(membersSchema.description.indexOf("## Verbs") < membersSchema.description.indexOf("## What makes a file visible"), "the generated verb list precedes the authored body");

            assert.equal(await memberOf(db, workspaceId, "docs/guide.md"), true, "an enabled service definition projects onto the overlay");
            assert.ok((await rows(db, workspaceId)).includes("include docs/** members"), "a human-authored definition projects with source members");
            assert.deepEqual((await definitions())[0]?.detail, { effect: "include", pattern: "docs/**", matched: 1, files: ["docs/guide.md"], ignored: 0 });
            // {§tools-resource-materialization} — the document is named by the glob, percent-encoded as one segment.
            await operate("````READ (workspace:///_plurnk/members/docs%2F%2A%2A.md) <1,-1>````");
            const doc = (await db.engine_list_workspace_entries.all<{ scheme: string; pathname: string; channel: string; content: string }>({ workspace_id: workspaceId }))
                .find((row) => row.scheme === "workspace" && row.pathname === "/_plurnk/members/docs%2F%2A%2A.md" && row.channel === "body");
            assert.ok(doc !== undefined, "an enabled definition is one generated document under workspace:///_plurnk/members/");
            assert.match(doc.content, /^# `docs\/\*\*`\n\n## Summary\n\ninclude `docs\/\*\*` → 1 file\n/u, "the document summary is what the glob resolved to");
            assert.match(doc.content, /\| origin \| service \|/u);

            // discover explains one file — tracked, included, ignored, untracked, absent — and
            // previews a glob without adding anything; a candidate is named by its glob.
            assert.equal((await discover("README.md")).provenance.kind, "member");
            assert.match(String((await discover("README.md")).summary), /tracked by git/u);
            assert.match(String((await discover("docs/guide.md")).summary), /included by `docs\/\*\*`/u);
            const loose = await discover("loose.md");
            assert.equal(loose.provenance.kind, "candidate");
            assert.equal(loose.alias, "loose.md");
            assert.deepEqual(loose.definition, { glob: "loose.md" });
            assert.equal((await discover("ignored.log")).provenance.kind, "ignored");
            assert.equal((await discover("nope.md")).provenance.kind, "absent");
            const preview = await discover("*.md");
            assert.equal(preview.provenance.kind, "preview");
            assert.equal(preview.alias, "*.md");
            assert.match(String(preview.summary), /would include 2 files \(1 already members, 0 ignored/u);
            assert.match(String((await discover("!README.md")).summary), /would exclude 1 member: README\.md/u);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "discover admits nothing");
            assert.deepEqual(await states(), ["docs/**:service:active"], "discover records nothing");
            // {§functionality-replacement} `query` is the one input: `source` is refused by the
            // shared schema check, and a query naming no path or pattern by the family itself.
            assert.equal((await problemOf(() => invoke("discover", { source: "README.md" }))).type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
            const bare = await problemOf(() => invoke("discover", { query: "!" }));
            assert.equal(bare.type, "https://problems.plurnk.xyz/members/functionality/query-invalid");
            assert.equal(bare.detail, "'!' names no path or pattern.");

            // A client action adds a loose file: a workspace-origin definition, active, projected, member.
            // The receipt lists what the add admitted.
            const added = await invoke<Receipt>("add", { files: ["loose.md"] });
            assert.equal(added.status, 201);
            assert.equal(added.alias, undefined, "an addressing family's add receipt lists its definitions");
            assert.deepEqual(added.definitions?.map(({ alias, origin, state }) => `${alias}:${origin}:${state}`), ["loose.md:workspace:active"]);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), true, "a client-added glob admits the file");
            assert.deepEqual(await states(), ["docs/**:service:active", "loose.md:workspace:active"]);
            assert.deepEqual((await definitions()).find((d) => d.alias === "loose.md")?.detail, { effect: "include", pattern: "loose.md", matched: 1, files: ["loose.md"], ignored: 0 });
            // Reapplying a definition is idempotent (200); naming it twice in one add is one definition.
            const again = await invoke<Receipt>("add", { files: ["loose.md", " loose.md "] });
            assert.equal(again.status, 200);
            assert.deepEqual(again.definitions?.map(({ alias }) => alias), ["loose.md"]);

            // The model's add under the shipped ceiling (none) is refused up front, naming the user's path.
            const { result: refused, outcome } = await modelAdd("loose2.md");
            assert.equal(refused.status, 403, "acceptance does not hide the coordinator's refusal");
            assert.equal(outcome.status, 403);
            assert.equal(outcome.problem?.type, "https://problems.plurnk.xyz/members/functionality/model-scope");
            assert.doesNotMatch(String(outcome.problem?.recovery), /\bgit\b/u, "its recovery asks nothing of the repository");
            assert.equal(await memberOf(db, workspaceId, "loose2.md"), false, "nothing widened");
            assert.deepEqual(await states(), ["docs/**:service:active", "loose.md:workspace:active"], "no definition was recorded");

            // Under scope root the model's glob is admitted and projected as source model; a model
            // glob over an ignored path admits nothing, and list says so. One add names several globs
            // and the receipt lists each; one glob past the scope refuses them all.
            process.env.PLURNK_SERVICE_MEMBERS_MODEL_SCOPE = "root";
            const granted = await modelAdd("loose2.md", "ignored.log");
            assert.equal(granted.outcome.status, 201, "the model's definitions are added and enabled");
            assert.deepEqual(granted.outcome.definitions?.map(({ alias, origin, state }) => `${alias}:${origin}:${state}`), ["loose2.md:workspace:active", "ignored.log:workspace:active"]);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose2.md"), true, "a model glob inside the root is a member under scope root");
            assert.ok((await rows(db, workspaceId)).includes("include loose2.md model"), "a model-proposed definition projects with source model");
            assert.equal(await memberOf(db, workspaceId, "ignored.log"), false, "a model glob never passes .gitignore");
            assert.deepEqual((await definitions()).find((d) => d.alias === "ignored.log")?.detail, { effect: "include", pattern: "ignored.log", matched: 0, files: [], ignored: 1 });
            const mixed = await modelAdd("docs/*.md", "../secrets/*.pem");
            assert.equal(mixed.outcome.status, 403, "one glob past the scope refuses the whole add");
            assert.equal((await definitions()).some((d) => d.alias === "docs/*.md"), false, "nothing of a refused add is recorded");
            // The same glob from the other authority is a different definition: the 409 names the way back.
            const taken = await modelAdd("loose.md");
            assert.equal(taken.outcome.status, 409);
            assert.equal(taken.outcome.problem?.type, "https://problems.plurnk.xyz/functionality/alias-exists");
            assert.equal(taken.outcome.problem?.recovery, "Remove it, then add it again.");
            assert.deepEqual((await definitions()).find((d) => d.alias === "loose.md")?.definition?.provenance, { kind: "client-action" }, "the client's definition stands");

            // An exclusion is a `!glob` definition: it removes a tracked member, list counts what it
            // removed, and discover names the exclusion. Remove names the glob.
            const excluded = await invoke<Receipt>("add", { files: ["!big/**"] });
            assert.equal(excluded.status, 201);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "big/tokenizer.json"), false, "an exclusion removes a tracked file from membership");
            assert.ok((await rows(db, workspaceId)).includes("exclude big/** members"));
            assert.deepEqual((await definitions()).find((d) => d.alias === "!big/**")?.detail, { effect: "exclude", pattern: "big/**", matched: 1, files: ["big/tokenizer.json"], ignored: 0 });
            const gone = await discover("big/tokenizer.json");
            assert.equal(gone.provenance.kind, "excluded");
            assert.match(String(gone.summary), /excluded by `!big\/\*\*`/u);
            const removed = await invoke<Receipt>("remove", { file: "!big/**" });
            assert.deepEqual(removed, { status: 200, family: "members", alias: "!big/**", removed: true });
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "big/tokenizer.json"), true, "removing the exclusion restores the tracked member");
            const unknown = await problemOf(() => invoke("remove", { file: "!big/**" }));
            assert.equal(unknown.type, "https://problems.plurnk.xyz/functionality/alias-unknown");
            assert.equal(unknown.detail, "'!big/**' is not available to this workspace.");

            // Union across sessions, an exclusion wins: a child excludes what the parent included;
            // removal restores it.
            const child = await insertSession(db, workspaceId, model, "child", "model");
            const hidden = await invoke<Receipt>("add", { files: ["!loose.md"] }, child);
            assert.equal(hidden.status, 201);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "an exclusion from any session wins over an inclusion from another");
            await invoke("remove", { file: "!loose.md" }, child);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), true, "removing the exclusion restores the union");

            // Disable changes the workspace membership; no child keeps a copied definition.
            const disabled = await invoke<Receipt>("disable", { file: "loose.md" });
            assert.equal(disabled.alias, "loose.md");
            assert.equal(disabled.definitions, undefined, "a select verb names the one definition it concerned");
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "the shared inclusion is disabled for every session");
            assert.deepEqual((await states()).filter((s) => s.startsWith("loose.md:")), ["loose.md:workspace:disabled"]);
            await invoke("disable", { file: "loose.md" }, child);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "repeating disable leaves the shared state unchanged");
            // A service definition is disabled by its glob too, and cannot be removed here.
            await invoke("disable", { file: "docs/**" });
            assert.deepEqual((await states()).filter((s) => s.startsWith("docs/**:")), ["docs/**:service:disabled"]);
            assert.equal((await problemOf(() => invoke("remove", { file: "docs/**" }))).type, "https://problems.plurnk.xyz/functionality/alias-service-owned");
        } finally {
            unsubscribe();
            await daemon.stop();
            await db.close();
            await rm(root, { recursive: true, force: true });
        }
    });
});

test("{§tools-resource-materialization} the ceiling: none refuses every model definition, root admits inside it, the workspace narrows the service", async () => {
    const root = await gitProject();
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `members-scope-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const model = await insertSession(db, workspaceId, null, "model", "model");
    const who = { workspaceId, sessionId: model };
    const engine = (): never => { throw new Error("prepare is not exercised here"); };
    const refusedAs = async (run: () => Promise<unknown>, code: string, status: number) => {
        const error = await run().then(() => null, (cause: unknown) => cause);
        assert.ok(error instanceof OperationFailureError, `expected an OperationFailureError, got ${String(error)}`);
        assert.equal(error.result.status, status);
        assert.equal(error.result.problem?.type, `https://problems.plurnk.xyz/members/functionality/${code}`);
        return error.result.problem as { recovery?: string; scope?: string };
    };
    const admission = (glob: string, kind: "client-action" | "model-proposal") => ({ alias: glob, definition: { glob, provenance: { kind } } });
    try {
        const closed = new MembersFunctionality({ db, engine, environ: { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "none", PLURNK_MEMBERS_ENABLED: "1" } });
        const refused = await refusedAs(() => closed.admit({ files: ["notes.md"] }, who, "operation"), "model-scope", 403);
        assert.doesNotMatch(String(refused.recovery), /\bgit\b/u, "the recovery asks nothing of the repository");
        await refusedAs(() => closed.admit({ files: ["!notes.md"] }, who, "operation"), "model-scope", 403);
        assert.deepEqual(await closed.admit({ files: ["notes.md"] }, who, "action"), [admission("notes.md", "client-action")]);
        assert.deepEqual(await closed.admit({ files: [" !**/*.lock ", "!**/*.lock"] }, who), [admission("!**/*.lock", "client-action")], "a glob is trimmed, and named twice is one definition");

        const rooted = new MembersFunctionality({ db, engine, environ: { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "root", PLURNK_MEMBERS_ENABLED: "1" } });
        assert.deepEqual(await rooted.admit({ files: ["notes.md", "!drafts/**"] }, who, "operation"), [admission("notes.md", "model-proposal"), admission("!drafts/**", "model-proposal")]);
        await refusedAs(() => rooted.admit({ files: ["../secrets/*.pem"] }, who, "operation"), "model-scope", 403);
        await refusedAs(() => rooted.admit({ files: ["notes.md", "../secrets/*.pem"] }, who, "operation"), "model-scope", 403);
        // {§tools-resource-materialization} The scope judges the glob in key space, whatever its spelling.
        assert.deepEqual(await rooted.admit({ files: [join(root, "notes.md")] }, who, "operation"), [admission(join(root, "notes.md"), "model-proposal")],
            "an absolute glob inside the root is a root pattern");
        await refusedAs(() => rooted.admit({ files: [join(dirname(root), "secrets", "*.pem")] }, who, "operation"), "model-scope", 403);
        const bare = await refusedAs(() => rooted.admit({ files: ["!"] }, who, "operation"), "definition-invalid", 400);
        assert.match(String(bare.recovery), /docs\/\*\*/u);

        // A permissive service (namespace) narrowed by the workspace to root.
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ membersModelScope: "root" }) });
        const wide = new MembersFunctionality({ db, engine, environ: { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace", PLURNK_MEMBERS_ENABLED: "1" } });
        assert.deepEqual(await wide.admit({ files: ["../shared/*.md"] }, who, "action"), [admission("../shared/*.md", "client-action")]);
        assert.deepEqual(await wide.admit({ files: ["loose.md"] }, who, "operation"), [admission("loose.md", "model-proposal")]);
        const narrowed = await refusedAs(() => wide.admit({ files: ["../shared/*.md"] }, who, "operation"), "model-scope", 403);
        assert.equal(narrowed.scope, "root", "settings.membersModelScope narrows the service's namespace to root");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// {§tools-resource-materialization} {§fs-namespace} A definition's glob is matched against member keys: written absolute or from
// the root, beside it or farther out, it admits the same members, which READ reaches by either spelling; an exclusion
// spelled absolute removes what it names, and no member is stored under an absolute key.
test("{§tools-resource-materialization} {§fs-namespace} a glob spelled absolute or from the root admits the same members beyond the root, near or far, and READ reaches them", { timeout: 60_000 }, async (t) => {
    serverProposals(t, "accept");
    const base = await mkdtemp(join(tmpdir(), "plurnk-members-beyond-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "ws", "project");
    await mkdir(root, { recursive: true });
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, "README.md"), "# tracked\n");
    await git(["add", "README.md"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "chore: seed"]);
    // Beside the root and farther out: one file per spelling, and one an exclusion removes.
    const places = [{ dir: join(base, "ws", "shared"), key: "../shared" }, { dir: join(base, "far"), key: "../../far" }];
    for (const { dir } of places) {
        await mkdir(dir, { recursive: true });
        for (const name of ["relative.md", "absolute.md", "excluded.md"]) await writeFile(join(dir, name), `${dir}/${name}\n`);
    }
    await withEnv({ PLURNK_SERVICE_GIT_ALLOWED: "1", PLURNK_SERVICE_GIT_AUTO: "1", PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace", PLURNK_MEMBERS_ENABLED: "1" }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `members-beyond-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const model = await insertSession(db, workspaceId, null, "model", "model");
        await ownSession(db, workspaceId, model);
        const daemon = new Daemon({ db, provider: null });
        await daemon.start();
        try {
            const operate = (program: string) => modelOperation(daemon, db, { workspaceId, sessionId: model, statement: parseOne(program) });
            const files = places.flatMap(({ dir, key }) => [`${key}/relative.md`, join(dir, "absolute.md"), `${key}/excluded.md`, `!${join(dir, "excluded.md")}`]);
            await operate(`\`\`\`\`plurnk (members)\n${JSON.stringify({ verb: "add", files })}\n\`\`\`\``);
            const outcome = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk", after: 0, timeoutMs: 30_000 }) as Receipt;
            assert.equal(outcome.status, 201);
            await daemon.settleFunctionality(workspaceId);
            for (const { dir, key } of places) {
                assert.deepEqual(outcome.definitions?.find(({ alias }) => alias === join(dir, "absolute.md"))?.detail?.files, [`${key}/absolute.md`],
                    `${key}: the absolute glob resolves to the member's key`);
                for (const name of ["relative.md", "absolute.md"]) {
                    assert.equal(await memberOf(db, workspaceId, `${key}/${name}`), true, `${key}/${name} is a member`);
                    for (const spelling of [`${key}/${name}`, join(dir, name)]) {
                        const read = await operate(`\`\`\`\`READ (${spelling})\`\`\`\``) as { status: number; content?: string | null };
                        assert.deepEqual([read.status, read.content], [200, `${dir}/${name}\n`], `READ ${spelling} reaches it`);
                    }
                }
                assert.equal(await memberOf(db, workspaceId, `${key}/excluded.md`), false, `${key}: an exclusion spelled absolute removes the member`);
            }
            assert.deepEqual(await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "file", prefix: "/%" }), [],
                "no member is stored under an absolute key");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
});
});

describe("skills-workspace-sources", () => {
const document = (description: string): string => `---\nname: review\ndescription: ${description}\n---\nRead guide.md.\n`;

test("{§functionality-inspection} plugin skills follow source precedence and workspace management without a separate lifecycle", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-plugin-skills-"));
    const project = join(root, "project");
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    const standalone = join(hostPaths.globalSkillsDir, "review");
    const plugin = join(hostPaths.projectPluginsDir(project), "review-tools");
    const pluginSkill = join(plugin, "skills", "review");
    const override = join(root, "override", "review");
    for (const [directory, description] of [[standalone, "Global"], [pluginSkill, "Project plugin"], [override, "Workspace override"]]) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), document(description));
    }
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "review-tools",
    }));
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(root, { recursive: true, force: true }); });
    await daemon.start();
    const a = await daemon.createWorkspace({ name: "plugin-skills-a", projectRoot: project });
    const b = await daemon.createWorkspace({ name: "plugin-skills-b", projectRoot: null });
    const action = (workspaceId: number, verb: string, params = {}) => daemon.invokeModuleAction(
        `workspace.skills.${verb}`, params, { scope: "workspace", workspaceId },
    );
    const read = async (workspace: typeof a) => (await daemon.dispatchClientAction({
        workspaceId: workspace.workspaceId, actor: TEST_OWNER, statements: [readStmt(parsePath("skill://review/SKILL.md"), { marks: [1, -1] })],
    }))[0];
    assert.match(String((await read(a)).content), /Project plugin/);
    assert.match(String((await read(b)).content), /Global/);
    const listed = await action(a.workspaceId, "list") as FunctionalityListResult;
    assert.deepEqual(listed.definitions.find(({ alias }) => alias === "review")?.provenance, {
        kind: "plugin", source: join(pluginSkill, "SKILL.md"),
    });
    await action(a.workspaceId, "disable", { alias: "review" });
    assert.equal((await read(a)).status, 404);
    await action(a.workspaceId, "enable", { alias: "review" });
    assert.match(String((await read(a)).content), /Project plugin/);
    await action(a.workspaceId, "add", { alias: "review", definition: { name: "review", source: override } });
    assert.match(String((await read(a)).content), /Workspace override/);
    await action(a.workspaceId, "remove", { alias: "review" });
    assert.match(String((await read(a)).content), /Project plugin/);
    assert.equal(await readFile(join(pluginSkill, "SKILL.md"), "utf8"), document("Project plugin"));
});

test("{§skills-functionality} local additions are live, workspace-owned references; removing them preserves every source", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-references-"));
    const project = join(root, "project");
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    const sources = [join(hostPaths.globalSkillsDir, "review"), join(root, "alice", "review"), join(root, "bob", "review")];
    await mkdir(project);
    for (const [index, source] of sources.entries()) {
        await mkdir(source, { recursive: true });
        await writeFile(join(source, "SKILL.md"), document(`Source ${index}`));
        await writeFile(join(source, "guide.md"), `SOURCE_${index}\n`);
    }
    const db = await openMigrated();
    let daemon = new Daemon({ db, provider: null, hostPaths });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(root, { recursive: true, force: true }); });
    await daemon.start();
    const alice = await daemon.createWorkspace({ name: "skills-alice", projectRoot: project });
    const bob = await daemon.createWorkspace({ name: "skills-bob", projectRoot: project });
    const action = (workspaceId: number, verb: string, params = {}) => daemon.invokeModuleAction(
        `workspace.skills.${verb}`, params, { scope: "workspace", workspaceId },
    );
    const read = async (workspace: typeof alice) => (await daemon.dispatchClientAction({
        workspaceId: workspace.workspaceId, actor: TEST_OWNER, statements: [readStmt(parsePath("skill://review/guide.md"), { marks: [1, -1] })],
    }))[0];
    for (const [index, workspace] of [alice, bob].entries()) {
        const added = await action(workspace.workspaceId, "add", {
            alias: "review", definition: { name: "review", source: sources[index + 1] },
        }) as FunctionalityMutationResult;
        assert.equal(added.status, 201);
        assert.equal(added.definition?.origin, "workspace");
        assert.equal(added.definition?.provenance, undefined, "a local definition does not borrow its baseline's source");
        assert.deepEqual(added.definition?.definition, { name: "review", source: sources[index + 1] });
        assert.equal((await read(workspace)).content, `SOURCE_${index + 1}`);
    }
    await assert.rejects(() => stat(hostPaths.projectSkillsDir(project)), { code: "ENOENT" }, "add does not create a project installation");
    await assert.rejects(() => stat(hostPaths.plurnkSkillsDir), { code: "ENOENT" }, "add does not create a user installation");
    await writeFile(join(sources[1], "guide.md"), "EDITED_SOURCE\n");
    assert.equal((await read(alice)).content, "EDITED_SOURCE", "supporting resources remain live");
    assert.equal((await read(bob)).content, "SOURCE_2", "workspace references are independent");

    await daemon.stop();
    daemon = new Daemon({ db, provider: null, hostPaths });
    await daemon.start();
    assert.equal((await read(alice)).content, "EDITED_SOURCE", "restart preserves the reference, not a copied snapshot");
    await action(alice.workspaceId, "remove", { alias: "review" });
    assert.equal((await read(alice)).content, "SOURCE_0", "removal restores the inherited enabled skill");
    assert.equal((await read(bob)).content, "SOURCE_2");
    for (const [index, source] of sources.entries()) {
        assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), document(`Source ${index}`), "no external root was changed");
    }
    const listed = await action(alice.workspaceId, "list") as FunctionalityListResult;
    assert.equal(listed.definitions.find(({ alias }) => alias === "review")?.origin, "service");
    assert.deepEqual(listed.definitions.find(({ alias }) => alias === "review")?.provenance,
        { kind: "file", source: join(sources[0], "SKILL.md") });
});

test("{§skills-configuration} environment definitions replace standard roots; independent controls and workspace removal preserve inheritance", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-cascade-"));
    const project = join(root, "project");
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    const sources = [hostPaths.globalSkillsDir, hostPaths.projectSkillsDir(project), join(root, "configured"), join(root, "local")];
    for (const [index, source] of sources.entries()) {
        await mkdir(join(source, "review"), { recursive: true });
        await writeFile(join(source, "review", "SKILL.md"), document(`Layer ${index}`));
    }
    const overrides: Record<string, string> = {
        PLURNK_SKILLS_ENABLED: "0",
        PLURNK_SKILLS_review: JSON.stringify({ name: "review", source: join(sources[2], "review") }),
        PLURNK_SKILLS_review_ENABLED: "1",
        PLURNK_SKILLS_absent_ENABLED: "0",
    };
    for (const name of ["3d-tools", "分析"]) {
        const directory = join(root, name);
        await mkdir(directory);
        await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} guide\n---\nORIGINAL_${name}\n`);
        const key = `PLURNK_SKILLS_${name.replaceAll("-", "_")}`;
        overrides[key] = JSON.stringify({ name, source: directory });
        overrides[`${key}_ENABLED`] = "1";
    }
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    t.after(() => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(root, { recursive: true, force: true }); });
    await daemon.start();
    const workspace = await daemon.createWorkspace({ name: "skills-cascade", projectRoot: project });
    const action = (verb: string, params = {}) => daemon.invokeModuleAction(
        `workspace.skills.${verb}`, params, { scope: "workspace", workspaceId: workspace.workspaceId },
    );
    const list = async () => (await action("list") as FunctionalityListResult).definitions;
    const read = async (alias: string) => (await daemon.dispatchClientAction({
        workspaceId: workspace.workspaceId, actor: TEST_OWNER, statements: [readStmt(parsePath(`skill://${alias}/SKILL.md`), { marks: [1, -1] })],
    }))[0];
    const before = await list();
    assert.deepEqual(before.find(({ alias }) => alias === "review")?.definition, { name: "review", source: join(sources[2], "review") });
    assert.deepEqual(before.find(({ alias }) => alias === "review")?.provenance,
        { kind: "environment", source: "PLURNK_SKILLS_review" });
    assert.equal(before.find(({ alias }) => alias === "plurnk")?.state, "disabled", "family default applies independently to host-provided trees");
    assert.ok(!before.some(({ alias }) => alias === "absent"), "a future control does not invent a skill");
    assert.match(String((await read("review")).content), /Layer 2/u);
    for (const alias of ["3d-tools", "分析"]) {
        assert.match(String((await read(alias)).content), new RegExp(`ORIGINAL_${alias}`, "u"));
    }
    await action("add", { alias: "review", definition: { name: "review", source: join(sources[3], "review") } });
    assert.match(String((await read("review")).content), /Layer 3/u);
    await action("remove", { alias: "review" });
    assert.match(String((await read("review")).content), /Layer 2/u);
    assert.equal((await list()).find(({ alias }) => alias === "review")?.origin, "service");
    process.env.PLURNK_SKILLS_review_ENABLED = "0";
    await action("add", { alias: "review", definition: { name: "review", source: join(sources[3], "review") } });
    assert.match(String((await read("review")).content), /Layer 3/u);
    await action("remove", { alias: "review" });
    assert.equal((await list()).find(({ alias }) => alias === "review")?.state, "disabled", "remove restores inherited disabledness too");
    assert.deepEqual((await list()).find(({ alias }) => alias === "review")?.provenance,
        { kind: "environment", source: "PLURNK_SKILLS_review" }, "disabled entries remain traceable");
    assert.equal((await read("review")).status, 404);
    delete process.env.PLURNK_SKILLS_review;
    assert.deepEqual((await list()).find(({ alias }) => alias === "review")?.provenance,
        { kind: "file", source: join(sources[1], "review", "SKILL.md") }, "the next winning source replaces environment provenance");
    for (const [index, source] of sources.entries()) {
        assert.equal(await readFile(join(source, "review", "SKILL.md"), "utf8"), document(`Layer ${index}`));
    }
});
});
