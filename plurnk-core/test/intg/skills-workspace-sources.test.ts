import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePath } from "@plurnk/plurnk-parser";
import type { FunctionalityListResult, FunctionalityMutationResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import { openMigrated } from "./_db.ts";
import { readStmt } from "./_dsl.ts";

const document = (description: string): string => `---\nname: review\ndescription: ${description}\n---\nRead guide.md.\n`;

test("{§agent-plugins-hosting} plugin skills follow source precedence and workspace management without a separate lifecycle", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-plugin-skills-"));
    const project = join(root, "project");
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    const standalone = join(hostPaths.globalSkillsDir, "review");
    const plugin = join(hostPaths.projectPluginsDir(project), "review-tools");
    const pluginSkill = join(plugin, "skills", "review");
    const override = join(root, "override", "review");
    for (const [directory, description] of [[standalone, "Global"], [pluginSkill, "Project plugin"], [override, "Workspace override"]]) {
        await mkdir(directory!, { recursive: true });
        await writeFile(join(directory!, "SKILL.md"), document(description!));
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
    const read = (workspace: typeof a) => daemon.dispatchAsClient({
        ...workspace, statement: readStmt(parsePath("skill://review/SKILL.md"), { marks: [1, -1] }),
    });
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
    const read = (workspace: typeof alice) => daemon.dispatchAsClient({
        ...workspace, statement: readStmt(parsePath("skill://review/guide.md"), { marks: [1, -1] }),
    });
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
    const read = (alias: string) => daemon.dispatchAsClient({
        ...workspace, statement: readStmt(parsePath(`skill://${alias}/SKILL.md`), { marks: [1, -1] }),
    });
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
