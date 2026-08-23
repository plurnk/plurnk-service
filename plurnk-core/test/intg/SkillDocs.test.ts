import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import Owner from "../../src/core/Owner.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SkillDocs from "../../src/server/skillDocs.ts";
import { DEFAULT_MIMETYPES, insertWorker, openMigrated } from "./_helpers.ts";

class FixtureEngine extends Engine {
    override async referenceEntries(): Promise<Array<{ pathname: string; content: string }>> {
        return [];
    }
}

const openWorkspace = async (
    projectRoot: string | null,
): Promise<{ db: Awaited<ReturnType<typeof openMigrated>>; workspaceId: number; workerId: number }> => {
    const db = await openMigrated();
    const row = await db.envelope_insert_workspace.get<{ id: number }>({
        name: `skills-${crypto.randomUUID()}`,
        project_root: projectRoot,
        settings: "{}",
    });
    if (row === undefined) throw new Error("workspace insert returned no row");
    await Owner.commonsId(db, row.id);
    return { db, workspaceId: row.id, workerId: await insertWorker(db, row.id) };
};

const entry = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    workspaceId: number,
    workerId: number,
    pathname: string,
): Promise<{ id: number; body: string } | undefined> => {
    const row = await db.crud_find_workspace_entry.get<{ id: number }>({
        workspace_id: workspaceId,
        owner_id: workerId,
        scheme: "worker",
        authority: "",
        pathname,
    });
    if (row === undefined) return undefined;
    const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: row.id, name: "body" });
    return { id: row.id, body: channel?.content ?? "" };
};

const skill = (name: string, description: string, body: string): string => [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    body,
].join("\n");

const pathsFor = (root: string): HostPaths => new HostPaths({
    home: join(root, "home"),
    env: { XDG_CONFIG_HOME: join(root, "config") },
});

test("{§skills-materialization} standard project skills and the exact bundle become pull-docs", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-"));
    const project = join(root, "project");
    const hostPaths = pathsFor(root);
    const { db, workspaceId, workerId } = await openWorkspace(project);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await mkdir(join(project, ".agents", "skills", "grep"), { recursive: true });
        await writeFile(
            join(project, ".agents", "skills", "grep", "SKILL.md"),
            skill("grep", "Find text in files", "Use ripgrep. Always quote patterns."),
        );
        await mkdir(join(project, ".agents", "skills", "no-doc"), { recursive: true });
        await mkdir(join(project, ".agents", "skills", "summarize"), { recursive: true });
        await writeFile(join(project, ".agents", "skills", "summarize", "SKILL.md"), [
            "---",
            "name: summarize",
            "description: >",
            "  Summarize long material.",
            "  Use when a concise account is requested.",
            "---",
            "Preserve the author's claims.",
        ].join("\n"));

        await SkillDocs.materialize(engine, db, workspaceId, workerId, hostPaths);

        const index = await entry(db, workspaceId, workerId, "/_plurnk/skills/index.md");
        assert.ok(index);
        assert.match(index.body, /^## Summary\n\nAgent Skills available to this worker\.$/m);
        assert.match(index.body, /- \*\*find-skills\*\* — Helps users discover/);
        assert.match(index.body, /- \*\*grep\*\* — Find text in files/);
        assert.match(index.body, /- \*\*summarize\*\* — Summarize long material\. Use when a concise account is requested\./);

        const grep = await entry(db, workspaceId, workerId, "/_plurnk/skills/grep.md");
        assert.ok(grep);
        assert.equal(
            grep.body,
            "# grep\n\n## Summary\n\nFind text in files\n\nUse ripgrep. Always quote patterns.",
        );
        assert.notEqual(await entry(db, workspaceId, workerId, "/_plurnk/skills/find-skills.md"), undefined);
        assert.equal(await entry(db, workspaceId, workerId, "/_plurnk/skills/no-doc.md"), undefined);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§skills-materialization} reconciliation retires removed project skills but retains the bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-"));
    const project = join(root, "project");
    const hostPaths = pathsFor(root);
    const { db, workspaceId, workerId } = await openWorkspace(project);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        const folder = join(project, ".agents", "skills", "gone");
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "SKILL.md"), skill("gone", "Retired", "body"));
        await SkillDocs.materialize(engine, db, workspaceId, workerId, hostPaths);
        assert.notEqual(await entry(db, workspaceId, workerId, "/_plurnk/skills/gone.md"), undefined);

        await rm(folder, { recursive: true, force: true });
        await SkillDocs.materialize(engine, db, workspaceId, workerId, hostPaths);
        assert.equal(await entry(db, workspaceId, workerId, "/_plurnk/skills/gone.md"), undefined);
        assert.match((await entry(db, workspaceId, workerId, "/_plurnk/skills/index.md"))!.body, /\*\*find-skills\*\*/);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§skills-materialization} project then shared-global precedence is decided before lower content is read", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-precedence-"));
    const project = join(root, "project");
    const hostPaths = pathsFor(root);
    const global = join(hostPaths.globalSkillsDir, "policy");
    const local = join(project, ".agents", "skills", "policy");
    const { db, workspaceId, workerId } = await openWorkspace(project);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await mkdir(global, { recursive: true });
        await writeFile(join(global, "SKILL.md"), skill("policy", "Global rules", "Global body."));
        await SkillDocs.materialize(engine, db, workspaceId, workerId, hostPaths);
        assert.match((await entry(db, workspaceId, workerId, "/_plurnk/skills/policy.md"))!.body, /Global body/);

        await rm(join(global, "SKILL.md"));
        await mkdir(join(global, "SKILL.md"));
        await mkdir(local, { recursive: true });
        await writeFile(join(local, "SKILL.md"), skill("policy", "Project rules", "Project body."));
        await SkillDocs.materialize(engine, db, workspaceId, workerId, hostPaths);
        assert.match(
            (await entry(db, workspaceId, workerId, "/_plurnk/skills/policy.md"))!.body,
            /Project body/,
            "the project claim shadows the unreadable lower candidate before its body is opened",
        );
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§skills-materialization} shared-global skills shadow bundled names", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-global-"));
    const hostPaths = pathsFor(root);
    const global = join(hostPaths.globalSkillsDir, "find-skills");
    const { db, workspaceId, workerId } = await openWorkspace(null);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await mkdir(global, { recursive: true });
        await writeFile(join(global, "SKILL.md"), skill("find-skills", "My discovery policy", "Use my registry."));
        await SkillDocs.materialize(engine, db, workspaceId, workerId, hostPaths);
        const installed = await entry(db, workspaceId, workerId, "/_plurnk/skills/find-skills.md");
        assert.match(installed!.body, /My discovery policy/);
        assert.doesNotMatch(installed!.body, /skills\.sh leaderboard/);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§skills-materialization} malformed standard skills fail at their source", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-invalid-"));
    const project = join(root, "project");
    const hostPaths = pathsFor(root);
    const folder = join(project, ".agents", "skills", "review");
    const { db, workspaceId, workerId } = await openWorkspace(project);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "SKILL.md"), skill("other", "Mismatch", "body"));
        await assert.rejects(
            () => SkillDocs.materialize(engine, db, workspaceId, workerId, hostPaths),
            /Agent Skill name "other" must match folder "review"/,
        );
        await rm(folder, { recursive: true });
        const verbose = join(project, ".agents", "skills", "verbose");
        await mkdir(verbose, { recursive: true });
        await writeFile(join(verbose, "SKILL.md"), skill("verbose", "x".repeat(1025), "body"));
        await assert.rejects(
            () => SkillDocs.materialize(engine, db, workspaceId, workerId, hostPaths),
            /Agent Skill description exceeds 1024 characters/,
        );
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§skills-materialization} headless workspaces still publish the bundled discovery skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-headless-"));
    const { db, workspaceId, workerId } = await openWorkspace(null);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await SkillDocs.materialize(engine, db, workspaceId, workerId, pathsFor(root));
        assert.notEqual(await entry(db, workspaceId, workerId, "/_plurnk/skills/find-skills.md"), undefined);
        assert.match((await entry(db, workspaceId, workerId, "/_plurnk/skills/index.md"))!.body, /\*\*find-skills\*\*/);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
