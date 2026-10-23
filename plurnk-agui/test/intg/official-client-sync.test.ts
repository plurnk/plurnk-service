// {§agui-sync} — when a client's snapshot holds an earlier version of a row, the daemon delivers the row's later facts as a
// repeated START and END without arguments and its result under the same message identity. The official client folds that
// result onto the one its snapshot holds.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Translator from "../../src/Translator.ts";
import { wireRow } from "../log-fixture.ts";
import { ORIGIN } from "../notification-fixture.ts";

test("{§agui-sync} the official client folds a result delivered again onto the one its snapshot holds", async (t) => {
    const item = PlurnkParser.parseStatements("````READ (worker:///notes.md)\n````").items[0];
    if (item?.kind !== "statement") assert.fail("no statement");
    const row = (content: string) => wireRow({ id: 7, sequence: 3, op: "READ", scheme: "worker", pathname: "/notes.md",
        tx: item.statement as unknown as Record<string, unknown>, rx: { status: 200, content }, status_rx: 200 });
    const translator = () => new Translator({ origin: ORIGIN, workspaceId: 3, threadId: "th-1", runId: "run-1" });
    const [snapshot] = translator().replay([row("first")]);
    const again = translator().logEntry({ entry: row("second") }).filter(({ type }) =>
        type === EventType.TOOL_CALL_START || type === EventType.TOOL_CALL_END || type === EventType.TOOL_CALL_RESULT);
    const result = again.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT || result?.type !== EventType.TOOL_CALL_RESULT) assert.fail("no snapshot or result");
    assert.ok(snapshot.messages.some(({ id }) => id === result.messageId), "the snapshot holds the result the row delivers again");

    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunAgentInput;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
            { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId }, snapshot, ...again,
            { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    if (address === null || typeof address === "string") assert.fail("no listener address");

    const agent = new HttpAgent({ url: `http://127.0.0.1:${address.port}/agui`, threadId: "th-1" });
    await agent.runAgent();
    const identities = agent.messages.map(({ id }) => id);
    assert.deepEqual(identities.filter((id, index) => identities.indexOf(id) !== index), [], "each message once");
    assert.deepEqual(agent.messages.filter(({ role }) => role === "tool").map(({ content }) => content), [result.content], "holding the later result");
});
