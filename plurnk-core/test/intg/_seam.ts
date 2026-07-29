// #364 — the harness rides the CoreSeam. SeamSocket mimics the retired WS connection's surface
// (send/on/once/off/close + JSON-RPC 'message' events) but every method dispatches DIRECTLY into
// the daemon's seam — the same contract agui consumes — so the whole intg tier certifies the one
// client surface and nothing else. No socket, no port, no bonus surface for a capability to creep
// onto: a method not on the seam is not reachable from a test.
//
// The shim holds the CLIENT state a transport module holds at its edge (the attached envelope,
// the lazily-resolved model worker) and the protocol niceties tests rely on (JSON-RPC envelopes,
// notification fan-in via subscribeToEvents filtered to the attached workspace).
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import Dsl from "./dsl.ts";
import type Daemon from "../../src/server/Daemon.ts";
import type { ClientEnvelope } from "../../src/server/envelope.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";

type Listener = (data: string) => void;

export default class SeamSocket {
    #daemon: Daemon;
    #listeners = new Map<string, Set<Listener>>();
    #unsubscribe: () => void;
    #workspace: ClientEnvelope | null = null;
    #closed = false;

    constructor(daemon: Daemon) {
        this.#daemon = daemon;
        // The one event pipe: seam events arrive (workspaceId | null, method, params) and re-emit as
        // JSON-RPC notifications, filtered the way the WS connection was — my workspace's + globals.
        this.#unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => {
            if (this.#closed) return;
            if (workspaceId !== null && this.#workspace !== null && workspaceId !== this.#workspace.workspaceId) return;
            if (workspaceId !== null && this.#workspace === null) return;
            // §notifications-envelope-carries-workspaceid — the envelope stamps the scope, as the WS did.
            const scoped = workspaceId !== null && params !== null && typeof params === "object" ? { ...params, workspaceId } : params;
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
                if (err instanceof OperationFailureError) {
                    this.#emit("message", JSON.stringify({ jsonrpc: "2.0", id, result: err.result }));
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                this.#emit("message", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }));
            },
        );
    }

    #emit(event: string, data: string): void {
        for (const cb of [...(this.#listeners.get(event) ?? [])]) cb(data);
    }

    #attached(): ClientEnvelope {
        if (this.#workspace === null) throw new Error("no attached workspace — workspace.create/workspace.attach first");
        return this.#workspace;
    }

    // --- the method map: every RPC name a test speaks → its seam call ---
    async #dispatch(method: string, params: object): Promise<unknown> {
        const p = params as Record<string, unknown>;
        const daemon = this.#daemon;
        switch (method) {
            case "workspace.create": {
                const envelope = await daemon.createWorkspace({
                    name: p.name as string | undefined,
                    projectRoot: (p.projectRoot as string | null | undefined) ?? null,
                    settings: p.settings as string | object | undefined,
                    constraints: p.constraints as Array<{ effect: string; glob: string }> | undefined,
                });
                this.#workspace = envelope;
                return { id: envelope.workspaceId, name: envelope.workspaceName, workerId: envelope.workerId, workerName: envelope.workerName, projectRoot: envelope.projectRoot };
            }
            case "workspace.attach": {
                const envelope = await daemon.attachWorkspace({ workspaceId: (p.workspaceId ?? p.id) as number, workerId: p.workerId as number | undefined, workerName: p.workerName as string | undefined });
                this.#workspace = envelope;
                return { id: envelope.workspaceId, name: envelope.workspaceName, workerId: envelope.workerId, workerName: envelope.workerName, projectRoot: envelope.projectRoot };
            }
            case "loop.run": {
                const s = this.#attached();
                if (s.modelWorkerId === null) s.modelWorkerId = await daemon.ensureModelWorker(s.workspaceId);
                const run = await daemon.runLoop({
                    workspaceId: s.workspaceId, workerId: s.modelWorkerId, prompt: p.prompt as string,
                    ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns as number } : {}),
                    ...(p.flags !== undefined ? { flags: p.flags as { auto?: boolean } } : {}),
                    ...(p.openPaths !== undefined ? { openPaths: p.openPaths as string[] } : {}),
                    ...(p.alias !== undefined ? { alias: p.alias as string } : {}),
                    ...(p.model !== undefined ? { model: p.model as string } : {}),
                });
                return { ...run, modelWorkerId: s.modelWorkerId };
            }
            case "loop.inject": {
                // inject speaks to an EXISTING model worker; the seam's runLoop injects into a live
                // drain identically (daemon.inject under both) — refusing only the run-start.
                const s = this.#attached();
                if (s.modelWorkerId === null) {
                    throw new OperationFailureError(Results.failure(
                        "daemon:worker",
                        "model-worker-required",
                        409,
                        "No model worker exists for prompt injection.",
                        {},
                        {
                            stage: "loop-injection",
                            recovery: "Start a loop before injecting a prompt.",
                            retryable: false,
                        },
                    ));
                }
                const run = await daemon.runLoop({
                    workspaceId: s.workspaceId, workerId: s.modelWorkerId, prompt: p.prompt as string,
                    ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns as number } : {}),
                    ...(p.flags !== undefined ? { flags: p.flags as { auto?: boolean } } : {}),
                    ...(p.alias !== undefined ? { alias: p.alias as string } : {}),
                    ...(p.model !== undefined ? { model: p.model as string } : {}),
                });
                return { ...run, modelWorkerId: s.modelWorkerId };
            }
            case "loop.cancel": {
                const s = this.#attached();
                const reason = (typeof p.reason === "string" && p.reason.length > 0) ? p.reason : "user_cancelled";
                const modelWorkerId = s.modelWorkerId;
                const cancelled = modelWorkerId !== null && daemon.cancelDrain(modelWorkerId, reason);
                return { cancelled, workerId: modelWorkerId, reason };
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
                const rows = await daemon.pendingProposals(s.workspaceId) as unknown as Array<Record<string, unknown>>;
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
                    logEntryId: r.logEntryId, workerId: r.workerId, loopId: r.loopId, turnId: r.turnId,
                    op: r.op, suffix: r.suffix,
                    target: { scheme: r.scheme ?? null, pathname: r.pathname ?? null },
                    body: txBody(r.tx),
                    attrs: JSON.parse((r.attrs as string | null) ?? "{}") as Record<string, unknown>,
                    flags: JSON.parse((r.loop_flags as string | null) ?? "{}") as Record<string, unknown>,
                    at: r.at,
                })) };
            }
            case "log.read": {
                // Default = the connection's OWN (client) run — §machine-processes; the model worker is
                // read by explicit workerId (loop.run returns modelWorkerId for exactly that).
                const s = this.#attached();
                const workerId = (p.workerId as number | undefined) ?? s.workerId;
                const entries = await daemon.readLog({ workspaceId: s.workspaceId, workerId, ...(p as object) });
                return { status: 200, entries };
            }
            case "entry.read": {
                const s = this.#attached();
                return daemon.readEntry({ workspaceId: s.workspaceId, target: p.target as string, channel: p.channel as string | undefined, offset: p.offset as number | undefined });
            }
            case "run.fork": {
                // fork branches an EXISTING model worker — no worker yet is a caller error, never an implicit create.
                const s = this.#attached();
                const workerId = (p.workerId as number | undefined) ?? s.modelWorkerId;
                if (workerId === null || workerId === undefined) {
                    throw new OperationFailureError(Results.failure(
                        "daemon:worker",
                        "model-worker-required",
                        409,
                        "No model worker exists to fork.",
                        {},
                        {
                            stage: "worker-fork",
                            recovery: "Start a loop before forking its worker.",
                            retryable: false,
                        },
                    ));
                }
                return daemon.forkWorker({ workspaceId: s.workspaceId, workerId, name: p.name as string | undefined });
            }
            case "workspace.rename": {
                const s = this.#attached();
                return daemon.renameWorkspace(s.workspaceId, p.name as string);
            }
            case "workspace.list": return { workspaces: await daemon.listWorkspaces() };
            case "workspace.workers": { const sid = ((p.workspaceId ?? p.id) as number | undefined) ?? this.#attached().workspaceId; return { workers: await daemon.listWorkers(sid) }; }
            case "workspace.prompts": {
                const sid = ((p.workspaceId ?? p.id) as number | undefined) ?? this.#attached().workspaceId;
                return { prompts: await daemon.listPrompts(sid, p.limit as number | undefined) };
            }
            case "workspace.members": { const s = this.#attached(); return { members: await daemon.listMembers(s.workspaceId) }; }
            case "workspace.constraints": { const s = this.#attached(); return { constraints: await daemon.listConstraints(s.workspaceId) }; }
            case "workspace.constrain": { const s = this.#attached(); return daemon.constrain(s.workspaceId, p.effect as string, p.glob as string); }
            case "workspace.unconstrain": { const s = this.#attached(); return daemon.unconstrain(s.workspaceId, p.effect as string, p.glob as string); }
            case "providers.list": return daemon.listProviders();
            case "op.look": {
                const s = this.#attached();
                const statement = Dsl.parseSingleStatement(p.text as string);
                return daemon.look({ workspaceId: s.workspaceId, workerId: s.workerId, statement });
            }
            case "op.parse": {
                // Parse text, dispatch each statement, surface parse failures as 400 results.
                const s = this.#attached();
                const { statements, errors } = Dsl.parseAllStatements(p.text as string);
                const results: Array<{ status: number; [k: string]: unknown }> = [];
                for (const statement of statements) results.push(await daemon.dispatchAsClient({ workspaceId: s.workspaceId, workerId: s.workerId, statement }));
                for (const e of errors) {
                    results.push(Results.failure(
                        "daemon:input",
                        "parse-failed",
                        400,
                        e.message,
                        {},
                        {
                            context: "op.parse",
                            stage: "parsing",
                            line: e.line,
                            column: e.column,
                            recovery: "Correct the statement at the reported position.",
                            retryable: false,
                        },
                    ));
                }
                return { results };
            }
            case "op.dispatch": {
                const s = this.#attached();
                return daemon.dispatchAsClient({ workspaceId: s.workspaceId, workerId: s.workerId, statement: p.statement as PlurnkStatement });
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
                return daemon.dispatchAsClient({ workspaceId: s.workspaceId, workerId: s.workerId, statement });
            }
            default:
                throw new Error(`method not found: ${method}`);
        }
    }
}
