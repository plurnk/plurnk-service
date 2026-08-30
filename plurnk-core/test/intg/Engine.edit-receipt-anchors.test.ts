// {§edit-receipt-anchored-context} — an applied EDIT's row shows the landed neighbourhood with
// anchors, and those anchors resolve in the next batch without a READ in between.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const execFileP = promisify(execFile);
const SOURCE = "var x int\n\nfunc requireFn(a int) int {\n\treturn a\n}\n\nfunc other() {}\n";

test("{§edit-receipt-anchored-context} the EDIT row renders the landed lines with anchors that the next EDIT can cite without a READ", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-recanchor-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "f.go"), SOURCE);
        await execFileP("git", ["add", "f.go"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        const pending: { anchor: string | null } = { anchor: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## EDIT0 (file:///f.go) <1>\nvar x int64\n\n## SEND0 [102]\nfirst", 50),
            makeMockResponse("## SEND0 [200]\ndone", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`## EDIT0 (file:///f.go) <${pending.anchor}>\nfunc requireFn(a int) int { // anchored\n\n## SEND0 [102]\nsecond`, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("## SEND0 [200]\ndone", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "recanchor", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(first.result.status, 200);
                const editRow = (await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: first.modelWorkerId! }))
                    .find(({ op, status_rx }) => op === "EDIT" && status_rx === 200);
                const context = JSON.parse(editRow!.rx).receipt.effect.context as string;
                const lines = context.split("\n");
                assert.ok(lines.length >= 3, `bounded context around the landed line; got ${JSON.stringify(context)}`);
                for (const line of lines) assert.match(line, /^@[0-9A-Za-z]{5} +[1-9]\d*:/, `every context line is anchored: ${JSON.stringify(line)}`);
                // The packet the model saw carries the same anchored body.
                const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: first.turnIds![2]! }))!.packet);
                const log = (packet.sections as Array<{ name: string; content: string }>).find((s) => s.name === "log")?.content ?? JSON.stringify(packet);
                assert.match(log, /@[0-9A-Za-z]{5} +3:func requireFn\(a int\) int \{/, "the model sees line 3 with its anchor on the EDIT row");
                const line3 = lines.find((line) => / 3:func requireFn/.test(line))!;
                pending.anchor = line3.slice(0, 6);
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit again", policy: { proposals: "accept" } });
                assert.equal(second.result.status, 200);
                // The worker persists across loops: the first loop's one EDIT row precedes this loop's.
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: second.modelWorkerId! });
                const edits = rows.filter(({ op }) => op === "EDIT").slice(1);
                assert.deepEqual(edits.map(({ status_rx }) => status_rx), [200], JSON.stringify(edits.map(({ rx }) => JSON.parse(rx).problem ?? null)));
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int64\n\nfunc requireFn(a int) int { // anchored\n\treturn a\n}\n\nfunc other() {}\n", "the anchor cited from the EDIT receipt resolved to line 3 with no READ in between");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
