// #364 — the harness rides the CoreSeam. SeamSocket mimics the retired WS connection's surface
// (send/on/once/off/close + JSON-RPC 'message' events) but every method dispatches DIRECTLY into
// the daemon's seam — the same contract agui consumes — so the whole intg tier certifies the one
// client surface and nothing else. No socket, no port, no bonus surface for a capability to creep
// onto: a method not on the seam is not reachable from a test.
//
// The shim holds the CLIENT state a transport module holds at its edge (the attached envelope,
// the lazily-resolved model run) and the protocol niceties tests rely on (JSON-RPC envelopes,
// notification fan-in via subscribeToEvents filtered to the attached session).
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import Dsl from "./dsl.ts";
import type Daemon from "../../src/server/Daemon.ts";
import type { ClientEnvelope } from "../../src/server/envelope.ts";

type Listener = (data: string) => void;

export default class SeamSocket {
    #daemon: Daemon;
    #listeners = new Map<string, Set<Listener>>();
    #unsubscribe: () => void;
    #session: ClientEnvelope | null = null;
    #closed = false;

    constructor(daemon: Daemon) {
        this.#daemon = daemon;
        // The one event pipe: seam events arrive (sessionId | null, method, params) and re-emit as
        // JSON-RPC notifications, filtered the way the WS connection was — my session's + globals.
        this.#unsubscribe = daemon.subscribeToEvents((sessionId, method, params) => {
            if (this.#closed) return;
            if (sessionId !== null && this.#session !== null && sessionId !== this.#session.sessionId) return;
            if (sessionId !== null && this.#session === null) return;
            // §notifications-envelope-carries-sessionid — the envelope stamps the scope, as the WS did.
            const scoped = sessionId !== null && params !== null && typeof params === "object" ? { ...params, sessionId } : params;
            this.#emit("message", JSON.stringify({ jsonrpc: "2.0", method, params: scoped }));
        });
    }

    // --- the ws-mimic surface ---
    on(event: string, cb: Listener): void {
        let set = this.#listeners.get(event);
        if (set === undefined) { set = new Set(); this.#listeners.set(event, set); }
        set.add(cb);
    }
    once(event: string, cb: Listener): void {
        const wrapper: Listener = (data) => { this.off(event, wrapper); cb(data); };
        this.on(event, wrapper);
    }
    off(event: string, cb: Listener): void { this.#listeners.get(event)?.delete(cb); }
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#unsubscribe();
        this.#emit("close", "");
    }
    send(payload: string): void {
        const { id, method, params } = JSON.parse(payload) as { id: number; method: string; params?: object };
        void this.#dispatch(method, params ?? {}).then(
            (result) => { if (!this.#closed) this.#emit("message", JSON.stringify({ jsonrpc: "2.0", id, result })); },
            (err: unknown) => {
                if (this.#closed) return;
                const message = err instanceof Error ? err.message : String(err);
                this.#emit("message", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }));
            },
        );
    }

    #emit(event: string, data: string): void {
        for (const cb of [...(this.#listeners.get(event) ?? [])]) cb(data);
    }

    #attached(): ClientEnvelope {
        if (this.#session === null) throw new Error("no attached session — session.create/session.attach first");
        return this.#session;
    }

    // --- the method map: every RPC name a test speaks → its seam call ---
    async #dispatch(method: string, params: object): Promise<unknown> {
        const p = params as Record<string, unknown>;
        const daemon = this.#daemon;
        switch (method) {
            case "session.create": {
                const envelope = await daemon.createSession({
                    name: p.name as string | undefined,
                    projectRoot: (p.projectRoot as string | null | undefined) ?? null,
                    settings: p.settings as string | undefined,
                    constraints: p.constraints as Array<{ effect: string; glob: string }> | undefined,
                });
                this.#session = envelope;
                return { id: envelope.sessionId, name: envelope.sessionName, runId: envelope.runId, runName: envelope.runName, projectRoot: envelope.projectRoot };
            }
            case "session.attach": {
                const envelope = await daemon.attachSession({ sessionId: (p.sessionId ?? p.id) as number, runId: p.runId as number | undefined, runName: p.runName as string | undefined });
                this.#session = envelope;
                return { id: envelope.sessionId, name: envelope.sessionName, runId: envelope.runId, runName: envelope.runName, projectRoot: envelope.projectRoot };
            }
            case "loop.run": {
                const s = this.#attached();
                if (typeof p.prompt !== "string" || p.prompt.length === 0) throw new Error("loop.run requires non-empty params.prompt");
                if (s.modelRunId === null) s.modelRunId = await daemon.ensureModelRun(s.sessionId);
                let run;
                try {
                    run = await daemon.runLoop({
                        sessionId: s.sessionId, runId: s.modelRunId, prompt: p.prompt,
                        ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns as number } : {}),
                        ...(p.flags !== undefined ? { flags: p.flags as { yolo?: boolean } } : {}),
                        ...(p.openPaths !== undefined ? { openPaths: p.openPaths as string[] } : {}),
                    });
                } catch (err) {
                    // no-provider is a 501 RESULT (the client acts on status), never an error envelope.
                    if (err instanceof Error && /no provider configured/.test(err.message)) return { status: 501, error: err.message };
                    throw err;
                }
                return { ...run, modelRunId: s.modelRunId, finalStatus: 100, hitMaxTurns: false, turnIds: [] };
            }
            case "loop.inject": {
                // inject speaks to an EXISTING model run; the seam's runLoop injects into a live
                // drain identically (daemon.inject under both) — refusing only the run-start.
                const s = this.#attached();
                if (typeof p.prompt !== "string" || p.prompt.length === 0) throw new Error("loop.inject requires non-empty params.prompt");
                if (s.modelRunId === null) throw new Error("loop.inject: no model run to inject into — start one with loop.run");
                const run = await daemon.runLoop({
                    sessionId: s.sessionId, runId: s.modelRunId, prompt: p.prompt as string,
                    ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns as number } : {}),
                    ...(p.flags !== undefined ? { flags: p.flags as { yolo?: boolean } } : {}),
                });
                return { ...run, modelRunId: s.modelRunId, finalStatus: 100 };
            }
            case "loop.cancel": {
                const s = this.#attached();
                const reason = (typeof p.reason === "string" && p.reason.length > 0) ? p.reason : "user_cancelled";
                const modelRunId = s.modelRunId;
                const cancelled = modelRunId !== null && daemon.cancelDrain(modelRunId, reason);
                return { cancelled, runId: modelRunId, reason };
            }
            case "loop.resolve": {
                daemon.resolveProposal(p.logEntryId as number, {
                    decision: p.decision as "accept" | "reject",
                    ...(p.body !== undefined ? { body: p.body as string } : {}),
                    ...(p.outcome !== undefined ? { outcome: p.outcome as string } : {}),
                });
                return { resolved: true };
            }
            case "proposal.list": {
                // The seam hands RAW state='proposed' rows (§proposal-list) — the module reshapes at
                // its edge. Mirror the retired WS handler's shape: parsed attrs/flags, tx body lifted.
                const s = this.#attached();
                const rows = await daemon.pendingProposals(s.sessionId) as unknown as Array<Record<string, unknown>>;
                const txBody = (tx: unknown): string => {
                    if (typeof tx !== "string" || tx.length === 0) return "";
                    try {
                        const parsed = JSON.parse(tx) as { body?: unknown };
                        if (typeof parsed.body === "string") return parsed.body;
                        const raw = (parsed.body as { raw?: unknown } | null)?.raw;
                        return typeof raw === "string" ? raw : "";
                    } catch { return ""; }
                };
                return { proposals: rows.map((r) => ({
                    logEntryId: r.logEntryId, runId: r.runId, loopId: r.loopId, turnId: r.turnId,
                    op: r.op, suffix: r.suffix,
                    target: { scheme: r.scheme ?? null, pathname: r.pathname ?? null },
                    body: txBody(r.tx),
                    attrs: JSON.parse((r.attrs as string | null) ?? "{}") as Record<string, unknown>,
                    flags: JSON.parse((r.loop_flags as string | null) ?? "{}") as Record<string, unknown>,
                    at: r.at,
                })) };
            }
            case "log.read": {
                // Default = the connection's OWN (client) run — §machine-processes; the model run is
                // read by explicit runId (loop.run returns modelRunId for exactly that).
                const s = this.#attached();
                const runId = (p.runId as number | undefined) ?? s.runId;
                const entries = await daemon.readLog({ sessionId: s.sessionId, runId, ...(p as object) });
                return { status: 200, entries };
            }
            case "entry.read": {
                const s = this.#attached();
                return daemon.readEntry({ sessionId: s.sessionId, target: p.target as string, channel: p.channel as string | undefined, offset: p.offset as number | undefined });
            }
            case "run.fork": {
                // fork branches an EXISTING model run — no run yet is a caller error, never an implicit create.
                const s = this.#attached();
                const runId = (p.runId as number | undefined) ?? s.modelRunId;
                if (runId === null || runId === undefined) throw new Error("run.fork: no model run to fork — loop.run first");
                return daemon.forkRun({ sessionId: s.sessionId, runId, name: p.name as string | undefined });
            }
            case "session.rename": {
                const s = this.#attached();
                return daemon.renameSession(s.sessionId, p.name as string);
            }
            case "session.list": return { sessions: await daemon.listSessions() };
            case "session.runs": { const sid = ((p.sessionId ?? p.id) as number | undefined) ?? this.#attached().sessionId; return { runs: await daemon.listRuns(sid) }; }
            case "session.prompts": {
                if (p.limit !== undefined && (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1)) {
                    throw new Error("session.prompts: limit must be a positive integer");
                }
                const sid = ((p.sessionId ?? p.id) as number | undefined) ?? this.#attached().sessionId;
                return { prompts: await daemon.listPrompts(sid, (p.limit as number | undefined) ?? 100) };
            }
            case "session.members": { const s = this.#attached(); return { members: await daemon.listMembers(s.sessionId) }; }
            case "session.constraints": { const s = this.#attached(); return { constraints: await daemon.listConstraints(s.sessionId) }; }
            case "session.constrain": { const s = this.#attached(); return daemon.constrain(s.sessionId, p.effect as string, p.glob as string); }
            case "session.unconstrain": { const s = this.#attached(); return daemon.unconstrain(s.sessionId, p.effect as string, p.glob as string); }
            case "providers.list": return daemon.listProviders();
            case "op.look": {
                const s = this.#attached();
                const statement = Dsl.parseSingleStatement(p.text as string);
                return daemon.look({ sessionId: s.sessionId, runId: s.runId, statement });
            }
            case "op.parse": {
                // Parse text, dispatch each statement, surface parse failures as 400 results.
                const s = this.#attached();
                const { statements, errors } = Dsl.parseAllStatements(p.text as string);
                const results: Array<{ status: number; [k: string]: unknown }> = [];
                for (const statement of statements) results.push(await daemon.dispatchAsClient({ sessionId: s.sessionId, runId: s.runId, statement }));
                for (const e of errors) results.push({ status: 400, error: e.message, position: { type: "content-offset", line: e.line, column: e.column } });
                return { results };
            }
            case "op.dispatch": {
                const s = this.#attached();
                return daemon.dispatchAsClient({ sessionId: s.sessionId, runId: s.runId, statement: p.statement as PlurnkStatement });
            }
            case "op.edit": case "op.send": case "op.read": case "op.find":
            case "op.copy": case "op.move": case "op.open": case "op.fold": case "op.exec": {
                // Structured params → the Dsl builder family — the exact edge the retired op_* handlers ran.
                const s = this.#attached();
                const build: Record<string, (q: never) => PlurnkStatement> = {
                    "op.edit": Dsl.buildEdit, "op.read": Dsl.buildRead, "op.find": Dsl.buildFind,
                    "op.send": Dsl.buildSend, "op.copy": Dsl.buildCopy, "op.move": Dsl.buildMove,
                    "op.open": Dsl.buildOpen, "op.fold": Dsl.buildFold, "op.exec": Dsl.buildExec,
                };
                const statement = build[method](p as never);
                return daemon.dispatchAsClient({ sessionId: s.sessionId, runId: s.runId, statement });
            }
            default:
                throw new Error(`method not found: ${method}`);
        }
    }
}
