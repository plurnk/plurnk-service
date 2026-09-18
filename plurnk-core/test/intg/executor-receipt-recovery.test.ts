import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import ExecutorRegistry, { type Executor } from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, logEntries, openMigrated, quiesceExecs, schemeManifest } from "./_helpers.ts";

// {§exec-stream-page} {§log-readable-projection}: the executor is the fixture;
// parsing, dispatch, source storage, automatic observations and packet assembly are real.
for (const body of [null, '{"query":"fixture"}']) for (const mimetype of ["text/stream", "application/json"]) {
    test(`execution recovery follows the output address of a ${body === null ? "bodyless" : "one-line"} ${mimetype} invocation`, async () => {
        const output = Array.from({ length: 40 }, (_, index) => `result ${index + 1}`).join("\n");
        const executor: Executor = {
            runtime: "receiptfixture", glyph: "?",
            manifest: { ...schemeManifest("receiptfixture", { results: mimetype }, "results"), volatile: true },
            defaultChannel: "results", channels: { results: { mimetype } },
            effect: () => "pure",
            probe: async () => ({ available: true }),
            run: async (args) => {
                assert.equal(args.target, "inspect");
                assert.equal(args.body, body ?? "");
                args.write("results", output, "text/plain");
                return { status: 200, exitCode: 0 };
            },
        };
        const executors = new ExecutorRegistry(new Map([[executor.runtime, {
            executor, namespaceOwner: { kind: "module", name: "receipt fixture" },
            glyph: "?", summary: "Receipt fixture.", details: "", available: true, detail: undefined,
            invocation: {
                target: { role: "tool", required: true, kind: "literal" },
                body: { role: "JSON arguments", required: false },
                example: { target: "inspect", body: "{}" },
            },
        }]]));
        const db = await openMigrated();
        const schemes = new SchemeRegistry();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        try {
            const workspaceId = await insertWorkspace(db, "receipt-recovery");
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "Inspect the tool result.");
            const turn = async (program: string) => {
                const provider = new Mock({ contextWindow: 100_000,
                    responses: [{ assistant: { content: program, reasoning: null } }],
                });
                const result = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages: [] });
                const stored = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
                assert.ok(stored, "the actual model request was persisted");
                return { ...result, rows: logEntries(JSON.parse(stored.packet)) };
            };
            const frame = PlurnkParser.frame;
            const observe = () => turn(frame("NOTE", "Inspect the recorded outcome."));
            const started = await turn(frame("receiptfixture (inspect)", body));
            assert.deepEqual(started.outcomes.map(({ op, status }) => [op, status]), [["receiptfixture", 200]]);
            await quiesceExecs(schemes);
            const observed = await observe();
            const invocation = observed.rows.find((row) => String(row.path).endsWith("/receiptfixture"));
            assert.ok(invocation, "the real invocation has its own log identity");
            assert.equal(invocation.target, "inspect");
            assert.match(String(invocation.stream), /^receiptfixture:\/\/\/[a-f0-9]{8}$/u);
            assert.equal(invocation.lines, body === null ? undefined : 1, "invocation lines describe arguments, never output");
            const automatic = observed.rows.find((row) => row.source === invocation.path && String(row.path).endsWith("/READ"));
            assert.ok(automatic, "the automatic output observation links to the real invocation");
            assert.deepEqual(automatic.range, { unit: "line", total: 40, requested: [1, 16], returned: [1, 16] });
            assert.match(String(automatic.body), /16:result 16\n$/u);
            assert.doesNotMatch(String(automatic.body), /result 17/u);

            const mistaken = await turn(frame(`READ (${String(invocation.path)}) <17,40>`, null));
            assert.equal(mistaken.outcomes[0]?.status, 416, "reading invocation arguments cannot retrieve execution output");
            const diagnosed = await observe();
            const failure = diagnosed.rows.find((row) => row.target === invocation.path && row.status === 416);
            assert.ok(failure, "the model sees the exact failed READ");
            const problem = failure.problem as { range: { total: number }; stream?: string; recovery?: string };
            assert.equal(problem.range.total, body === null ? 0 : 1, "the diagnostic reports the invocation's true extent");
            const stream = body === null ? problem.stream : invocation.stream;
            assert.equal(stream, invocation.stream, "recovery uses the exact advertised output address, without adding a channel");
            if (body === null) assert.equal(problem.recovery, `READ ${String(stream)} for the command's stream.`);

            const recovered = await turn(frame(`READ (${String(stream)}) <17,40>`, null));
            assert.equal(recovered.outcomes[0]?.status, 200);
            const recovery = await observe();
            const read = recovery.rows.find((row) => row.target === stream && row.origin === undefined);
            assert.ok(read, "the explicit READ reaches the next model packet");
            assert.deepEqual(read.range, { unit: "line", total: 40, requested: [17, 40], returned: [17, 40] });
            assert.equal(read.terminal, true);
            assert.equal(read.exitCode, 0);
            assert.match(String(read.body), /40:result 40\n$/u);

            const revisited = await turn([
                frame(`KILL (${String(automatic.path)})`, null),
                frame(`KILL (${String(read.path)})`, null),
                frame(`READ (${String(stream)}) <1,-1>`, null),
            ].join("\n\n"));
            assert.deepEqual(revisited.outcomes.map(({ op, status }) => [op, status]),
                [["KILL", 200], ["KILL", 200], ["READ", 200]]);
            const afterCuration = await observe();
            assert.equal(afterCuration.rows.some((row) => row.path === automatic.path || row.path === read.path), false);
            const reread = afterCuration.rows.find((row) => row.target === stream);
            assert.ok(reread, "the retained output is still readable after its observations are curated away");
            assert.deepEqual(reread.range, { unit: "line", total: 40, requested: [1, -1], returned: [1, 40] });
            assert.match(String(reread.body), /1:result 1\n/u);
            assert.match(String(reread.body), /40:result 40\n$/u);
        } finally {
            await quiesceExecs(schemes);
            await schemes.close();
            await db.close();
        }
    });
}
