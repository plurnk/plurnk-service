import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    methods,
    SessionUpdate,
    type CreateElicitationRequest,
    type RequestPermissionRequest,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import type {
    ClientInteractionProjection,
    ProposalProjection,
} from "@plurnk/plurnk-contracts";
import {
    WsConstructor,
    createAcpClient,
    createHarness,
    makeLogEntry,
    makeTerminatedEvent,
    waitFor,
} from "../test/harness.ts";

describe("{§acp-proposal-resolve} plurnk-acp gates & topology", { concurrency: true }, () => {
    test("{§acp-proposal-resolve} {§acp-session-owner}: session/request_permission, elicitation/create, elicitation/complete, and multi-peer $/cancel_request", async () => {
        const h = await createHarness();
        try {
            const permissionRequests1: RequestPermissionRequest[] = [];
            const permissionRequests2: RequestPermissionRequest[] = [];
            const elicitations1: CreateElicitationRequest[] = [];
            const completedElicitations: string[] = [];
            const updates1: SessionUpdate[] = [];

            const stream1 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const stream2 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });

            const client1 = createAcpClient()
                .onNotification(methods.client.session.update, ({ params }) => {
                    updates1.push(params.update);
                })
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    permissionRequests1.push(params);
                    return {
                        outcome: { outcome: "selected", optionId: "allow_once" },
                        _meta: { plurnk: { body: "rm -rf build/tmp" } },
                    };
                })
                .onRequest(methods.client.elicitation.create, async ({ params }) => {
                    elicitations1.push(params);
                    return { action: "accept", content: { answer: "42" } };
                })
                .onNotification(methods.client.elicitation.complete, ({ params }) => {
                    completedElicitations.push(params.elicitationId);
                });

            let peer2Cancelled = false;
            const client2 = createAcpClient().onRequest(
                methods.client.session.requestPermission,
                async ({ params, signal }) => {
                    permissionRequests2.push(params);
                    await new Promise<void>((resolve) => {
                        signal.addEventListener("abort", () => {
                            peer2Cancelled = true;
                            resolve();
                        });
                    });
                    return { outcome: { outcome: "cancelled" } };
                },
            );

            await client1.connectWith(stream1, async (ctx1) => {
                await client2.connectWith(stream2, async (ctx2) => {
                    await ctx1.request(methods.agent.session.resume, {
                        sessionId: "1#user",
                        cwd: "/workspace/alpha",
                    });
                    await ctx2.request(methods.agent.session.resume, {
                        sessionId: "1#user",
                        cwd: "/workspace/alpha",
                    });

                    const proposal: ProposalProjection = {
                        logEntryId: 501,
                        sessionId: 1,
                        session: "user",
                        loopId: 1,
                        turnId: 1,
                        coordinate: "1/1/1",
                        op: "sh",
                        target: { scheme: "sh", authority: null, pathname: null },
                        body: "rm -rf build",
                        disposition: { decision: "review" },
                        owner: "acp://operator",
                        attrs: { tag: "sh", body: "rm -rf build", cwd: "/workspace/alpha" },
                        subject: { type: "command", command: "rm -rf build", cwd: "/workspace/alpha" },
                    };
                    h.port.proposals.push(proposal);
                    h.port.emitEvent(1, "loop/proposal", proposal);

                    const interaction: ClientInteractionProjection = {
                        interactionId: 601,
                        sessionId: 1,
                        loopId: 1,
                        turnId: 1,
                        recipient: "acp://operator",
                        request: {
                            toolName: "question",
                            mode: "form",
                            message: "What is the answer?",
                            requestedSchema: {
                                type: "object",
                                properties: { answer: { type: "string", title: "Answer" } },
                                required: ["answer"],
                            },
                        },
                    };
                    h.port.interactions.push(interaction);
                    h.port.emitEvent(1, "loop/interaction", interaction);

                    await waitFor(
                        () =>
                            h.port.proposals.length === 0 &&
                            peer2Cancelled &&
                            h.port.interactions.length === 0 &&
                            completedElicitations.length > 0,
                    );

                    assert.equal(permissionRequests1.length, 1);
                    assert.equal(permissionRequests1[0]?.subject?.type, "command");
                    if (permissionRequests1[0]?.subject?.type === "command") {
                        assert.equal(permissionRequests1[0].subject.toolCallId, "1/1/1");
                        assert.equal(permissionRequests1[0].subject.terminalId, "term:501");
                    }
                    const pendingCall = updates1.find(
                        (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                            u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/1",
                    );
                    assert.ok(pendingCall !== undefined, "proposal emits pending tool_call_update with canonical coordinate toolCallId");
                    assert.equal(pendingCall.status, "pending");
                    assert.equal(
                        (pendingCall._meta as { plurnk?: { coordinate?: string; status?: number } } | undefined)?.plurnk?.coordinate,
                        "1/1/1",
                    );
                    assert.equal(
                        (pendingCall._meta as { plurnk?: { coordinate?: string; status?: number } } | undefined)?.plurnk?.status,
                        202,
                    );
                    assert.deepEqual(
                        permissionRequests1[0]?.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
                        [
                            { optionId: "allow_once", kind: "allow_once" },
                            { optionId: "allow_always", kind: "allow_always" },
                            { optionId: "reject_once", kind: "reject_once" },
                            { optionId: "reject_always", kind: "reject_always" },
                        ],
                    );
                    assert.equal(h.port.proposals.length, 0, "proposal resolved in port");
                    assert.equal(
                        h.port.resolvedProposals[0]?.resolution.body,
                        "rm -rf build/tmp",
                        "edited proposal body forwarded to resolveProposal ({§acp-proposal-resolve})",
                    );
                    assert.equal(peer2Cancelled, true, "second peer received $/cancel_request ({§acp-proposal-resolve})");

                    assert.equal(elicitations1.length, 1);
                    assert.equal(elicitations1[0]?.mode, "form");
                    assert.equal(h.port.interactions.length, 0, "interaction resolved in port");
                    assert.ok(completedElicitations.length > 0, "elicitation/complete emitted");
                });
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-topology-scope} {§acp-proposal-resolve}: sibling sessions never leak subagent updates, session messages, or gates across actor boundaries, bodiless send omits session_message, and 409 gate settlements are idempotent", async () => {
        const h = await createHarness();
        try {
            h.port.sessions.push(
                {
                    id: 2,
                    workspaceId: 1,
                    name: "helper",
                    created_at: "2026-10-25T00:00:00.000Z",
                    origin: "model",
                    owner: "acp://operator",
                    parentSessionId: 1,
                    kind: "work",
                    lifecycle: "running",
                    archived_at: null,
                },
                {
                    id: 3,
                    workspaceId: 1,
                    name: "major",
                    created_at: "2026-10-25T00:00:00.000Z",
                    origin: "model",
                    owner: "acp://operator",
                    parentSessionId: null,
                    kind: "root",
                    lifecycle: "running",
                    archived_at: null,
                },
            );

            const updates: SessionUpdate[] = [];
            const permissionRequests: RequestPermissionRequest[] = [];
            let resolvePermissionGate: (() => void) | null = null;
            const permissionGateHeld = new Promise<void>((resolve) => {
                resolvePermissionGate = resolve;
            });

            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const clientApp = createAcpClient()
                .onNotification(methods.client.session.update, ({ params }) => {
                    updates.push(params.update);
                })
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    permissionRequests.push(params);
                    if (params._meta && typeof params._meta === "object" && "plurnk" in params._meta) {
                        const p = (params._meta as { plurnk?: { proposal?: { logEntryId?: number } } }).plurnk?.proposal;
                        if (p?.logEntryId === 702) {
                            await permissionGateHeld;
                        }
                    }
                    return { outcome: { outcome: "selected", optionId: "allow_once" } };
                });

            await clientApp.connectWith(stream, async (ctx) => {
                // Pending proposal on sibling session 3 ("major") before session/resume on "1#user"
                const siblingProposal: ProposalProjection = {
                    logEntryId: 701,
                    sessionId: 3,
                    session: "major",
                    loopId: 3,
                    turnId: 1,
                    coordinate: "1/1/1",
                    op: "sh",
                    target: { scheme: "sh", authority: null, pathname: null },
                    body: "echo sibling",
                    disposition: { decision: "review" },
                    owner: "acp://operator",
                    attrs: { tag: "sh", body: "echo sibling", cwd: "/workspace/alpha" },
                    subject: { type: "command", command: "echo sibling", cwd: "/workspace/alpha" },
                };
                h.port.proposals.push(siblingProposal);

                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });

                // Live events on sibling session 3 ("major") must NOT leak to "1#user"
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 710,
                        session_id: 3,
                        session_name: "major",
                        loop_id: 3,
                        turn_id: 1,
                        op: "send",
                        attrs: { kind: "message", to: "acp://operator", body: "Sibling reply" },
                        rx: { status: 200, content: "Sibling reply", mimetype: "text/markdown" },
                        mimetype_rx: "text/markdown",
                    }),
                });
                h.port.emitEvent(1, "loop/proposal", siblingProposal);
                h.port.emitEvent(1, "loop/terminated", makeTerminatedEvent({ sessionId: 3, loopId: 3 }));

                // Bodiless done on descendant session 2 ("helper") emits subagent_update but NOT session_message("done")
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 711,
                        session_id: 2,
                        session_name: "helper",
                        loop_id: 2,
                        turn_id: 1,
                        op: "done",
                        attrs: {},
                        rx: { status: 204, completion: 200, content: "", mimetype: "text/plain" },
                    }),
                });

                await waitFor(() =>
                    updates.some(
                        (u) => u.sessionUpdate === "subagent_update" && u.sessionId === "1#helper",
                    ),
                );

                assert.equal(
                    updates.some(
                        (u) => u.sessionUpdate === "subagent_update" && u.sessionId === "1#major",
                    ),
                    false,
                    "sibling session never leaks subagent_update to 1#user",
                );
                assert.equal(
                    updates.some((u) => u.sessionUpdate === "session_message"),
                    false,
                    "neither sibling send nor bodiless descendant send emits session_message",
                );
                assert.equal(
                    permissionRequests.length,
                    0,
                    "sibling session proposals never dispatch to 1#user on resume or live loop/proposal",
                );

                // Descendant proposal on session 2 ("helper") DOES dispatch to "1#user",
                // and if already removed in Core (409 interrupt-not-pending), settles without error notice.
                const childProposal: ProposalProjection = {
                    logEntryId: 702,
                    sessionId: 2,
                    session: "helper",
                    loopId: 2,
                    turnId: 1,
                    coordinate: "1/1/2",
                    op: "sh",
                    target: { scheme: "sh", authority: null, pathname: null },
                    body: "echo child",
                    disposition: { decision: "review" },
                    owner: "acp://operator",
                    attrs: { tag: "sh", body: "echo child", cwd: "/workspace/alpha" },
                    subject: { type: "command", command: "echo child", cwd: "/workspace/alpha" },
                };
                h.port.proposals.push(childProposal);
                h.port.emitEvent(1, "loop/proposal", childProposal);

                await waitFor(() => permissionRequests.length === 1);
                // Simulate proposal already settled in Core before client response arrives
                h.port.proposals.length = 0;
                resolvePermissionGate?.();

                await new Promise((r) => setTimeout(r, 30));
                assert.equal(
                    updates.some(
                        (u) => u.sessionUpdate === "notice" && u.severity === "error",
                    ),
                    false,
                    "409 interrupt-not-pending settles idempotently without emitting an error notice",
                );
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-body-reference} {§acp-plurnk-metadata} {§acp-proposal-resolve} {§acp-topology-scope}: DiffChange operations, 1-based ToolCallLocation.line, URL elicitation for MCP OAuth, and subagent_update ordering", async () => {
        const h = await createHarness();
        try {
            h.port.sessions.push({
                id: 2,
                workspaceId: 1,
                name: "worker",
                created_at: "2026-10-25T00:00:00.000Z",
                origin: "model",
                owner: "acp://operator",
                parentSessionId: 1,
                kind: "work",
                lifecycle: "running",
                archived_at: null,
            });
            const origListModuleActions = h.port.listModuleActions.bind(h.port);
            h.port.listModuleActions = () => [
                ...origListModuleActions(),
                {
                    name: "workspace.mcp.oauth.begin",
                    scope: "workspace",
                    inputSchema: {
                        type: "object",
                        properties: { alias: { type: "string" } },
                    },
                    outputSchema: { type: "object" },
                },
                {
                    name: "workspace.mcp.oauth.complete",
                    scope: "workspace",
                    inputSchema: {
                        type: "object",
                        properties: { alias: { type: "string" }, callbackUrl: { type: "string" } },
                    },
                    outputSchema: { type: "object" },
                },
            ];
            const origInvoke = h.port.invokeModuleAction.bind(h.port);
            h.port.invokeModuleAction = async (name, params, ctx) => {
                if (name === "workspace.mcp.oauth.begin") {
                    return {
                        status: 202,
                        alias: "github",
                        authorization: { url: "https://auth.example.com/authorize?state=xyz" },
                    };
                }
                if (name === "workspace.mcp.oauth.complete") {
                    return {
                        status: 202,
                        alias: "github",
                    };
                }
                return origInvoke(name, params, ctx);
            };

            const updates: SessionUpdate[] = [];
            const urlElicitations: CreateElicitationRequest[] = [];
            const completedElicitations: string[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const clientApp = createAcpClient()
                .onNotification(methods.client.session.update, ({ params }) => {
                    updates.push(params.update);
                })
                .onRequest(methods.client.elicitation.create, async ({ params }) => {
                    urlElicitations.push(params);
                    return { action: "accept" };
                })
                .onNotification(methods.client.elicitation.complete, ({ params }) => {
                    completedElicitations.push(params.elicitationId);
                });

            await clientApp.connectWith(stream, async (ctx) => {
                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });

                // 1. DiffChange: add (201), delete (kill), move (move), and 1-based line on read/edit
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 801,
                        session_id: 1,
                        sequence: 1,
                        op: "edit",
                        pathname: "/workspace/alpha/created.ts",
                        status_rx: 201,
                        tx: { op: "edit", lineMarker: { marks: [12] } },
                        attrs: { original: "", patched: "export const x = 1;\n" },
                        rx: { status: 201 },
                    }),
                });
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 802,
                        session_id: 1,
                        sequence: 2,
                        op: "kill",
                        pathname: "/workspace/alpha/deleted.ts",
                        status_rx: 204,
                        attrs: { original: "old\n", patched: "" },
                        rx: { status: 204 },
                    }),
                });
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 803,
                        session_id: 1,
                        sequence: 3,
                        op: "move",
                        pathname: "/workspace/alpha/new-name.ts",
                        status_rx: 200,
                        attrs: { oldPath: "/workspace/alpha/old-name.ts", to: "/workspace/alpha/new-name.ts" },
                        rx: { status: 200 },
                    }),
                });

                await waitFor(() =>
                    updates.some((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/3"),
                );

                const addCall = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                        u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/1",
                );
                assert.deepEqual(addCall?.locations, [{ path: "/workspace/alpha/created.ts", line: 12 }]);
                const addDiff = addCall?.content?.find((c) => c.type === "diff");
                assert.deepEqual(
                    addDiff && "changes" in addDiff ? addDiff.changes : undefined,
                    [{ operation: "add", path: "/workspace/alpha/created.ts" }],
                );

                const delCall = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                        u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/2",
                );
                const delDiff = delCall?.content?.find((c) => c.type === "diff");
                assert.deepEqual(
                    delDiff && "changes" in delDiff ? delDiff.changes : undefined,
                    [{ operation: "delete", path: "/workspace/alpha/deleted.ts" }],
                );

                const moveCall = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                        u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/3",
                );
                const moveDiff = moveCall?.content?.find((c) => c.type === "diff");
                assert.deepEqual(
                    moveDiff && "changes" in moveDiff ? moveDiff.changes : undefined,
                    [
                        {
                            operation: "move",
                            oldPath: "/workspace/alpha/old-name.ts",
                            path: "/workspace/alpha/new-name.ts",
                        },
                    ],
                );

                // 2. URL-mode elicitation for workspace.mcp.oauth.begin / complete (and /mcp oauth slash command)
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: "1#user",
                    prompt: [{ type: "text", text: "/mcp oauth github" }],
                });
                await waitFor(() => urlElicitations.length === 1);
                assert.equal(urlElicitations[0]?.mode, "url");
                if (urlElicitations[0]?.mode === "url") {
                    assert.equal(urlElicitations[0].url, "https://auth.example.com/authorize?state=xyz");
                    assert.equal(urlElicitations[0].elicitationId, "mcp-oauth:1:github");
                }

                await ctx.request(methods.agent.session.prompt, {
                    sessionId: "1#user",
                    prompt: [{ type: "text", text: "/mcp oauth github http://127.0.0.1:9999/cb?code=1&state=xyz" }],
                });
                await waitFor(() => completedElicitations.includes("mcp-oauth:1:github"));

                // 3. Descendant log/entry followed immediately by loop/terminated preserves FIFO subagent_update order
                updates.length = 0;
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 804,
                        session_id: 2,
                        session_name: "worker",
                        loop_seq: 1,
                        turn_seq: 1,
                        sequence: 1,
                        origin: "model",
                        op: "done",
                        attrs: { body: "Done working" },
                        rx: { status: 200, completion: 200, content: "Done working" },
                    }),
                });
                h.port.emitEvent(1, "loop/terminated", {
                    sessionId: 2,
                    loopId: 2,
                    turnIds: [1],
                    hitMaxTurns: false,
                    result: { status: 200 },
                });

                await waitFor(
                    () =>
                        updates.filter((u) => u.sessionUpdate === "subagent_update").length >= 2 &&
                        updates.some((u) => u.sessionUpdate === "session_message"),
                );
                const subagentIdx0 = updates.findIndex(
                    (u) =>
                        SessionUpdate.isSubagentUpdate(u) &&
                        u.state !== null &&
                        typeof u.state === "object" &&
                        "state" in u.state &&
                        u.state.state === "running",
                );
                const msgIdx = updates.findIndex((u) => u.sessionUpdate === "session_message");
                const subagentIdx1 = updates.findIndex(
                    (u) =>
                        SessionUpdate.isSubagentUpdate(u) &&
                        u.state !== null &&
                        typeof u.state === "object" &&
                        "state" in u.state &&
                        u.state.state === "idle",
                );
                assert.ok(subagentIdx0 >= 0 && msgIdx > subagentIdx0, "running subagent_update precedes session_message");
                assert.ok(subagentIdx1 > msgIdx, "idle subagent_update follows child session_message");
            });
        } finally {
            await h.close();
        }
    });
});
