import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { readStmt, urlPath } from "./_dsl.ts";
import { logEntries, packetSection } from "./_helpers.ts";
import { connect, makeRawMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

for (const admission of ["accept", "reject", "deny"] as const) {
    test(`{§executor-js-spelling}: the daemon routes js through node with ${admission} admission`, async (t) => {
        const directory = await mkdtemp(join(tmpdir(), "plurnk-js-spelling-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const witness = join(directory, "executed.txt");
        const source = [
            "````js",
            'const fs = await import("node:fs/promises");',
            `await fs.writeFile(${JSON.stringify(witness)}, "executed");`,
            'console.log("js-runtime-witness");',
            "````",
            "",
            "````WAIT",
            "Observe the result.",
            "````",
        ].join("\n");
        const mock = new Mock({ contextWindow: 100_000, responses: [
            makeRawMockResponse(source, 10),
            makeRawMockResponse("````SEND\nResult observed.\n````\n\n````DONE\n````", 10),
        ] });
        await withDaemon(mock, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                await rpcCall(client, 1, "workspace.create", { name: `js-spelling-${admission}` });
                const [workspace] = await daemon.listWorkspaces();
                const workerId = await daemon.ensureModelWorker(workspace.id);
                const reference = (runtime: string) => daemon.look({ workspaceId: workspace.id, workerId,
                    statement: readStmt(urlPath("worker", `/_plurnk/plurnk/${runtime}.md`)) });
                assert.equal((await reference("node")).status, 200, "Node remains discoverable");
                assert.equal((await reference("js")).status, 404, "the accepted spelling adds no reference document");
                if (admission === "deny") {
                    await daemon.setWorkspaceCapabilities({ workspaceId: workspace.id, policy: { deny: [{ runtime: "node" }] } });
                }
                const { finalStatus, turnIds } = await runLoopToTerminal(client, 2, {
                    prompt: "Run the JavaScript and observe the result.",
                    policy: { proposals: admission === "reject" ? "reject" : "accept" },
                });
                assert.equal(finalStatus, 200);
                assert.equal(turnIds?.length, 3);
                const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
                assert.equal(sources.find((row) => row.turn_id === turnIds![1] && row.kind === "ops")?.content, source,
                    "forensic source retains the authored js spelling");
                const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: turnIds![1]! });
                const invocation = rows.find((row) => row.op === "node");
                assert.ok(invocation, "the authored js fence becomes a canonical node receipt");
                assert.equal(rows.some((row) => row.op === "js"), false);
                const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turnIds![2]! });
                const packet = JSON.parse(packetRow!.packet);
                if (admission === "accept") {
                    assert.equal(await readFile(witness, "utf8"), "executed");
                    const execution = logEntries(packet).find((entry) => String(entry.stream ?? "").startsWith("node:///"));
                    assert.ok(execution,
                        "execution publishes through Node's existing output scheme");
                    const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({
                        pathname: new URL(String(execution.stream)).pathname, scheme: "node", name: "stdout",
                    });
                    assert.equal(channel?.content, "js-runtime-witness\n", "the Node process actually ran the body");
                    assert.match(packetSection(packet, "log"), /js-runtime-witness/,
                        "the actual Node process output reaches the following packet");
                } else {
                    assert.equal(JSON.parse(invocation.rx).problem.type, admission === "deny"
                        ? "https://problems.plurnk.xyz/engine/dispatcher/capability-denied"
                        : "https://problems.plurnk.xyz/proposal/rejected");
                    await assert.rejects(readFile(witness), { code: "ENOENT" }, "the process never performs its side effect without admission");
                }
            } finally { client.close(); }
        });
    });
}
