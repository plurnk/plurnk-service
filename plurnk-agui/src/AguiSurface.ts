import type { JsonSchema } from "@plurnk/plurnk-contracts";

// The public AG-UI+ wire registry. JSON Schema values are both the discovery
// representation and the production admission contract; clients never maintain
// parameter folklore alongside this authority.

export type AguiActionScope = "worldless" | "workspace";

export interface AguiActionContract {
    readonly scope: AguiActionScope;
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
}

export interface AguiNotificationContract {
    readonly payloadSchema: JsonSchema;
}

const id = (name: string): string => `https://schemas.plurnk.dev/v0/${name}.json`;
const ref = (name: string): JsonSchema => ({ $ref: id(name) });
const string = (options: Readonly<Record<string, unknown>> = {}): JsonSchema => ({ type: "string", ...options });
const integer = (minimum: number = 0): JsonSchema => ({
    type: "integer",
    minimum,
    maximum: Number.MAX_SAFE_INTEGER,
});
const nullable = (schema: JsonSchema): JsonSchema => ({ oneOf: [schema, { type: "null" }] });
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const object = (
    properties: Readonly<Record<string, JsonSchema>> = {},
    required: readonly string[] = [],
    additionalProperties: boolean = false,
): JsonSchema => ({
    type: "object",
    ...(required.length === 0 ? {} : { required }),
    additionalProperties,
    properties,
});

const EMPTY = object();
const NONEMPTY = string({ minLength: 1 });
const POSITIVE = integer(1);
const NONNEGATIVE = integer(0);
const OPERATION_RESULT = ref("OperationResult");
const MODEL_ROUTE = ref("ModelRoute");
const REASONING_POLICY = ref("ReasoningPolicy");
const PROVIDER_ACCOUNTING = { $ref: "https://schemas.plurnk.dev/ProviderAccounting.json" };

const constraint = object({ effect: NONEMPTY, glob: NONEMPTY }, ["effect", "glob"]);
const workspace = object({
    id: POSITIVE,
    name: NONEMPTY,
    project_root: nullable(string()),
    created_at: NONEMPTY,
}, ["id", "name", "project_root", "created_at"]);
const worker = object({
    id: POSITIVE,
    name: NONEMPTY,
    created_at: NONEMPTY,
    origin: { enum: ["model", "client", "_plurnk"] },
}, ["id", "name", "created_at", "origin"]);
const workerSettings = object({ requestUserInput: { type: "boolean" } }, ["requestUserInput"]);
const reasoningResult = object({
    policy: nullable(REASONING_POLICY),
    supportedPolicies: array(REASONING_POLICY),
}, ["policy", "supportedPolicies"]);
const derivationStatus = object({
    phase: { enum: ["preparing", "indexing", "complete", "failed"] },
    completed: NONNEGATIVE,
    total: NONNEGATIVE,
    percent: { type: "number", minimum: 0, maximum: 100 },
    message: string(),
    level: { enum: ["info", "error"] },
}, ["phase", "completed", "total", "percent", "message", "level"]);

const action = (
    scope: AguiActionScope,
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
): AguiActionContract => Object.freeze({ scope, inputSchema, outputSchema });

export const AGUI_BUILTIN_ACTIONS = Object.freeze({
    ping: action("worldless", EMPTY, EMPTY),
    discover: action("worldless", EMPTY, ref("AguiDiscovery")),
    "providers.list": action("worldless", EMPTY, object({
        aliases: array(object({
            alias: NONEMPTY,
            provider: NONEMPTY,
            model: NONEMPTY,
            active: { type: "boolean" },
            inputCapacity: nullable(POSITIVE),
        }, ["alias", "provider", "model", "active", "inputCapacity"])),
    }, ["aliases"])),
    "models.list": action("worldless", ref("ModelCatalogQuery"), ref("ModelCatalogPage")),
    "workspace.list": action("worldless", EMPTY, object({ workspaces: array(workspace) }, ["workspaces"])),
    "workspace.create": action("worldless", object({
        name: NONEMPTY,
        projectRoot: nullable(string()),
        settings: { oneOf: [string(), { type: "object", additionalProperties: true }] },
        constraints: array(constraint),
    }), object({ id: POSITIVE, name: NONEMPTY, workerId: POSITIVE }, ["id", "name", "workerId"])),
    "workspace.attach": action("worldless", object({
        id: POSITIVE,
        workerId: POSITIVE,
    }, ["id"]), object({ id: POSITIVE, name: NONEMPTY, workerId: POSITIVE }, ["id", "name", "workerId"])),
    "workspace.workers": action("workspace", object({ id: POSITIVE }), object({ workers: array(worker) }, ["workers"])),
    "log.read": action("workspace", object({
        workerId: POSITIVE,
        limit: POSITIVE,
        sinceId: NONNEGATIVE,
        loopId: NONNEGATIVE,
        turnId: NONNEGATIVE,
        loopSeq: NONNEGATIVE,
        turnSeq: NONNEGATIVE,
        sequence: NONNEGATIVE,
    }), object({ entries: array({ type: "object", additionalProperties: true }) }, ["entries"])),
    "loop.inject": action("workspace", object({ prompt: NONEMPTY }, ["prompt"]), {
        allOf: [
            OPERATION_RESULT,
            object({
                action: { enum: ["injected_next_turn", "enqueued_new_loop"] },
                loopId: POSITIVE,
                turnSeq: POSITIVE,
            }, ["action", "loopId"], true),
        ],
    }),
    "loop.cancel": action("workspace", object({ reason: NONEMPTY }), object({ cancelled: { type: "boolean" } }, ["cancelled"])),
    "workspace.prompts": action("workspace", object({ limit: POSITIVE }), object({ prompts: array(string()) }, ["prompts"])),
    "workspace.rename": action("workspace", object({ name: NONEMPTY }, ["name"]), object({ id: POSITIVE, name: NONEMPTY }, ["id", "name"])),
    "workspace.constrain": action("workspace", constraint, constraint),
    "workspace.unconstrain": action("workspace", constraint, constraint),
    "workspace.constraints": action("workspace", EMPTY, object({ constraints: array(constraint) }, ["constraints"])),
    "workspace.derivation": action("workspace", EMPTY, object({ status: nullable(derivationStatus) }, ["status"])),
    "entry.read": action("workspace", object({
        target: NONEMPTY,
        workerId: POSITIVE,
        channel: NONEMPTY,
        offset: NONNEGATIVE,
    }, ["target"]), ref("EntryReadResult")),
    "op.exec": action("workspace", object({ command: NONEMPTY }, ["command"]), OPERATION_RESULT),
    "op.parse": action("workspace", object({ text: NONEMPTY }, ["text"]), object({
        results: array(OPERATION_RESULT),
    }, ["results"])),
    "workspace.members": action("workspace", EMPTY, object({
        members: array(object({ path: NONEMPTY, effect: { enum: ["member", "view"] } }, ["path", "effect"])),
        hidden: array(NONEMPTY),
    }, ["members", "hidden"])),
    "op.look": action("workspace", object({ text: NONEMPTY }, ["text"]), OPERATION_RESULT),
    "run.fork": action("workspace", object({ name: NONEMPTY }), object({
        workerId: POSITIVE,
        workerName: nullable(NONEMPTY),
        parentWorkerId: POSITIVE,
    }, ["workerId", "workerName", "parentWorkerId"])),
    "worker.model.get": action("workspace", EMPTY, object({
        model: nullable(MODEL_ROUTE),
        spawnModel: nullable(MODEL_ROUTE),
    }, ["model", "spawnModel"])),
    "worker.model.set": action("workspace", object({ selector: NONEMPTY }, ["selector"]), MODEL_ROUTE),
    "worker.child.set": action("workspace", object({ selector: nullable(NONEMPTY) }, ["selector"]), nullable(MODEL_ROUTE)),
    "worker.reasoning.get": action("workspace", EMPTY, reasoningResult),
    "worker.reasoning.set": action("workspace", object({ policy: REASONING_POLICY }, ["policy"]), {
        ...reasoningResult,
        properties: {
            ...(reasoningResult.properties as Readonly<Record<string, JsonSchema>>),
            policy: REASONING_POLICY,
        },
    }),
    "worker.settings.get": action("workspace", EMPTY, workerSettings),
    "worker.settings.set": action("workspace", object({
        settings: object({ requestUserInput: { type: "boolean" } }),
    }, ["settings"]), workerSettings),
} satisfies Readonly<Record<string, AguiActionContract>>);

const notification = (payloadSchema: JsonSchema): AguiNotificationContract =>
    Object.freeze({ payloadSchema });

const streamCoordinate = {
    loop_seq: NONNEGATIVE,
    turn_seq: NONNEGATIVE,
    sequence: NONNEGATIVE,
};
const streamBase = {
    entryId: POSITIVE,
    workerId: POSITIVE,
    target: NONEMPTY,
    scheme: NONEMPTY,
    channel: NONEMPTY,
    state: { enum: ["static", "active", "closed", "errored"] },
    contentLength: NONNEGATIVE,
    mimetype: NONEMPTY,
    ...streamCoordinate,
};
const reasoningIdentity = {
    workerId: POSITIVE,
    loopId: POSITIVE,
    turnId: POSITIVE,
    modelCallId: POSITIVE,
};

export const AGUI_NOTIFICATIONS = Object.freeze({
    "log/entry": notification(object({
        entry: object({
            id: POSITIVE,
            op: nullable(string()),
            origin: NONEMPTY,
        }, ["id", "op", "origin"], true),
    }, ["entry"])),
    "loop/terminated": notification(object({
        workerId: POSITIVE,
        loopId: POSITIVE,
        result: OPERATION_RESULT,
        hitMaxTurns: { type: "boolean" },
        turnIds: array(POSITIVE),
        attributions: array(NONEMPTY),
        usage: object({
            accounting: PROVIDER_ACCOUNTING,
            curationWeight: nullable(NONNEGATIVE),
            curationBudget: nullable(NONNEGATIVE),
            contextTokens: nullable(NONNEGATIVE),
            contextCapacity: nullable(POSITIVE),
            meta: { type: "object", additionalProperties: true },
        }, ["accounting", "curationWeight", "curationBudget", "contextTokens", "contextCapacity", "meta"]),
    }, ["workerId", "loopId", "result", "hitMaxTurns", "turnIds", "attributions", "usage"])),
    "loop/proposal": notification(ref("ProposalProjection")),
    "loop/interaction": notification(ref("ClientInteractionProjection")),
    "notice/event": notification(object({
        loopId: NONNEGATIVE,
        notice: ref("Notice"),
    }, ["loopId", "notice"])),
    "reasoning/event": notification({
        oneOf: [
            object({
                ...reasoningIdentity,
                phase: { enum: ["start", "end"] },
            }, ["workerId", "loopId", "turnId", "modelCallId", "phase"]),
            object({
                ...reasoningIdentity,
                phase: { enum: ["content"] },
                delta: NONEMPTY,
            }, ["workerId", "loopId", "turnId", "modelCallId", "phase", "delta"]),
        ],
    }),
    "stream/event": notification(object(streamBase, ["entryId", "workerId", "target", "channel", "state", "contentLength"])),
    "stream/concluded": notification(object({
        entryId: POSITIVE,
        workerId: POSITIVE,
        target: NONEMPTY,
        subscriptionId: POSITIVE,
        result: OPERATION_RESULT,
        scheme: NONEMPTY,
        summary: string(),
        wakeAction: { enum: ["skipped-aborted", "skipped-cancelled", "resumed-loop", "no-op-active-loop", "no-loop"] },
        wakeLoopId: POSITIVE,
        ...streamCoordinate,
    }, ["entryId", "workerId", "target", "subscriptionId", "result", "scheme", "summary", "wakeAction"])),
    "workspace/branch-batch": notification(object({
        batchId: POSITIVE,
        state: { enum: ["queued", "running", "completed", "failed", "recovery-required"] },
    }, ["batchId", "state"], true)),
} satisfies Readonly<Record<string, AguiNotificationContract>>);

export type AguiBuiltinActionName = keyof typeof AGUI_BUILTIN_ACTIONS;
export type AguiNotificationName = keyof typeof AGUI_NOTIFICATIONS;
