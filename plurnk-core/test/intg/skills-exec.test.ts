import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("{§skills-hotload} turn admission refreshes skills mutated between loops", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-loop-"));
    const provider = new PacketCapturingMock({
        contextWindow: 16384,
        responses: [
            { assistant: { content: "# PLAN0\ncurate:\n\n## SEND0 [200]\nobserved.", reasoning: null } },
            { assistant: { content: "# PLAN0\nInspect the newly installed skill.\n\n## READ0 (worker://~/_plurnk/skills/review.md) <1,-1>\n\n## SEND0 [102]\nRead the skill.", reasoning: null } },
            { assistant: { content: "# PLAN0\nThe skill is available.\n\n## SEND0 [200]\nobserved.", reasoning: null } },
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
                const entry = async (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: created.id,
                    owner_id: ownerId,
                    scheme: "worker",
                    authority: "",
                    pathname,
                });

                assert.equal(await entry("/_plurnk/skills/grep.md"), undefined, "passive workspace creation does not publish capability docs");
                assert.equal(await entry("/_plurnk/skills/review.md"), undefined);

                assert.equal((await runLoopToTerminal(ws, 2, { prompt: "first", flags: { auto: true } })).finalStatus, 200);
                assert.notEqual(await entry("/_plurnk/skills/grep.md"), undefined, "first capability demand publishes the installed skill");

                // Between loops an ordinary Agent Skills installer has landed a project skill.
                await mkdir(join(root, ".agents", "skills", "review"), { recursive: true });
                await writeFile(join(root, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Check diffs\n---\nReview diffs before committing.");

                assert.equal((await runLoopToTerminal(ws, 2, { prompt: "second", flags: { auto: true } })).finalStatus, 200);
                assert.match(provider.requests[2] ?? "", /Review diffs before committing\./);

                assert.notEqual(await entry("/_plurnk/skills/review.md"), undefined, "turn admission republished the added skill");
                assert.match(
                    ((await db.crud_find_workspace_entry.get<{ id: number }>({
                        workspace_id: created.id,
                        owner_id: ownerId,
                        scheme: "worker",
                        authority: "",
                        pathname: "/_plurnk/skills/index.md",
                    })) === undefined ? "" : await db.test_get_channel.get<{ content: string }>({
                        entry_id: (await entry("/_plurnk/skills/index.md"))!.id,
                        name: "body",
                    }).then((row) => row?.content ?? "")),
                    /- \*\*review\*\* — Check diffs/,
                );
            } finally {
                ws.close();
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
