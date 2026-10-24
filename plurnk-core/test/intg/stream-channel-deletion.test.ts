// {§stream-channel-deletion} (#1209): a request whose response leaves no readable projection deletes the `readable`
// channel its subscription seeded; the loop that sent it still concludes in its reply's turn.
import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Http from "@plurnk/plurnk-schemes-http";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { serverProposals } from "./_approval.ts";

const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const response = (content: string): MockResponse => ({ assistant: { content, reasoning: null } });

// Text responses keep the seeded `readable`; a binary response without a projection drops it ({§readable-channel}).
const RESPONSES: ReadonlyArray<{ readonly label: string; readonly status: number; readonly body: string | Uint8Array<ArrayBuffer> | null; readonly type: string | null }> = [
    { label: "an empty JSON 401", status: 401, body: "", type: "application/json" },
    { label: "a 204 without a body", status: 204, body: null, type: "application/json" },
    { label: "plain text", status: 200, body: "accepted", type: "text/plain" },
    { label: "JSON", status: 200, body: "{\"ok\":true}", type: "application/json" },
    { label: "an empty 401 without a content type", status: 401, body: new Uint8Array(0), type: null },
    { label: "unreadable bytes", status: 200, body: new Uint8Array([0, 1, 2, 255]), type: "application/octet-stream" },
];

for (const shape of RESPONSES) {
    test(`{§stream-channel-deletion} {§loop-completion} a request answered with ${shape.label} concludes its loop in the reply's turn`, async (t) => {
        serverProposals(t, "accept");
        t.mock.method(globalThis, "fetch", async () => new Response(shape.body, { status: shape.status, headers: shape.type === null ? {} : { "content-type": shape.type } }));
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, `stream-channel-deletion-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "probe");
        const loopId = await insertLoop(db, workerId, 1);
        const schemes = new SchemeRegistry();
        schemes.register("https", new Http());
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        await engine.injectIntoLoop(loopId, "Probe the endpoint.", [], "agui://operator/threads/probe/messages/question");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            response(frame("SEND (https://93.184.216.34/mcp)", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}")),
            response(frame("SEND [200]", "Probed.")),
            response(frame("NOTE", "Nothing remains.")),
            response(frame("NOTE", "Nothing remains.")),
        ] });
        const statuses: number[] = [];
        while (statuses.length < 4 && ![200, 499].includes(statuses.at(-1) ?? 0)) {
            statuses.push((await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] })).status);
        }
        assert.deepEqual(statuses, [102, 200], "the request's turn continues; the reply's turn, with the response observed, concludes");
    });
}
