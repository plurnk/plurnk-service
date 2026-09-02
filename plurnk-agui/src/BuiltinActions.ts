// The AG-UI built-in actions: the management-plane calls a client makes by name. Split out of the module.
import { type ActionOutcome } from "./AguiPlus.ts";
import { Problems, PlurnkParser, UNKNOWN_POSITION, Validator, type AguiDiscovery, type ApplicationPort, type CapabilityPolicy, type ClientEnvelope, type ExecStatement, type OperationResult, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { actionFailure, problemFromError } from "./action-results.ts";

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

export default class BuiltinActions {
    readonly #seam: () => ApplicationPort;
    readonly #capabilities: () => Promise<AguiDiscovery>;
    readonly #envelope: (threadId: string, forwarded?: Record<string, unknown>) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
    readonly #requireWorkspace: (kind: string, env: ClientEnvelope | null) => ClientEnvelope;

    constructor({ seam, capabilities, envelope, requireWorkspace }: {
        seam: () => ApplicationPort;
        capabilities: () => Promise<AguiDiscovery>;
        envelope: (threadId: string, forwarded?: Record<string, unknown>) => Promise<{ env: ClientEnvelope; reattached: boolean }>;
        requireWorkspace: (kind: string, env: ClientEnvelope | null) => ClientEnvelope;
    }) {
        this.#seam = seam;
        this.#capabilities = capabilities;
        this.#envelope = envelope;
        this.#requireWorkspace = requireWorkspace;
    }

    // The built-in implementation half of the declarative registry. The registry
    // owns membership, scope, admission, projection, and discovery; this dispatch
    // owns only the corresponding daemon operation.
    async executeBuiltin(
        kind: string,
        p: Readonly<Record<string, unknown>>,
        env: ClientEnvelope | null,
        conversationWorkerId?: number,
    ): Promise<ActionOutcome> {
        try {
            // Worldless actions never bind or forge a workspace.
            switch (kind) {
                case "ping": return { ok: true, result: {} };
                case "discover": return { ok: true, result: await this.#capabilities() };
                case "providers.list": return { ok: true, result: this.#seam().listProviders() };
                case "models.list": {
                    return { ok: true, result: this.#seam().listModels(Validator.assertModelCatalogQuery(p)) };
                }
                case "workspace.list": return { ok: true, result: { workspaces: await this.#seam().listWorkspaces() } };
                case "workspace.create": {
                    // The name IS the identity: an explicit name creates/attaches EXACTLY
                    // that workspace; no name = the daemon names it and the real name binds.
                    if (Object.hasOwn(p, "name") && (typeof p.name !== "string" || p.name.length === 0)) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.create name is not a non-empty string.",
                            400,
                            { field: "name", recovery: "Provide a non-empty workspace name or omit it." },
                        );
                    }
                    if (typeof p.name === "string") {
                        // The name IS the world here — feed it as the workspace so #envelope
                        // creates/attaches exactly it (p carries no `workspace` of its own).
                        const { env: created } = await this.#envelope(p.name, { ...p, workspace: p.name });
                        return { ok: true, result: { id: created.workspaceId, name: created.workspaceName, workerId: created.workerId } };
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
                    return { ok: true, result: { id: created.workspaceId, name: created.workspaceName, workerId: created.workerId } };
                }
                case "workspace.attach": {
                    // A REAL attach: rebind the thread map to the chosen workspace and hand
                    // back its envelope — the picker does what it says (the unwired kind +
                    // a nil-masking fallback produced the 2026-07-10 front-door disaster).
                    if (typeof p.id !== "number") {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.attach requires a numeric workspace id.",
                            400,
                            {
                                field: "id",
                                recovery: "Provide a workspace id returned by workspace.list.",
                            },
                        );
                    }
                    const att = await this.#seam().attachWorkspace({ workspaceId: p.id, ...(typeof p.workerId === "number" ? { workerId: p.workerId } : {}) });
                    return { ok: true, result: { id: att.workspaceId, name: att.workspaceName, workerId: att.workerId } };
                }
            }
            const world = this.#requireWorkspace(kind, env);
            switch (kind) {
                case "workspace.workers": return { ok: true, result: { workers: await this.#seam().listWorkers(typeof p.id === "number" ? p.id : world.workspaceId) } };
                case "log.read": {
                    // Default worker: the conversation; p.workerId pins another.
                    const readWorkerId = typeof p.workerId === "number" ? p.workerId : conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId);
                    const entries = await this.#seam().readLog({
                        workspaceId: world.workspaceId,
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
                    const ack = await this.#seam().runLoop({ workspaceId: world.workspaceId, workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId), prompt: p.prompt });
                    return operationOutcome(ack);
                }
                // The stop button (TUI /stop + Ctrl-C, nvim :PlurnkStop): abort the model
                // worker's active drain. Mirrors the SSE-hangup abort, addressable as a verb.
                case "loop.cancel": return { ok: true, result: { cancelled: this.#seam().cancelDrain(
                    conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                    typeof p.reason === "string" ? p.reason : undefined,
                ) } };
                case "workspace.prompts": return {
                    ok: true,
                    result: {
                        prompts: await this.#seam().listPrompts(
                            world.workspaceId,
                            Object.hasOwn(p, "limit") ? p.limit as number : undefined,
                        ),
                    },
                };
                case "workspace.rename": {
                    if (typeof p.name !== "string" || p.name.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "workspace.rename requires a non-empty name.",
                            400,
                            { field: "name", recovery: "Provide the new workspace name." },
                        );
                    }
                    return { ok: true, result: await this.#seam().renameWorkspace(world.workspaceId, p.name) };
                }
                case "workspace.derivation": return { ok: true, result: { status: this.#seam().workspaceDerivationStatus(world.workspaceId) } };
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
                        workspaceId: world.workspaceId,
                        workerId: typeof p.workerId === "number"
                            ? p.workerId
                            : conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                        target: p.target,
                        ...(Object.hasOwn(p, "channel") ? { channel: p.channel as string } : {}),
                        ...(Object.hasOwn(p, "offset") ? { offset: p.offset as number } : {}),
                    }));
                    return operationOutcome(result);
                }
                case "op.exec": {
                    // EXEC constructed structurally (no DSL text): the model-facing shape,
                    // proposal-gated by the engine like any client op.
                    if (typeof p.command !== "string" || p.command.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.exec requires a non-empty command.",
                            400,
                            { field: "command", recovery: "Provide the command to execute." },
                        );
                    }
                    const statement: ExecStatement = {
                        op: "EXEC", delimiter: "", annotation: null, target: null,
                        metadata: null, lineMarker: null, body: p.command, position: UNKNOWN_POSITION,
                    };
                    // Client ops journal as client-origin turns in the client worker (worker split:
                    // only LOOPS live in the model worker) and execute in the attached Worker's
                    // Functionality ({§actor-boundary-attached-functionality}).
                    const [result] = await this.#seam().dispatchClientAction({
                        workspaceId: world.workspaceId,
                        workerId: world.workerId,
                        functionalityWorkerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                        statements: [statement],
                    });
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
                    const parsed = PlurnkParser.parseClient(p.text);
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
                        if (item.kind !== "statement") continue; // interstitial text isn't dispatchable
                        statements.push(item.statement as unknown as PlurnkStatement);
                        results.push(null);
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
                        : await this.#seam().dispatchClientAction({
                            workspaceId: world.workspaceId,
                            workerId: world.workerId,
                            functionalityWorkerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                            statements,
                        });
                    let index = 0;
                    for (let i = 0; i < results.length; i++) {
                        if (results[i] === null) results[i] = dispatched[index++];
                    }
                    return { ok: true, result: { results } };
                }
                case "op.look": {
                    // {§agui-op-look}
                    if (typeof p.text !== "string" || p.text.length === 0) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.look requires non-empty PLURNK text.",
                            400,
                            { field: "text", recovery: "Provide one PLURNK statement to observe." },
                        );
                    }
                    const parsed = PlurnkParser.parseClient(p.text);
                    const diagnostic = parsed.items.find((item) => item.kind === "error");
                    if (diagnostic !== undefined && diagnostic.kind === "error") {
                        return operationOutcome(parseFailureResult({
                            detail: diagnostic.error.message,
                            line: diagnostic.error.line,
                            column: diagnostic.error.column,
                            source: diagnostic.error.source,
                            severity: diagnostic.error.severity,
                        }));
                    }
                    if (parsed.unparsedTail !== undefined) {
                        return operationOutcome(parseFailureResult({
                            detail: parsed.unparsedTail.reason,
                            line: parsed.unparsedTail.from.line,
                            column: parsed.unparsedTail.from.column,
                            source: "grammar",
                            severity: "error",
                        }));
                    }
                    const textItem = parsed.items.find((item) => item.kind === "text");
                    if (textItem !== undefined && textItem.kind === "text") {
                        return actionFailure(
                            "invalid-action-parameters",
                            "op.look parsed text outside the statement; only surrounding whitespace is allowed.",
                            400,
                            {
                                field: "text",
                                line: textItem.position.line,
                                column: textItem.position.column,
                                recovery: "Remove text outside the LOOK statement.",
                            },
                        );
                    }
                    const statements = parsed.items.filter((item) => item.kind === "statement");
                    if (statements.length !== 1) {
                        return actionFailure(
                            "invalid-action-parameters",
                            `op.look parsed ${statements.length} statements; exactly one LOOK statement is required.`,
                            400,
                            { field: "text", recovery: "Provide exactly one valid LOOK statement." },
                        );
                    }
                    const [item] = statements;
                    if (item.statement.op !== "LOOK") {
                        return actionFailure(
                            "invalid-action-parameters",
                            `op.look parsed ${item.statement.op}; the single statement must be LOOK.`,
                            400,
                            { field: "text", recovery: "Use LOOK as the observation operation." },
                        );
                    }
                    const statement = { ...(item.statement as unknown as Record<string, unknown>), op: "READ" } as unknown as PlurnkStatement;
                    return operationOutcome(await this.#seam().look({
                        workspaceId: world.workspaceId,
                        workerId: world.workerId,
                        functionalityWorkerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                        statement,
                    }));
                }
                case "run.fork": return { ok: true, result: await this.#seam().forkWorker({ workspaceId: world.workspaceId, workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId), ...(typeof p.name === "string" ? { name: p.name } : {}) }) };
                case "worker.model.get": {
                    const { model, spawnModel } = await this.#seam().readWorkerModel({
                        workspaceId: world.workspaceId,
                        workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
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
                        workspaceId: world.workspaceId,
                        workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                        selector: p.selector,
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
                        workspaceId: world.workspaceId,
                        workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                        selector: p.selector as string | null,
                    }) };
                }
                case "worker.reasoning.get": {
                    return { ok: true, result: await this.#seam().readWorkerReasoning({
                        workspaceId: world.workspaceId,
                        workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                    }) };
                }
                case "worker.reasoning.set": {
                    if (!Object.hasOwn(p, "policy")) {
                        return actionFailure(
                            "invalid-action-parameters",
                            "worker.reasoning.set requires a policy.",
                            400,
                            { recovery: "Provide a reasoning policy." },
                        );
                    }
                    return { ok: true, result: await this.#seam().setWorkerReasoning({
                        workspaceId: world.workspaceId,
                        workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                        policy: p.policy,
                    }) };
                }
                case "worker.capabilities.get": {
                    return { ok: true, result: await this.#seam().readWorkerCapabilities({
                        workspaceId: world.workspaceId,
                        workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                    }) };
                }
                case "worker.capabilities.set": {
                    return { ok: true, result: await this.#seam().setWorkerCapabilities({
                        workspaceId: world.workspaceId,
                        workerId: conversationWorkerId ?? await this.#seam().ensureModelWorker(world.workspaceId),
                        policy: p.policy as CapabilityPolicy,
                    }) };
                }
                default: throw new Error(`AG-UI built-in '${kind}' has no executor`);
            }
        } catch (err) {
            const problem = problemFromError(err);
            if (problem !== null) return { ok: false, problem };
            console.error(`AG-UI action '${kind}' failed:`, err);
            return actionFailure("action-failed", "The action failed unexpectedly.", 500);
        }
    }

}
