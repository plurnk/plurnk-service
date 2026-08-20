import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import Owner from "../../src/core/Owner.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SkillDocs from "../../src/server/skillDocs.ts";
import { DEFAULT_MIMETYPES, openMigrated } from "./_helpers.ts";

class FixtureEngine extends Engine {
    override async referenceEntries(): Promise<Array<{ pathname: string; content: string }>> {
        return [];
    }
}

const openWorkspace = async (
    projectRoot: string | null,
): Promise<{ db: Awaited<ReturnType<typeof openMigrated>>; workspaceId: number; ownerId: number }> => {
    const db = await openMigrated();
    const row = await db.envelope_insert_workspace.get<{ id: number }>({
        name: `skills-${crypto.randomUUID()}`,
        project_root: projectRoot,
        settings: "{}",
    });
    if (row === undefined) throw new Error("workspace insert returned no row");
    await Owner.commonsId(db, row.id);
    return { db, workspaceId: row.id, ownerId: await Owner.kernelId(db, row.id) };
};

const entry = async (
    db: Awaited<ReturnType<typeof openMigrated>>,
    workspaceId: number,
    ownerId: number,
    pathname: string,
): Promise<{ id: number; body: string } | undefined> => {
    const row = await db.crud_find_workspace_entry.get<{ id: number }>({
        workspace_id: workspaceId,
        owner_id: ownerId,
        scheme: "worker",
        pathname,
    });
    if (row === undefined) return undefined;
    const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: row.id, name: "body" });
    return { id: row.id, body: channel?.content ?? "" };
};

test("{§skills-materialization} project skill folders become index plus one kernel entry each", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-"));
    const { db, workspaceId, ownerId } = await openWorkspace(root);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await mkdir(join(root, "skills", "grep"), { recursive: true });
        await writeFile(join(root, "skills", "grep", "SKILL.md"), [
            "---",
            "name: grep",
            "description: Find text in files",
            "---",
            "Use ripgrep. Always quote patterns.",
        ].join("\n"));
        await mkdir(join(root, "skills", "review"), { recursive: true });
        await writeFile(join(root, "skills", "review", "SKILL.md"), "# review\n\nCheck diffs before committing.");
        await mkdir(join(root, "skills", "no-doc"), { recursive: true });

        await SkillDocs.materialize(engine, db, workspaceId);

        const index = await entry(db, workspaceId, ownerId, "/skills/index.md");
        assert.ok(index);
        assert.match(index.body, /^## Summary\n\nAgent Skills available to this workspace\.$/m);
        assert.match(index.body, /- \*\*grep\*\* — Find text in files/);
        assert.match(index.body, /- \*\*review\*\*/);

        const grep = await entry(db, workspaceId, ownerId, "/skills/grep.md");
        assert.ok(grep);
        assert.match(grep.body, /^# grep\n\n## Summary\n\nFind text in files\n\nUse ripgrep\. Always quote patterns\.$/);
        assert.doesNotMatch(grep.body, /^---/);

        const review = await entry(db, workspaceId, ownerId, "/skills/review.md");
        assert.ok(review);
        assert.match(review.body, /^# review\n\nCheck diffs before committing\.$/);

        assert.equal(
            await entry(db, workspaceId, ownerId, "/skills/no-doc.md"),
            undefined,
            "a folder without SKILL.md publishes nothing",
        );
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§skills-materialization} reconciliation retires removed skills and keeps the empty index honest", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-"));
    const { db, workspaceId, ownerId } = await openWorkspace(root);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await mkdir(join(root, "skills", "gone"), { recursive: true });
        await writeFile(join(root, "skills", "gone", "SKILL.md"), "---\nname: gone\ndescription: Retired\n---\nbody");
        await SkillDocs.materialize(engine, db, workspaceId);
        assert.notEqual(await entry(db, workspaceId, ownerId, "/skills/gone.md"), undefined);

        await rm(join(root, "skills", "gone"), { recursive: true, force: true });
        await SkillDocs.materialize(engine, db, workspaceId);
        assert.equal(await entry(db, workspaceId, ownerId, "/skills/gone.md"), undefined);
        const index = await entry(db, workspaceId, ownerId, "/skills/index.md");
        assert.match(index!.body, /None installed\./);
        assert.match(index!.body, /skills\//);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});


test("{§skills-materialization} PLURNK_SKILLS_<ALIAS> declares operator skills; the project wins a collision", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-env-"));
    const operatorDir = await mkdtemp(join(tmpdir(), "plurnk-skills-operator-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => rm(operatorDir, { recursive: true, force: true }));
    await mkdir(join(operatorDir, "policy"), { recursive: true });
    await writeFile(join(operatorDir, "policy", "SKILL.md"), "---\nname: policy\ndescription: Operator rules\n---\nAlways quote patterns.");
    const prev = process.env.PLURNK_SKILLS_POLICY;
    process.env.PLURNK_SKILLS_POLICY = join(operatorDir, "policy");
    const { db, workspaceId, ownerId } = await openWorkspace(root);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await SkillDocs.materialize(engine, db, workspaceId);
        const policy = await entry(db, workspaceId, ownerId, "/skills/policy.md");
        assert.ok(policy, "the operator skill materializes for every workspace");
        assert.match(policy!.body, /Always quote patterns/);

        // A project folder with the same alias shadows the operator path BEFORE it is read.
        await mkdir(join(root, "skills", "policy"), { recursive: true });
        await writeFile(join(root, "skills", "policy", "SKILL.md"), "---\nname: policy\ndescription: Project rules\n---\nProject body.");
        await SkillDocs.materialize(engine, db, workspaceId);
        const shadowed = await entry(db, workspaceId, ownerId, "/skills/policy.md");
        assert.match(shadowed!.body, /Project body/, "the project alias wins the collision");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SKILLS_POLICY; else process.env.PLURNK_SKILLS_POLICY = prev;
        await db.close();
    }
});

test("{§skills-materialization} an unshadowed unreadable operator skill fails materialization with its cause", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-env-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const prev = process.env.PLURNK_SKILLS_BROKEN;
    process.env.PLURNK_SKILLS_BROKEN = join(root, "absent");
    const { db, workspaceId } = await openWorkspace(root);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await assert.rejects(
            () => SkillDocs.materialize(engine, db, workspaceId),
            /configured operator skill 'broken' could not be read/,
        );
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SKILLS_BROKEN; else process.env.PLURNK_SKILLS_BROKEN = prev;
        await db.close();
    }
});
test("{§skills-materialization} a workspace without a project root still publishes the empty index", async () => {
    const { db, workspaceId, ownerId } = await openWorkspace(null);
    const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    try {
        await SkillDocs.materialize(engine, db, workspaceId);
        const index = await entry(db, workspaceId, ownerId, "/skills/index.md");
        assert.ok(index);
        assert.match(index.body, /None installed\./);
        assert.match(index.body, /a workspace project root/);
    } finally {
        await db.close();
    }
});
