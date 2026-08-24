// {§skills-functionality} — standard Agent Skills through the shared Worker
// Functionality lifecycle: the filesystem is installation truth, the Worker
// owns enablement, discovery is inert, and the standard CLI is the installer.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProblemDetails } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import { StandardSkillsToolchain } from "../../src/server/SkillsFunctionality.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertWorkspace, insertWorker, openMigrated } from "./_helpers.ts";
import type { Db } from "../../src/core/Db.ts";

const FIXTURE_CLI = resolve(import.meta.dirname, "_skills-cli.mjs");

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

const registry = async (): Promise<{ url: string; queries: string[]; close(): Promise<void> }> => {
    const queries: string[] = [];
    const server = createServer((request, response) => {
        const url = new URL(request.url!, "http://registry.test");
        queries.push(url.searchParams.get("q") ?? "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
            skills: [
                { name: "alpha", id: "acme/kit/alpha", source: "acme/kit", installs: 1200 },
                { name: "Not Valid", id: "x/y/z", source: "x/y", installs: 1 },
            ],
        }));
    });
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${address.port}`,
        queries,
        close: () => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())),
    };
};

test("{§skills-functionality} {§skills-remove} installed roots are service definitions, add installs, remove uninstalls and reveals, discovery stays inert", async () => {
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

    const hub = await registry();
    const toolchain = new StandardSkillsToolchain({
        PLURNK_SERVICE_SKILLS_CLI: `${process.execPath} ${FIXTURE_CLI}`,
        PLURNK_SERVICE_SKILLS_REGISTRY_URL: `${hub.url}/`,
    });
    const db: Db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `skills-${crypto.randomUUID()}`);
    await db.test_set_workspace_root.run({ id: workspaceId, project_root: project });
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    let daemon = new Daemon({ db, provider: null, skills: { hostPaths, toolchain } });
    await daemon.start();
    const context = { scope: "worker" as const, workspaceId, workerId: model };
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`worker.skills.${verb}`, params, context) as Promise<T>;
    type Listed = { alias: string; origin: string; state: string; definition: { scope: string; source?: string }; detail?: { scope: string; description: string }; problem?: ProblemDetails };
    const listed = async (): Promise<Listed[]> => (await invoke<{ definitions: Listed[] }>("list", {})).definitions;
    const states = async (): Promise<string[]> => (await listed()).map(({ alias, origin, state, definition }) => `${alias}:${origin}:${state}:${definition.scope}`);
    const document = async (pathname: string): Promise<string | undefined> => {
        const rows = await db.test_entries_by_coordinate_owners.all<{ owner_id: number; content: string }>({ scheme: "worker", authority: "", pathname });
        return rows.find(({ owner_id }) => owner_id === model)?.content;
    };
    try {
        // The installed union is the service baseline: project shadows global;
        // an invalid skill is unavailable on its own, never failing the family.
        assert.deepEqual(await states(), [
            "bad:service:unavailable:global",
            "grep:service:active:project",
            "review:service:active:global",
        ]);
        const bad = (await listed()).find(({ alias }) => alias === "bad")!;
        assert.equal(bad.problem?.type, "https://problems.plurnk.xyz/skills/functionality/skill-invalid");
        assert.match(bad.problem!.detail, /requires YAML frontmatter/);
        assert.match(await document("/_plurnk/skills/index.md") ?? "", /\*\*grep\*\* — Find text in the project/);
        assert.match(await document("/_plurnk/skills/index.md") ?? "", /\*\*review\*\*/);
        assert.doesNotMatch(await document("/_plurnk/skills/index.md") ?? "", /bad/);
        assert.match(await document("/_plurnk/skills/grep.md") ?? "", /## Summary\n\nFind text in the project\n\nUse grep\./);
        assert.equal(await document("/_plurnk/skills/bad.md"), undefined, "an unavailable skill has no model-facing document");

        // Disable withdraws the document and the index row while the definition stays listed.
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "review" })).definition.state, "disabled");
        assert.equal(await document("/_plurnk/skills/review.md"), undefined);
        assert.doesNotMatch(await document("/_plurnk/skills/index.md") ?? "", /review/);
        assert.ok((await states()).includes("review:service:disabled:global"));

        // Discovery is inert: a source lists its skills; the registry answers a query.
        const bySource = await invoke<{ candidates: Array<{ alias: string; summary?: string; definition: object; provenance: { kind: string; source: string } }> }>("discover", { source });
        assert.deepEqual(bySource.candidates.map(({ alias, summary, definition, provenance }) => ({ alias, summary, definition, provenance })), [
            { alias: "alpha", summary: "Alpha from the source", definition: { name: "alpha", scope: "project", source }, provenance: { kind: "source", source } },
            { alias: "review", summary: "Review, project edition", definition: { name: "review", scope: "project", source }, provenance: { kind: "source", source } },
        ]);
        const byQuery = await invoke<{ candidates: Array<{ alias: string; definition: { source: string }; provenance: { kind: string; reference?: string } }> }>("discover", { query: "alpha" });
        assert.deepEqual(hub.queries, ["alpha"]);
        assert.deepEqual(byQuery.candidates.map(({ alias, definition, provenance }) => ({ alias, source: definition.source, kind: provenance.kind, reference: provenance.reference })), [
            { alias: "alpha", source: "acme/kit", kind: "registry", reference: "https://skills.sh/acme/kit/alpha" },
        ], "registry hits with invalid standard names are dropped");
        assert.equal(await exists(join(projectRoot, "alpha")), false, "discovery installed nothing");
        assert.equal((await rejectedProblem(() => invoke("discover", { configuration: { X: "y" } }))).status, 400);
        assert.equal((await rejectedProblem(() => invoke("discover", { source: join(base, "nowhere") }))).type, "https://problems.plurnk.xyz/skills/functionality/discover-failed");

        // Admission is exact.
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "beta", definition: { name: "alpha", scope: "project", source } }))).type, "https://problems.plurnk.xyz/skills/functionality/alias-mismatch");
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "alpha", definition: { name: "alpha", scope: "project" } }))).type, "https://problems.plurnk.xyz/skills/functionality/source-required");
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "alpha", definition: { name: "alpha", scope: "nowhere", source } }))).type, "https://problems.plurnk.xyz/functionality/arguments-invalid", "the coordinator validates the definition schema before admission");
        // An invalid package rejects the client mutation and persists nothing.
        const failed = await rejectedProblem(() => invoke("add", { alias: "ghost", definition: { name: "ghost", scope: "project", source } }));
        assert.equal(failed.type, "https://problems.plurnk.xyz/skills/functionality/install-failed");
        assert.ok(!(await states()).some((state) => state.startsWith("ghost:")), "a failed install leaves no definition");

        // add installs through the standard CLI into the chosen scope and hotloads the document.
        const added = await invoke<{ status: number; definition: { origin: string; state: string; definition: { source: string }; detail: { scope: string; path: string } } }>("add", { alias: "alpha", definition: { name: "alpha", scope: "project", source } });
        assert.equal(added.status, 201);
        assert.equal(added.definition.state, "active");
        assert.equal(added.definition.detail.scope, "project");
        assert.equal(added.definition.detail.path, join(projectRoot, "alpha"));
        assert.equal(await exists(join(projectRoot, "alpha", "SKILL.md")), true);
        assert.match(await document("/_plurnk/skills/alpha.md") ?? "", /Alpha from the source/);
        assert.match(await document("/_plurnk/skills/index.md") ?? "", /\*\*alpha\*\*/);
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "alpha", definition: { name: "alpha", scope: "project", source } }))).type, "https://problems.plurnk.xyz/functionality/alias-exists");

        // A Worker definition shadows a service skill; removing it uninstalls its
        // scope and reveals the lower-precedence root, disabled.
        const shadow = await invoke<{ definition: { origin: string; definition: { scope: string }; detail: { description: string } } }>("add", { alias: "review", definition: { name: "review", scope: "project", source } });
        assert.equal(shadow.definition.origin, "worker");
        assert.equal(shadow.definition.detail.description, "Review, project edition");
        assert.equal(await exists(join(projectRoot, "review", "SKILL.md")), true);
        assert.match(await document("/_plurnk/skills/review.md") ?? "", /project edition/);
        const removed = await invoke<{ removed: boolean }>("remove", { alias: "review" });
        assert.equal(removed.removed, true);
        assert.equal(await exists(join(projectRoot, "review")), false, "remove uninstalled the Worker's project copy");
        assert.equal(await exists(join(hostPaths.globalSkillsDir, "review", "SKILL.md")), true, "the global copy was never touched");
        assert.ok((await states()).includes("review:service:disabled:global"), "the global skill is revealed, disabled");
        assert.equal(await document("/_plurnk/skills/review.md"), undefined);
        assert.equal((await invoke<{ definition: { state: string; detail: { description: string } } }>("enable", { alias: "review" })).definition.detail.description, "Review a change");
        assert.equal((await rejectedProblem(() => invoke("remove", { alias: "grep" }))).type, "https://problems.plurnk.xyz/functionality/alias-service-owned");

        // Restart: the Worker's own definition survives and is located, not reinstalled.
        await daemon.stop();
        daemon = new Daemon({ db, provider: null, skills: { hostPaths, toolchain } });
        await daemon.start();
        assert.deepEqual(await states(), [
            "alpha:worker:active:project",
            "bad:service:unavailable:global",
            "grep:service:active:project",
            "review:service:active:global",
        ]);
        const lockSourced = (await listed()).find(({ alias }) => alias === "alpha")!;
        assert.equal(lockSourced.definition.source, source);

        // Removing the Worker's installation with no lower root forgets it completely.
        await invoke("remove", { alias: "alpha" });
        assert.equal(await exists(join(projectRoot, "alpha")), false);
        assert.ok(!(await states()).some((state) => state.startsWith("alpha:")));
        assert.equal(await document("/_plurnk/skills/alpha.md"), undefined);
    } finally {
        await daemon.stop();
        await db.close();
        await hub.close();
        await rm(base, { recursive: true, force: true });
    }
});

test("{§skills-functionality} a headless workspace refuses project-scope additions and publishes its index", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-skills-headless-"));
    const home = join(base, "home");
    await mkdir(home, { recursive: true });
    const hostPaths = new HostPaths({ home, env: {} });
    const db: Db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `skills-headless-${crypto.randomUUID()}`);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const daemon = new Daemon({ db, provider: null, skills: { hostPaths } });
    await daemon.start();
    const context = { scope: "worker" as const, workspaceId, workerId: model };
    try {
        const list = await daemon.invokeModuleAction("worker.skills.list", {}, context) as { definitions: unknown[] };
        assert.deepEqual(list.definitions, []);
        const rows = await db.test_entries_by_coordinate_owners.all<{ owner_id: number; content: string }>({ scheme: "worker", authority: "", pathname: "/_plurnk/skills/index.md" });
        assert.match(rows.find(({ owner_id }) => owner_id === model)?.content ?? "", /# Skills\n\n## Summary\n\nAgent Skills enabled for this worker\.$/);
        const refused = await rejectedProblem(() => daemon.invokeModuleAction("worker.skills.add", { alias: "alpha", definition: { name: "alpha", scope: "project", source: "acme/kit" } }, context));
        assert.equal(refused.type, "https://problems.plurnk.xyz/skills/functionality/project-root-required");
    } finally {
        await daemon.stop();
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});
