import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import Owner from "../../src/core/Owner.ts";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

test("{§skills-materialization} the turn-completion hook refreshes skills mutated between loops", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-loop-"));
    const provider = new Mock({
        contextWindow: 16384,
        responses: [
            { assistant: { content: "# PLAN0\ncurate:\n\n## SEND0 [200]\nobserved.", reasoning: null } },
            { assistant: { content: "# PLAN0\ncurate:\n\n## SEND0 [200]\nobserved.", reasoning: null } },
        ],
    });
    try {
        await mkdir(join(root, "skills", "grep"), { recursive: true });
        await writeFile(join(root, "skills", "grep", "SKILL.md"), "---\nname: grep\ndescription: Find text\n---\nUse ripgrep.");
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const created = (await rpcCall(ws, 1, "workspace.create", {
                    name: `skills-loop-${crypto.randomUUID()}`,
                    projectRoot: root,
                })).result as { id: number };
                const ownerId = await Owner.kernelId(db, created.id);
                const entry = async (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: created.id,
                    owner_id: ownerId,
                    scheme: "worker",
                    pathname,
                });

                assert.notEqual(await entry("/skills/grep.md"), undefined, "boot materialization publishes the installed skill");
                assert.equal(await entry("/skills/review.md"), undefined);

                assert.equal((await runLoopToTerminal(ws, 2, { prompt: "first", flags: { auto: true } })).finalStatus, 200);

                // Between loops the model-side EXEC[skills] would have landed:
                await mkdir(join(root, "skills", "review"), { recursive: true });
                await writeFile(join(root, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Check diffs\n---\nReview diffs before committing.");

                assert.equal((await runLoopToTerminal(ws, 2, { prompt: "second", flags: { auto: true } })).finalStatus, 200);

                assert.notEqual(await entry("/skills/review.md"), undefined, "the turn-completion hook republished the added skill");
                assert.match(
                    ((await db.crud_find_workspace_entry.get<{ id: number }>({
                        workspace_id: created.id,
                        owner_id: ownerId,
                        scheme: "worker",
                        pathname: "/skills/index.md",
                    })) === undefined ? "" : await db.test_get_channel.get<{ content: string }>({
                        entry_id: (await entry("/skills/index.md"))!.id,
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
