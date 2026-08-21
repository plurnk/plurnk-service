// Test-only JSON-RPC-shaped adapter over CoreSeam. It is harness plumbing, not a
// product protocol or AG-UI projection; client parsing remains AG-UI-owned.
// {§methods} {§agui-op-parse}
// It holds the attached envelope, lazy model-worker binding, and workspace-filtered
// notification fan-in that integration tests need.
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
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
    #modelWorkerId: number | null = null;
    #closed = false;

    constructor(daemon: Daemon) {
        this.#daemon = daemon;
        // The one event pipe: seam events arrive (workspaceId | null, method, params) and re-emit as
        // JSON-RPC notifications, filtered the way the WS connection was — my workspace's + globals.
        this.#unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => {
            if (this.#closed) return;
            if (workspaceId !== null && this.#workspace !== null && workspaceId !== this.#workspace.workspaceId) return;
            if (workspaceId !== null && this.#workspace === null) return;
            // {§notifications-envelope-carries-workspaceid} — the envelope stamps the scope, as the WS did.
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
                this.#modelWorkerId = null;
                return { id: envelope.workspaceId, name: envelope.workspaceName, workerId: envelope.workerId, workerName: envelope.workerName, projectRoot: envelope.projectRoot };
            }
            case "workspace.attach": {
                const envelope = await daemon.attachWorkspace({ workspaceId: (p.workspaceId ?? p.id) as number, workerId: p.workerId as number | undefined, workerName: p.workerName as string | undefined });
                this.#workspace = envelope;
                this.#modelWorkerId = null;
                return { id: envelope.workspaceId, name: envelope.workspaceName, workerId: envelope.workerId, workerName: envelope.workerName, projectRoot: envelope.projectRoot };
            }
            case "loop.run": {
                const s = this.#attached();
                const modelWorkerId = this.#modelWorkerId ?? await daemon.ensureModelWorker(s.workspaceId);
                this.#modelWorkerId = modelWorkerId;
                const loop = await daemon.runLoop({
                    workspaceId: s.workspaceId, workerId: modelWorkerId, prompt: p.prompt as string,
                    ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns as number } : {}),
                    ...(p.flags !== undefined ? { flags: p.flags as { auto?: boolean } } : {}),
                    ...(p.openPaths !== undefined ? { openPaths: p.openPaths as string[] } : {}),
                    ...(p.selector !== undefined ? { selector: p.selector as string } : {}),
                    ...(p.childSelector !== undefined ? { childSelector: p.childSelector as string | null } : {}),
                });
                return { ...loop, modelWorkerId };
            }
            case "loop.inject": {
                // inject speaks to an EXISTING model worker; the seam's runLoop injects into a live
                // drain identically (daemon.inject under both) — refusing only a new loop start.
                const s = this.#attached();
                if (this.#modelWorkerId === null) {
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
                const result = await daemon.runLoop({
                    workspaceId: s.workspaceId, workerId: this.#modelWorkerId, prompt: p.prompt as string,
                    ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns as number } : {}),
                    ...(p.flags !== undefined ? { flags: p.flags as { auto?: boolean } } : {}),
                    ...(p.selector !== undefined ? { selector: p.selector as string } : {}),
                    ...(p.childSelector !== undefined ? { childSelector: p.childSelector as string | null } : {}),
                });
                return { ...result, modelWorkerId: this.#modelWorkerId };
            }
            case "loop.cancel": {
                this.#attached();
                const reason = (typeof p.reason === "string" && p.reason.length > 0) ? p.reason : "user_cancelled";
                const modelWorkerId = this.#modelWorkerId;
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
                const s = this.#attached();
                return { proposals: await daemon.pendingProposals(s.workspaceId) };
            }
            case "log.read": {
                // Default = the connection's own client worker — {§machine-processes}; the model worker is
                // read by explicit workerId (loop.run returns modelWorkerId for exactly that).
                const s = this.#attached();
                const workerId = (p.workerId as number | undefined) ?? s.workerId;
                const entries = await daemon.readLog({ workspaceId: s.workspaceId, workerId, ...(p as object) });
                return { status: 200, entries };
            }
            case "entry.read": {
                const s = this.#attached();
                const workerId = (p.workerId as number | undefined) ?? this.#modelWorkerId ?? s.workerId;
                return daemon.readEntry({ workspaceId: s.workspaceId, workerId, target: p.target as string, channel: p.channel as string | undefined, offset: p.offset as number | undefined });
            }
            case "run.fork": {
                // fork branches an EXISTING model worker — no worker yet is a caller error, never an implicit create.
                const s = this.#attached();
                const workerId = (p.workerId as number | undefined) ?? this.#modelWorkerId;
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
