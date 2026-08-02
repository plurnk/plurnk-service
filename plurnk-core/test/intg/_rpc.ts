// Shared Daemon test helpers — the harness rides the CoreSeam (#364): connect() hands back a
// SeamSocket (the ws-mimic whose every method dispatches into the seam), so the whole intg tier
// certifies the one client surface. Used by every Daemon.* and SEND[*] integration test.

import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { OperationResult, ProblemDetails } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import SeamSocket from "./_seam.ts";
import type { MockResponse, Provider } from "@plurnk/plurnk-providers";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated } from "./_helpers.ts";

export interface RpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

// The "address" is the daemon itself — there is no socket to dial (#364).
export interface DaemonAddr { daemon: Daemon }

export const rpcCall = (ws: SeamSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) { ws.off("message", onMessage); resolve(parsed); }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        const payload: { jsonrpc: string; id: number; method: string; params?: object } = { jsonrpc: "2.0", id, method };
        if (params !== undefined) payload.params = params;
        ws.send(JSON.stringify(payload));
    });

export const rpcProblem = (response: RpcResponse): ProblemDetails => {
    const result = response.result as OperationResult | undefined;
    if (result?.problem === undefined) {
        throw new Error(`RPC response did not carry a Problem result: ${JSON.stringify(response)}`);
    }
    return result.problem;
};

// Subscribe to a notification stream. Returns a getter that yields the
// captured params in order.
export const subscribeNotifications = (ws: SeamSocket, method: string): (() => unknown[]) => {
    const captured: unknown[] = [];
    ws.on("message", (data) => {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const parsed = JSON.parse(text) as { method?: string; params?: unknown; id?: unknown };
        if (parsed.id === undefined && parsed.method === method) captured.push(parsed.params);
    });
    return () => captured;
};

// Sleep enough for notifications to flush across the worker boundary.
// 50ms is what we landed on after diagnosing race conditions in
// stream/event tests. Don't use setImmediate — it isn't enough.
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

// Event-driven wait: poll a subscribeNotifications getter until `predicate`
// holds, or throw on timeout. Race-free — the getter returns the full backlog
// captured since subscription, so nothing is missed between subscribe and
// wait. Replaces fixed sleeps in lifecycle tests: wait for the thing to be
// true, and fail loudly (a hang surfaces as a timeout) instead of guessing a
// duration.
export const waitFor = async <T>(
    getter: () => T[],
    predicate: (items: T[]) => boolean,
    { timeoutMs = 4000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T[]> => {
    const start = Date.now();
    for (;;) {
        const items = getter();
        if (predicate(items)) return items;
        if (Date.now() - start >= timeoutMs) {
            throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms (saw ${items.length})`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
};

// DB-driven variant of waitFor: poll an async getter (a DB query) until the
// predicate holds. For lifecycle preconditions that live in the database rather
// than the notification stream — e.g. wait for an exec subscription to actually
// open before cancelling, instead of racing a fixed sleep against the spawn.
export const waitForDb = async <T>(
    getter: () => Promise<T>,
    predicate: (value: T) => boolean,
    { timeoutMs = 5000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> => {
    const start = Date.now();
    for (;;) {
        const value = await getter();
        if (predicate(value)) return value;
        if (Date.now() - start >= timeoutMs) {
            throw new Error(`waitForDb: predicate not satisfied within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
};

// Model 3 — loop.run ACCEPTS and returns immediately (status 100 + loopId); a loop's real
// outcome arrives via the loop/terminated event, never loop.worker's return. A parked loop
// (SEND[202]) awaits an external event, so loop.run cannot block on it without deadlocking
// the client that must send that event. This runs a loop to its true terminal the honest
// way: fire loop.run, then await its loop/terminated. Returns the terminal status (+ the
// loopId and the `accepted` status, for callers that assert the 100).
export const runLoopToTerminal = async (
    ws: SeamSocket, id: number, params: object,
    { timeoutMs = 8000 }: { timeoutMs?: number } = {},
): Promise<{
    loopId: number; finalStatus: number; accepted: number; action?: string; modelWorkerId?: number;
    result: OperationResult;
    hitMaxTurns?: boolean; turnIds?: number[]; usage?: { promptTokens: number; completionTokens: number; costUsd: number };
}> => {
    const terminated = subscribeNotifications(ws, "loop/terminated");
    const response = await rpcCall(ws, id, "loop.run", params);
    if (response.error !== undefined) {
        throw new Error(`loop.run RPC failed (${response.error.code}): ${response.error.message}`);
    }
    const { loopId, status: accepted, action, modelWorkerId } = response.result as OperationResult & { loopId: number; action?: string; modelWorkerId?: number };
    const seen = await waitFor(
        () => terminated() as Array<{ loopId: number }>,
        (ts) => ts.some((t) => t.loopId === loopId),
        { timeoutMs },
    );
    const term = seen.find((t) => t.loopId === loopId) as {
        loopId: number; result: OperationResult; hitMaxTurns?: boolean; turnIds?: number[];
        usage?: { promptTokens: number; completionTokens: number; costUsd: number };
    };
    return { ...term, finalStatus: term.result.status, accepted, action, modelWorkerId };
};

export const connect = (addr: DaemonAddr): Promise<SeamSocket> =>
    Promise.resolve(new SeamSocket(addr.daemon));

// Open db + daemon, run the callback, clean up. Provider is optional —
// a Mock for deterministic tiers, or a real Provider (loadActiveProvider)
// for the live/demo tiers that drive the prod loop against a real model.
export const withDaemon = async <T>(
    provider: Provider | null,
    fn: (db: Db, daemon: Daemon, addr: DaemonAddr) => Promise<T>,
): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    await daemon.start(); // listenerless — the harness rides the seam, not a socket
    try { return await fn(db, daemon, { daemon }); }
    finally { await daemon.stop(); await db.close(); }
};

// Parse plurnk DSL into statement ops. Used to build mock provider responses.
export const parseDsl = (text: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(text);
    const statements = result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
    // Fail-hard ONLY when nothing parsed: zero statements alongside an error means the input
    // didn't parse at all (e.g. a bare statement with no PLAN lead — grammar 0.70 requires
    // PLAN-first), which silently returned [] and let callers build phantom-empty turns. A
    // trailing "incomplete turn" error WITH real statements (a partial turn — PLAN + ops, no
    // terminal SEND) is a legitimate fixture; return the statements.
    if (statements.length === 0 && result.items.some((i) => i.kind === "error")) {
        throw new Error(`parseDsl: DSL produced no statements — it did not parse (grammar 0.70 requires a PLAN lead): ${JSON.stringify(text)}`);
    }
    return statements;
};

export const makeMockResponse = (dsl: string, completion: number = 0): MockResponse => {
    // Every turn leads with PLAN (plurnk.md "Imperatives"). The mock emits what a
    // compliant model emits; PLAN and SEND flow through as ordinary dispatched ops.
    const turn = dsl.startsWith("<<PLAN") ? dsl : `<<PLAN::PLAN\n${dsl}`;
    return {
        assistant: {
            content: turn, ops: parseDsl(turn), reasoning: null,
            usage: { prompt: 0, completion, reasoning: 0, cached: 0, total: completion },
        },
        assistantRaw: null,
    };
};
