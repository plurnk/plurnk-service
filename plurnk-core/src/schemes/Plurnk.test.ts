import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { parsePath } from "@plurnk/plurnk-parser";
import { coreRepresentationProvider } from "../core/CoreSchemeServices.ts";
import type { Db } from "../core/Db.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import Plurnk from "./Plurnk.ts";

const makeContext = (opts: {
    readonly workspaceId?: number;
    readonly sessionId?: number;
    readonly client?: { readonly contextSessionId: number | null };
    readonly stored?: Readonly<Record<string, string>>;
    readonly visible?: (pathname: string) => boolean;
} = {}): PlurnkSchemeContext => {
    const workspaceId = opts.workspaceId ?? 1;
    const sessionId = opts.sessionId ?? 2;
    const stored = opts.stored ?? {
        "/AGENTS.md": "# Standing Policy\n\nFollow invariants.\n",
        "/AGENTS.local.md": "# Local Policy\n",
    };
    const db = {
        envelope_get_session_by_id: {
            get: async ({ id }: { id: number }) => {
                if (id === 1) {
                    return {
                        id: 1,
                        name: "_plurnk",
                        workspace_id: 1,
                        created_at: "2026-01-01T00:00:00.000Z",
                        origin: "_plurnk",
                        owner: "_plurnk",
                        parentSessionId: null,
                        archived_at: null,
                        title: null,
                        persona: null,
                        kind: "runtime",
                        loopObservations: "[]",
                    };
                }
                if (id === 2) {
                    return {
                        id: 2,
                        name: "user",
                        workspace_id: 1,
                        created_at: "2026-01-01T00:00:00.000Z",
                        origin: "model",
                        owner: "acp:///owner",
                        parentSessionId: null,
                        archived_at: null,
                        title: "Main Session",
                        persona: "reviewer",
                        kind: "conversation",
                        loopObservations: JSON.stringify([{ status: 202, sequence: 1, terminatedAt: null }]),
                    };
                }
                return undefined;
            },
        },
        application_list_session_loops: {
            all: async ({ session_id }: { session_id: number }) =>
                session_id === 2
                    ? [
                        {
                            id: 10,
                            sessionId: 2,
                            sequence: 1,
                            status: 202,
                            prompt: "Inspect status",
                            promptSource: null,
                            claimedAt: "2026-01-01T00:00:01.000Z",
                            terminatedAt: null,
                            terminalResult: null,
                            packetCount: 1,
                            waitUntil: null,
                            invocationSessionId: null,
                            invocation: null,
                        },
                    ]
                    : [],
        },
        message_inbox: { all: async () => [] },
        session_open_streams: {
            all: async ({ session_id }: { session_id: number }) =>
                session_id === 2
                    ? [
                        {
                            id: 77,
                            entry_id: 88,
                            session_id: 2,
                            scheme: "exec",
                            authority: "",
                            pathname: "/sh/00000088",
                            source: "log:///1/1/1/sh",
                            opened_at: "2026-01-01T00:00:02.000Z",
                            channel: "stdout",
                            state: "active",
                            mimetype: "text/plain",
                        },
                    ]
                    : [],
        },
        log_entry_aside_at_coordinate: {
            get: async () => ({ aside: "watch stream" }),
        },
        proposal_list_pending: { all: async () => [] },
        client_interaction_list: {
            all: async () => [
                {
                    interactionId: 5,
                    sessionId: 2,
                    loopId: 10,
                    turnId: 11,
                    recipient: "acp:///owner",
                    request: JSON.stringify({
                        toolName: "question",
                        mode: "form",
                        message: "Continue?",
                        requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } },
                    }),
                },
            ],
        },
        runtime_session_get: { get: async () => ({ id: 1 }) },
        log_entries_recent: {
            all: async ({ session_id }: { session_id: number }) =>
                session_id === 2
                    ? [
                        {
                            id: 501,
                            session_id: 2,
                            session_name: "user",
                            loop_id: 10,
                            loop_seq: 1,
                            turn_id: 11,
                            turn_seq: 1,
                            sequence: 1,
                            at: "2026-01-01T00:00:02.000Z",
                            origin: "model",
                            source: null,
                            op: "sh",
                            signal: null,
                            scheme: null,
                            username: null,
                            password: null,
                            hostname: null,
                            port: null,
                            pathname: null,
                            query: null,
                            fragment: null,
                            lineMarker: null,
                            tx: JSON.stringify("echo hi"),
                            mimetype_tx: "text/plain",
                            rx: JSON.stringify({ status: 200 }),
                            mimetype_rx: "application/json",
                            status_rx: 200,
                            weight: 12,
                            attrs: "{}",
                            state: "resolved",
                            reasoning: null,
                            reasoning_model_call_id: null,
                            reasoning_request_sequence: null,
                            invocation: null,
                            answering: null,
                            replied_to_sources: null,
                        },
                    ]
                    : [
                        {
                            id: 502,
                            session_id: 1,
                            session_name: "_plurnk",
                            loop_id: 12,
                            loop_seq: 2,
                            turn_id: 13,
                            turn_seq: 1,
                            sequence: 1,
                            at: "2026-01-01T00:00:03.000Z",
                            origin: "client",
                            source: null,
                            op: "note",
                            signal: null,
                            scheme: null,
                            username: null,
                            password: null,
                            hostname: null,
                            port: null,
                            pathname: null,
                            query: null,
                            fragment: null,
                            lineMarker: null,
                            tx: JSON.stringify("saved"),
                            mimetype_tx: "text/plain",
                            rx: JSON.stringify({ status: 200 }),
                            mimetype_rx: "application/json",
                            status_rx: 200,
                            weight: 5,
                            attrs: "{}",
                            state: "resolved",
                            reasoning: null,
                            reasoning_model_call_id: null,
                            reasoning_request_sequence: null,
                            invocation: null,
                            answering: null,
                            replied_to_sources: null,
                        },
                    ],
        },
        crud_read_entry: {
            all: async ({ pathname }: { pathname: string }) => {
                const body = stored[pathname];
                if (body === undefined) return [];
                return [
                    {
                        id: 300,
                        attributes: "{}",
                        name: "body",
                        content: body,
                        mimetype: "text/markdown",
                        state: "static",
                        producer_result: null,
                        synced_sig: null,
                    },
                ];
            },
        },
    } as unknown as Db;

    return {
        db,
        workspaceId,
        sessionId,
        loopId: 10,
        turnId: 11,
        signal: undefined,
        writer: opts.client !== undefined ? "client" : "model",
        ...(opts.client === undefined ? {} : { client: opts.client }),
        ...(opts.visible === undefined ? {} : { referenceVisibility: async () => opts.visible! }),
    };
};

describe("Plurnk scheme core representation", () => {
    test("{§tools-resource-materialization} {§scheme-address}: only plurnk:/// registers resolveCoreRepresentation while mcp:/// stays entry-backed", () => {
        const plurnk = new Plurnk("plurnk");
        const mcp = new Plurnk("mcp");
        assert.equal(coreRepresentationProvider(plurnk), plurnk);
        assert.equal(coreRepresentationProvider(mcp), null);
    });

    test("{§tools-resource-materialization} {§application-session-observation}: plurnk:///status.json and plurnk:///recent.json resolve bound session projections and refuse unaddressed client reads with 404 session-unaddressed", async () => {
        const plurnk = new Plurnk("plurnk");

        const unaddressed = await plurnk.resolveCoreRepresentation!(
            parsePath("plurnk:///status.json"),
            makeContext({ sessionId: 1, client: { contextSessionId: null } }),
        );
        assert.ok("result" in unaddressed);
        assert.equal(unaddressed.result.status, 404);
        assert.equal(unaddressed.result.problem?.type, "https://problems.plurnk.xyz/scheme/plurnk/session-unaddressed");

        const statusResolved = await plurnk.resolveCoreRepresentation!(
            parsePath("plurnk:///status.json"),
            makeContext({ sessionId: 1, client: { contextSessionId: 2 } }),
        );
        assert.ok("representation" in statusResolved);
        assert.equal(statusResolved.representation.channels.body.mimetype, "application/json");
        const statusJson = JSON.parse(statusResolved.representation.channels.body.content) as {
            workspaceId: number;
            sessionId: number;
            isModelSession: boolean;
            session: { name: string; lifecycle: string; title?: string; persona?: string };
            openStreams: Array<{ target: string; aside?: string }>;
            pendingInteractions: Array<{ interactionId: number }>;
        };
        assert.equal(statusJson.workspaceId, 1);
        assert.equal(statusJson.sessionId, 2);
        assert.equal(statusJson.isModelSession, true);
        assert.equal(statusJson.session.name, "user");
        assert.equal(statusJson.session.lifecycle, "parked");
        assert.equal(statusJson.openStreams[0]?.target, "exec:///sh/00000088");
        assert.equal(statusJson.openStreams[0]?.aside, "watch stream");
        assert.equal(statusJson.pendingInteractions[0]?.interactionId, 5);

        const recentResolved = await plurnk.resolveCoreRepresentation!(
            parsePath("plurnk:///recent.json"),
            makeContext({ sessionId: 2 }),
        );
        assert.ok("representation" in recentResolved);
        const recentJson = JSON.parse(recentResolved.representation.channels.body.content) as {
            entries: Array<{ coordinate: string }>;
            runtimeEntries: Array<{ coordinate: string }>;
        };
        assert.equal(recentJson.entries[0]?.coordinate, "log:///1/1/1/sh");
        assert.equal(recentJson.runtimeEntries[0]?.coordinate, "log:///2/1/1/note");

        const writeAttempt = await plurnk.resolveEntryAddress(
            parsePath("plurnk:///status.json")!,
            makeContext(),
            "write",
        );
        assert.ok(writeAttempt !== null && "status" in writeAttempt);
        assert.equal(writeAttempt.status, 400);
        assert.equal(writeAttempt.problem?.type, "https://problems.plurnk.xyz/scheme/plurnk/plurnk-entry-computed");
    });

    test("{§tools-resource-materialization}: plurnk:///AGENTS.md and plurnk:///AGENTS.local.md continue reading stored entries and honoring referenceVisibility", async () => {
        const plurnk = new Plurnk("plurnk");

        const agents = await plurnk.resolveCoreRepresentation!(
            parsePath("plurnk:///AGENTS.md"),
            makeContext(),
        );
        assert.ok("representation" in agents);
        assert.equal(agents.representation.channels.body?.content, "# Standing Policy\n\nFollow invariants.\n");

        const local = await plurnk.resolveCoreRepresentation!(
            parsePath("plurnk:///AGENTS.local.md"),
            makeContext(),
        );
        assert.ok("representation" in local);
        assert.equal(local.representation.channels.body?.content, "# Local Policy\n");

        const hidden = await plurnk.resolveCoreRepresentation!(
            parsePath("plurnk:///AGENTS.local.md"),
            makeContext({ visible: (p) => p !== "/AGENTS.local.md" }),
        );
        assert.ok("result" in hidden);
        assert.equal(hidden.result.status, 404);
    });
});
