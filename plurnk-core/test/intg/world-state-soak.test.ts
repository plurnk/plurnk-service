// {§fs-world-state} the soak: repeated turn boundaries over one rooted workspace with real
// membership, the invariant harness at every boundary, and the delta law: repeated read-only
// turns grow the entries table by zero.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import GitMembership from "../../src/core/git-membership.ts";
import WorldState from "./world-state.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, rootWorkspace } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { viableWindow } from "./_provider.ts";

const execFileP = promisify(execFile);

test("soak: N turn boundaries with per-turn membership re-resolution — zero growth, zero violations, every boundary", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-soak-"));
    const db = await openMigrated();
    try {
        // A real git workspace: three tracked members.
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        for (const f of ["a.md", "b.md", "sub-c.md"]) await writeFile(join(root, f), `# ${f}\n`);
        await execFileP("git", ["add", "-A"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `soak-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId);
        const ctx: PlurnkSchemeContext = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const TURNS = 6;
        const responses = Array.from({ length: TURNS }, (_, i) => ({
            assistant: {
                content: `${i % 2 === 0 ? "````READ (a.md)````" : "````FIND (**)````"}
\`\`\`\`NOTE
continue
\`\`\`\``,
                reasoning: null,
            },
        }));
        const provider = new Mock({ contextWindow: viableWindow(), responses });

        const loopId = await insertLoop(db, workerId, 1, "soak");
        let baseline: number | null = null;
        for (let turn = 1; turn <= TURNS; turn++) {
            // the per-turn membership pass
            await GitMembership.indexGitMembership(ctx);
            const r = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
            assert.ok(r.status < 500, `turn ${turn} completed (${r.status})`);
            const count = await WorldState.entryCount(db);
            if (baseline === null) baseline = count;
            else assert.equal(count, baseline, `turn ${turn}: read-only turns grow the entries table by ZERO`);
            const violations = await WorldState.check(db);
            assert.deepEqual(violations, [], `turn ${turn}: the world stays lawful at every boundary`);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
