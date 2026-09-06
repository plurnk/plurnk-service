import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

class PacketCapturingMock extends Mock {
    readonly requests: string[] = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.requests.push(args[0].messages.map(({ content }) => content).join("\n\n"));
        return super.generate(...args);
    }
}

test("{§skills-hotload} retargeting an installed symlink refreshes its source base even with identical frontmatter", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-retarget-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const version of ["first", "second"]) {
        const directory = join(root, "versions", version);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), "---\nname: sample\ndescription: Source location fixture\n---\nRead guide.md.\n");
        await writeFile(join(directory, "guide.md"), `${version.toUpperCase()}_SOURCE_SENTINEL\n`);
    }
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    const installed = join(root, ".agents", "skills", "sample");
    await symlink(join(root, "versions", "first"), installed);
    const responses = [
        { assistant: { content: "## PLAN0\n[]\n### READ0 (skill://sample/guide.md) <1,-1>\n### SEND0 (NEXT)\nInspect the source.", reasoning: null } },
        { assistant: { content: "## PLAN0\n[]\n### SEND0 (TERM)\nDone.", reasoning: null } },
    ];
    const provider = new PacketCapturingMock({ contextWindow: 32768, responses: [...responses, ...responses] });
    await withDaemon(provider, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { name: `skills-retarget-${crypto.randomUUID()}`, projectRoot: root });
        assert.equal((await runLoopToTerminal(ws, 2, { prompt: "Read the skill guide.", policy: { proposals: "accept" } })).finalStatus, 200);
        assert.match(provider.requests[1]!, /FIRST_SOURCE_SENTINEL/);
        await rm(installed);
        await symlink(join(root, "versions", "second"), installed);
        assert.equal((await runLoopToTerminal(ws, 3, { prompt: "Read the skill guide again.", policy: { proposals: "accept" } })).finalStatus, 200);
        assert.match(provider.requests[3]!, /SECOND_SOURCE_SENTINEL/);
    });
});

test("{§skills-hotload} turn admission refreshes skills mutated between loops", async (t) => {
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previous;
    });
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-loop-"));
    const provider = new PacketCapturingMock({
        contextWindow: 16384,
        responses: [
            { assistant: { content: "## PLAN0\ncurate:\n\n### SEND0 (TERM)\nobserved.", reasoning: null } },
            { assistant: { content: "## PLAN0\nInspect the newly installed skill.\n\n### READ0 (skill://review/SKILL.md) <1,-1>\n\n### SEND0 (NEXT)\nRead the skill.", reasoning: null } },
            { assistant: { content: "## PLAN0\nThe skill is available.\n\n### SEND0 (TERM)\nobserved.", reasoning: null } },
        ],
    });
    try {
        await mkdir(join(root, ".agents", "skills", "grep"), { recursive: true });
        await writeFile(join(root, ".agents", "skills", "grep", "SKILL.md"), "---\nname: grep\ndescription: Find text\n---\nUse ripgrep.");
        await withDaemon(provider, async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const created = (await rpcCall(ws, 1, "workspace.create", {
                    name: `skills-loop-${crypto.randomUUID()}`,
                    projectRoot: root,
                })).result as { id: number };
                const ownerId = await daemon.ensureModelWorker(created.id);
                const entry = async (name: string) => db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: created.id,
                    owner_id: ownerId,
                    scheme: "skill",
                    authority: name,
                    pathname: "/SKILL.md",
                });

                assert.equal(await entry("grep"), undefined, "passive workspace creation does not publish capability docs");
                assert.equal(await entry("review"), undefined);

                assert.equal((await runLoopToTerminal(ws, 2, { prompt: "first", policy: { proposals: "accept" } })).finalStatus, 200);
                assert.notEqual(await entry("grep"), undefined, "first capability demand publishes the installed skill");

                // Between loops an ordinary Agent Skills installer has landed a project skill.
                await mkdir(join(root, ".agents", "skills", "review"), { recursive: true });
                await writeFile(join(root, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Check diffs\n---\nReview diffs before committing.");

                assert.equal((await runLoopToTerminal(ws, 2, { prompt: "second", policy: { proposals: "accept" } })).finalStatus, 200);
                assert.match(provider.requests[2] ?? "", /Review diffs before committing\./);

                assert.notEqual(await entry("review"), undefined, "turn admission republished the added skill");
                assert.match(provider.requests[2] ?? "", /skill:\/\/review\/SKILL\.md/);
            } finally {
                ws.close();
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
