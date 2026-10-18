// The AG-UI built-in actions: the management-plane calls a client makes by name. Split out of the module.
import { type ActionOutcome } from "./AguiPlus.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Problems, UNKNOWN_POSITION, Validator, type AguiDiscovery, type CapabilityPolicy, type ClientEnvelope, type ExecStatement, type OperationResult, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { actionFailure } from "./action-results.ts";
import MessageAddress from "./MessageAddress.ts";
import type { RunAgentInput } from "./types.ts";

// {§agui-broadcast-fan} What a client operation's Run hears: the loop its dispatch opened, before any statement runs.
export type OperationLoopListener = (loop: { readonly workerId: number; readonly loopId: number }) => void;

const operationOutcome = (result: OperationResult): ActionOutcome => {
    const exact = Validator.assertOperationResult(result);
    return exact.problem === undefined
        ? { ok: true, result: exact }
        : { ok: false, problem: exact.problem };
};

const parseFailureResult = ({
    detail,
    line,
    column,
    source,
    severity,
}: {
    detail: string;
    line: number;
    column: number;
    source: string;
    severity: "error" | "warning";
}): OperationResult => ({
    status: 400,
    problem: Problems.create(
        "agui:action",
        "parse-failed",
        400,
        detail,
        {
            line,
            column,
            source,
            severity,
            stage: "parsing",
            retryable: false,
        },
    ),
});

// {§module-seam-slices} — the calls the built-in actions make.
export type BuiltinActionsPort = Pick<
    ApplicationPort,
    | "attachWorkspace"
    | "cancelDrain"
    | "createWorkspace"
    | "dispatchClientAction"
    | "executorTags"
    | "forkWorker"
    | "listModels"
    | "listPrompts"
    | "listProviders"
    | "listWorkers"
    | "listWorkspaces"
    | "readEntry"
    | "readLog"
    | "readWorkerEffort"
    | "readWorkerModel"
    | "readWorkspaceCapabilities"
    | "renameWorkspace"
    | "rollback"
    | "runLoop"
    | "setWorkerEffort"
    | "setWorkerModel"
    | "setWorkerSpawnModel"
    | "setWorkspaceCapabilities"
    | "shareWorkspace"
>;

export default class BuiltinActions {
    // {§agui-action-binding} A worker action runs only after its Run bound the thread's worker.
    static #bound(workerId: number | undefined): number {
        if (workerId === undefined) throw new Error("a worker action reached execution without its worker");
        return workerId;
    }

    readonly #seam: () => BuiltinActionsPort;
    readonly #capabilities: () => Promise<AguiDiscovery>;
    readonly #namedWorkspace: (name: string, options?: Readonly<Record<string, unknown>>) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
    readonly #threadWorker: (threadId: string, workspaceId: number, forwarded?: Record<string, unknown>) => Promise<number | undefined>;
    readonly #requireWorkspace: (kind: string, env: ClientEnvelope | null) => ClientEnvelope;

    constructor({ seam, capabilities, namedWorkspace, threadWorker, requireWorkspace }: {
        seam: () => BuiltinActionsPort;
        capabilities: () => Promise<AguiDiscovery>;
        namedWorkspace: (name: string, options?: Readonly<Record<string, unknown>>) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
        threadWorker: (threadId: string, workspaceId: number, forwarded?: Record<string, unknown>) => Promise<number | undefined>;
        requireWorkspace: (kind: string, env: ClientEnvelope | null) => ClientEnvelope;
    }) {
        this.#seam = seam;
        this.#capabilities = capabilities;
        this.#namedWorkspace = namedWorkspace;
        this.#threadWorker = threadWorker;
        this.#requireWorkspace = requireWorkspace;
    }

    // {§agui-client-operation} A person's client operation: the thread's owner acting, reading `log:///` in the
    // thread's model worker when it exists, and announcing its loop to the Run that observes it.
    async #clientOperation(
        input: RunAgentInput,
        workspace: ClientEnvelope,
        principal: string,
        statements: PlurnkStatement[],
        onLoop: OperationLoopListener | undefined,
    ): Promise<OperationResult[]> {
        const forwarded = (input.forwardedProps as { plurnk?: Record<string, unknown> } | undefined)?.plurnk;
        const contextWorkerId = await this.#threadWorker(input.threadId, workspace.workspaceId, forwarded);
        return await this.#seam().dispatchClientAction({
            workspaceId: workspace.workspaceId,
            actor: MessageAddress.owner(principal, input.threadId),
            ...(contextWorkerId === undefined ? {} : { contextWorkerId }),
            statements,
            ...(onLoop === undefined ? {} : { onLoop }),
        });
    }

    // The built-in implementation half of the declarative registry. The registry
    // owns membership, scope, admission, projection, and discovery; this dispatch
    // owns only the corresponding daemon operation.
    async executeBuiltin(
        kind: string,
        p: Readonly<Record<string, unknown>>,
        input: RunAgentInput,
        env: ClientEnvelope | null,
        boundWorkerId?: number,
        principal = "anonymous",
        onLoop?: OperationLoopListener,
    ): Promise<ActionOutcome> {
        try {
            // Daemon actions never bind or forge a workspace.
            switch (kind) {
                case "ping": return { ok: true, result: {} };
                case "discover": return { ok: true, result: await this.#capabilities() };
                case "providers.list": return { ok: true, result: this.#seam().listProviders() };
                case "models.list": {
                    return { ok: true, result: this.#seam().listModels(Validator.assertModelCatalogQuery(p)) };
                }
                case "workspace.list": return { ok: true, result: { workspaces: await this.#seam().listWorkspaces() } };
                case "workspace.create": {
                    // An explicit name selects exactly that workspace; otherwise core names it.
                    if (Object.hasOwn(p, "name") && (typeof p.name !== "string" || p.name.length === 0)) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.create name is not a non-empty string.",
                            400,
                            { field: "name", recovery: "Provide a non-empty workspace name or omit it." },
                        );
                    }
                    if (typeof p.name === "string") {
                        const { env: created } = await this.#namedWorkspace(p.name, p);
                        return { ok: true, result: { id: created.workspaceId, name: created.workspaceName } };
                    }
                    const created = await this.#seam().createWorkspace({
                        ...(Object.hasOwn(p, "projectRoot")
                            ? { projectRoot: p.projectRoot as string | null }
                            : {}),
                        ...(Object.hasOwn(p, "constraints")
                            ? { constraints: p.constraints as Array<{ effect: string; glob: string }> }
                            : {}),
                        ...(Object.hasOwn(p, "settings")
                            ? { settings: p.settings as string | object }
                            : {}),
                    });
                    return { ok: true, result: { id: created.workspaceId, name: created.workspaceName } };
                }
                case "workspace.attach": {
                    // The registry admits exactly one selector; core owns its interpretation.
                    const att = await this.#seam().attachWorkspace(typeof p.id === "number"
                        ? { workspaceId: p.id }
                        : typeof p.name === "string" ? { name: p.name } : { projectRoot: p.projectRoot as string });
                    return { ok: true, result: { id: att.workspaceId, name: att.workspaceName } };
                }
            }
            const workspace = this.#requireWorkspace(kind, env);
            switch (kind) {
                case "workspace.workers": return { ok: true, result: { workers: await this.#seam().listWorkers(typeof p.id === "number" ? p.id : workspace.workspaceId) } };
                case "log.read": {
                    // Default worker: the bound worker; p.workerId pins another.
                    const readWorkerId = typeof p.workerId === "number" ? p.workerId : BuiltinActions.#bound(boundWorkerId);
                    const entries = await this.#seam().readLog({
                        workspaceId: workspace.workspaceId,
                        workerId: readWorkerId,
                        ...(Object.hasOwn(p, "limit") ? { limit: p.limit as number } : {}),
                        ...(Object.hasOwn(p, "sinceId") ? { sinceId: p.sinceId as number } : {}),
                        ...(Object.hasOwn(p, "loopId") ? { loopId: p.loopId as number } : {}),
                        ...(Object.hasOwn(p, "turnId") ? { turnId: p.turnId as number } : {}),
                        ...(Object.hasOwn(p, "loopSeq") ? { loopSeq: p.loopSeq as number } : {}),
                        ...(Object.hasOwn(p, "turnSeq") ? { turnSeq: p.turnSeq as number } : {}),
                        ...(Object.hasOwn(p, "sequence") ? { sequence: p.sequence as number } : {}),
                    });
                    return { ok: true, result: { entries } };
                }
                case "loop.inject": {
                    if (typeof p.prompt !== "string" || p.prompt.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "loop.inject requires a non-empty prompt.",
                            400,
                            { field: "prompt", recovery: "Provide the prompt to inject." },
                        );
                    }
                    const ack = await this.#seam().runLoop({
                        workspaceId: workspace.workspaceId,
                        workerId: BuiltinActions.#bound(boundWorkerId),
                        prompt: p.prompt,
                        ...MessageAddress.submission(principal, input, { id: crypto.randomUUID(), role: "user", content: p.prompt }),
                    });
                    return operationOutcome(ack);
                }
                // The stop control (TUI /stop + Ctrl-C): abort the model worker's active drain.
                // The one cancellation: a hangup ends delivery only ({§agui-run-disconnect}).
                case "loop.cancel": return { ok: true, result: { cancelled: this.#seam().cancelDrain(
                    BuiltinActions.#bound(boundWorkerId),
                    typeof p.reason === "string" ? p.reason : undefined,
                ) } };
                // Default worker: the bound worker; p.workerId pins another — the log.read shape.
                case "workspace.prompts": return {
                    ok: true,
                    result: {
                        prompts: await this.#seam().listPrompts(
                            workspace.workspaceId,
                            Object.hasOwn(p, "limit") ? p.limit as number : undefined,
                            typeof p.workerId === "number" ? p.workerId : BuiltinActions.#bound(boundWorkerId),
                        ),
                    },
                };
                case "workspace.share": return { ok: true, result: await this.#seam().shareWorkspace({ workspaceId: workspace.workspaceId, folder: p.folder as string }) };
                case "workspace.rename": {
                    if (typeof p.name !== "string" || p.name.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.rename requires a non-empty name.",
                            400,
                            { field: "name", recovery: "Provide the new workspace name." },
                        );
                    }
                    return { ok: true, result: await this.#seam().renameWorkspace(workspace.workspaceId, p.name) };
                }
                // {§rollback} — the bound worker's log, or a named worker's; the reversals are one client
                // operation of this thread's owner ({§connection-lifecycle}).
                case "workspace.rollback": {
                    if (typeof p.to !== "string" || p.to.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.rollback requires a log coordinate.",
                            400,
                            { field: "to", recovery: "Name the coordinate as <loop>/<turn>/<item>." },
                        );
                    }
                    if (Object.hasOwn(p, "workerId")
                        && (typeof p.workerId !== "number" || !Number.isSafeInteger(p.workerId) || p.workerId <= 0)) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.rollback workerId must be a positive integer.",
                            400,
                            { field: "workerId", recovery: "Name a worker of this workspace, or omit it for the bound worker." },
                        );
                    }
                    return { ok: true, result: await this.#seam().rollback({
                        workspaceId: workspace.workspaceId,
                        workerId: typeof p.workerId === "number" ? p.workerId : BuiltinActions.#bound(boundWorkerId),
                        actor: MessageAddress.owner(principal, input.threadId),
                        to: p.to,
                    }) };
                }
                case "entry.read": {
                    if (typeof p.target !== "string") {
                        return actionFailure(
                            "invalid-action-parameters",
                            "entry.read requires a string target.",
                            400,
                            { field: "target", recovery: "Provide an entry URI." },
                        );
                    }
                    if (Object.hasOwn(p, "workerId")
                        && (typeof p.workerId !== "number" || !Number.isSafeInteger(p.workerId) || p.workerId <= 0)) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "entry.read workerId must be a positive integer.",
                            400,
                            { field: "workerId", recovery: "Use the workerId supplied with the entry notification." },
                        );
                    }
                    const result = Validator.assertEntryReadResult(await this.#seam().readEntry({
                        workspaceId: workspace.workspaceId,
                        workerId: typeof p.workerId === "number"
                            ? p.workerId
                            : BuiltinActions.#bound(boundWorkerId),
                        target: p.target,
                        ...(Object.hasOwn(p, "channel") ? { channel: p.channel as string } : {}),
                        ...(Object.hasOwn(p, "offset") ? { offset: p.offset as number } : {}),
                    }));
                    return operationOutcome(result);
                }
                case "op.exec": {
                    // An execution constructed structurally (no DSL text): the model-facing shape.
                    if (typeof p.command !== "string" || p.command.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.exec requires a non-empty command.",
                            400,
                            { field: "command", recovery: "Provide the command to execute." },
                        );
                    }
                    const statement: ExecStatement = {
                        runtime: "sh", aside: null, target: null,
                        metadata: null, lineMarker: null, body: p.command, position: UNKNOWN_POSITION,
                    };
                    const [result] = await this.#clientOperation(input, workspace, principal, [statement], onLoop);
                    if (result === undefined) throw new Error("op.exec dispatch returned no operation result");
                    return operationOutcome(result);
                }
                case "op.parse": {
                    // Raw DSL is parsed at the module's edge; statements and parser facts project
                    // through one ordered result contract. {§agui-op-parse}
                    if (typeof p.text !== "string" || p.text.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.parse requires non-empty PLURNK text.",
                            400,
                            { field: "text", recovery: "Provide PLURNK statements to parse." },
                        );
                    }
                    const parsed = PlurnkParser.parseStatements(p.text, { executors: this.#seam().executorTags(workspace.workspaceId) });
                    const results: Array<OperationResult | null> = [];
                    const statements: PlurnkStatement[] = [];
                    for (const item of parsed.items) {
                        if (item.kind === "error") {
                            results.push(parseFailureResult({
                                detail: item.error.message,
                                line: item.error.line,
                                column: item.error.column,
                                source: item.error.source,
                                severity: item.error.severity,
                            }));
                            continue;
                        }
                        if (item.kind === "statement") {
                            statements.push(item.statement);
                            results.push(null);
                        }
                    }
                    if (parsed.unparsedTail !== undefined) {
                        results.push(parseFailureResult({
                            detail: parsed.unparsedTail.reason,
                            line: parsed.unparsedTail.from.line,
                            column: parsed.unparsedTail.from.column,
                            source: "grammar",
                            severity: "error",
                        }));
                    }
                    const dispatched = statements.length === 0
                        ? []
                        : await this.#clientOperation(input, workspace, principal, statements, onLoop);
                    let index = 0;
                    for (let i = 0; i < results.length; i++) {
                        if (results[i] === null) results[i] = dispatched[index++];
                    }
                    return { ok: true, result: { results } };
                }
                case "run.fork": return { ok: true, result: await this.#seam().forkWorker({ workspaceId: workspace.workspaceId, workerId: BuiltinActions.#bound(boundWorkerId), ...(typeof p.name === "string" ? { name: p.name } : {}) }) };
                case "worker.model.get": {
                    const { model, spawnModel } = await this.#seam().readWorkerModel({
                        workspaceId: workspace.workspaceId,
                        workerId: BuiltinActions.#bound(boundWorkerId),
                    });
                    return { ok: true, result: { model, spawnModel } };
                }
                case "worker.model.set": {
                    if (typeof p.selector !== "string" || p.selector.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "worker.model.set requires a selector.",
                            400,
                            { recovery: "Provide a declared alias or provider/model route." },
                        );
                    }
                    return { ok: true, result: await this.#seam().setWorkerModel({
                        workspaceId: workspace.workspaceId,
                        workerId: BuiltinActions.#bound(boundWorkerId),
                        selector: p.selector,
                        ...(p.effort === undefined ? {} : { effort: p.effort }),
                    }) };
                }
                case "worker.child.set": {
                    if (!Object.hasOwn(p, "selector")
                        || (p.selector !== null && (typeof p.selector !== "string" || p.selector.length === 0))) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "worker.child.set requires a selector.",
                            400,
                            { recovery: "Provide a declared alias or provider/model route; null means inherit." },
                        );
                    }
                    return { ok: true, result: await this.#seam().setWorkerSpawnModel({
                        workspaceId: workspace.workspaceId,
                        workerId: BuiltinActions.#bound(boundWorkerId),
                        selector: p.selector,
                    }) };
                }
                case "worker.effort.get": {
                    return { ok: true, result: await this.#seam().readWorkerEffort({
                        workspaceId: workspace.workspaceId,
                        workerId: BuiltinActions.#bound(boundWorkerId),
                    }) };
                }
                case "worker.effort.set": {
                    if (!Object.hasOwn(p, "effort")) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "worker.effort.set requires an effort.",
                            400,
                            { recovery: "Provide an effort." },
                        );
                    }
                    return { ok: true, result: await this.#seam().setWorkerEffort({
                        workspaceId: workspace.workspaceId,
                        workerId: BuiltinActions.#bound(boundWorkerId),
                        effort: p.effort,
                    }) };
                }
                case "workspace.capabilities.get": {
                    return { ok: true, result: await this.#seam().readWorkspaceCapabilities({
                        workspaceId: workspace.workspaceId,
                    }) };
                }
                case "workspace.capabilities.set": {
                    return { ok: true, result: await this.#seam().setWorkspaceCapabilities({
                        workspaceId: workspace.workspaceId,
                        policy: p.policy as CapabilityPolicy,
                    }) };
                }
                default: throw new Error(`AG-UI built-in '${kind}' has no executor`);
            }
        } catch (err) {
            const problem = Problems.fromError(err);
            if (problem !== null) return { ok: false, problem };
            console.error(`AG-UI action '${kind}' failed:`, err);
            return actionFailure("action-failed", "The action failed unexpectedly.", 500);
        }
    }

}
