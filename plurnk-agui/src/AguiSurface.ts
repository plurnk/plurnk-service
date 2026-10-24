import {
    APPLICATION_NOTIFICATIONS,
    type ApplicationNotificationContract,
    type JsonSchema,
} from "@plurnk/plurnk-contracts";

// The public AG-UI+ wire registry. JSON Schema values are both the discovery
// representation and the production admission contract; clients never maintain
// parameter folklore alongside this authority.

type AguiActionScope = "daemon" | "workspace" | "worker";

export interface AguiActionContract {
    readonly scope: AguiActionScope;
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
}

export type AguiNotificationContract<T = unknown> = ApplicationNotificationContract<T>;

const id = (name: string): string => `https://schemas.plurnk.xyz/v0/${name}.json`;
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
const BOOLEAN = { type: "boolean" };
const NONEMPTY = string({ minLength: 1 });
const POSITIVE = integer(1);
const NONNEGATIVE = integer(0);
const OPERATION_RESULT = ref("OperationResult");
const MODEL_ROUTE = ref("ModelRoute");
const EFFORT = ref("Effort");

const workspace = object({
    id: POSITIVE,
    name: NONEMPTY,
    project_root: nullable(string()),
    // {§workspace-label}
    project_label: nullable(string()),
    created_at: NONEMPTY,
    // {§place-hiding}
    hidden_at: nullable(NONEMPTY),
}, ["id", "name", "project_root", "project_label", "created_at", "hidden_at"]);
// {§loop-lifecycle-vocabulary} — the one lifecycle vocabulary every client renders.
const LIFECYCLE = { enum: ["idle", "queued", "running", "parked", "completed", "cancelled", "failed"] };
// {§application-worker-observation} — kind and lifecycle ride the directory row (#523).
const worker = object({
    id: POSITIVE,
    name: NONEMPTY,
    created_at: NONEMPTY,
    owner: NONEMPTY,
    origin: { enum: ["model", "_plurnk"] },
    parentWorkerId: nullable(POSITIVE),
    kind: { enum: ["root", "fork", "work"] },
    lifecycle: LIFECYCLE,
    // {§place-hiding}
    hidden_at: nullable(NONEMPTY),
}, ["id", "name", "created_at", "owner", "origin", "parentWorkerId", "kind", "lifecycle", "hidden_at"]);
// {§agui-worker-loops} — a loop as a list names it: its number, lifecycle, the sender of its opening message and
// that message's first line, and whether the message holds more.
const loop = object({
    id: POSITIVE,
    sequence: POSITIVE,
    lifecycle: LIFECYCLE,
    source: nullable(string()),
    opening: string(),
    continued: { type: "boolean" },
}, ["id", "sequence", "lifecycle", "source", "opening", "continued"]);
const capabilityProjection = ref("CapabilityProjection");
// {§worker-effort-source} — `source` says whether the effort was chosen or seeded.
const effortProperties: Readonly<Record<string, JsonSchema>> = {
    effort: nullable(EFFORT),
    source: { enum: ["default", "explicit"] },
    supportedEfforts: array(EFFORT),
};
const effortResult = object(effortProperties, ["effort", "source", "supportedEfforts"]);
const action = (
    scope: AguiActionScope,
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
): AguiActionContract => Object.freeze({ scope, inputSchema, outputSchema });

export const AGUI_BUILTIN_ACTIONS = Object.freeze({
    ping: action("daemon", EMPTY, EMPTY),
    discover: action("daemon", EMPTY, ref("AguiDiscovery")),
    // {§agui-provider-routes} — each alias is the route a worker seeded from it gets, its configured effort included.
    "providers.list": action("daemon", EMPTY, object({
        aliases: array(object({
            alias: NONEMPTY,
            provider: NONEMPTY,
            model: NONEMPTY,
            effort: EFFORT,
            effortSource: { const: "default" },
            active: { type: "boolean" },
            inputCapacity: nullable(POSITIVE),
        }, ["alias", "provider", "model", "active", "inputCapacity"])),
    }, ["aliases"])),
    "models.list": action("daemon", ref("ModelCatalogQuery"), ref("ModelCatalogPage")),
    // {§agui-place-hiding} A directory leaves hidden places out unless it includes them.
    "workspace.list": action("daemon", object({ includeHidden: BOOLEAN }), object({ workspaces: array(workspace) }, ["workspaces"])),
    "workspace.create": action("daemon", object({
        name: NONEMPTY,
        projectRoot: nullable(string()),
        settings: { oneOf: [string(), { type: "object", additionalProperties: true }] },
    }), object({ id: POSITIVE, name: NONEMPTY }, ["id", "name"])),
    "workspace.attach": action("daemon", { oneOf: [
        object({ id: POSITIVE }, ["id"]),
        object({ name: NONEMPTY }, ["name"]),
        object({ projectRoot: NONEMPTY }, ["projectRoot"]),
    ] }, object({ id: POSITIVE, name: NONEMPTY }, ["id", "name"])),
    "workspace.workers": action("workspace", object({ id: POSITIVE, includeHidden: BOOLEAN }), object({ workers: array(worker) }, ["workers"])),
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
    "workspace.prompts": action("workspace", object({ workerId: POSITIVE, limit: POSITIVE }), object({ prompts: array(string()) }, ["prompts"])),
    "worker.loops": action("workspace", object({ workerId: POSITIVE }), object({ loops: array(loop) }, ["loops"])),
    "workspace.share": action("workspace", object({ folder: NONEMPTY }, ["folder"]), object({ folder: NONEMPTY }, ["folder"])),
    "workspace.rename": action("workspace", object({ name: NONEMPTY }, ["name"]), object({ id: POSITIVE, name: NONEMPTY }, ["id", "name"])),
    // {§agui-place-hiding}
    "workspace.hidden.set": action("workspace", object({ hidden: BOOLEAN }, ["hidden"]), object({
        id: POSITIVE,
        hidden_at: nullable(NONEMPTY),
    }, ["id", "hidden_at"])),
    "worker.hidden.set": action("workspace", object({ hidden: BOOLEAN, workerId: POSITIVE }, ["hidden"]), object({
        id: POSITIVE,
        hidden_at: nullable(NONEMPTY),
        workerIds: array(POSITIVE),
    }, ["id", "hidden_at", "workerIds"])),
    // {§rollback} — undo the bound worker's file mutations after a log coordinate, through ordinary operations.
    "workspace.rollback": action("workspace", object({ to: NONEMPTY, workerId: POSITIVE }, ["to"]), ref("RollbackReport")),
    "entry.read": action("workspace", object({
        target: NONEMPTY,
        workerId: POSITIVE,
        channel: NONEMPTY,
        offset: NONNEGATIVE,
    }, ["target"]), ref("EntryReadResult")),
    // {§env-option} — `env` is the execution's own environment; the family's admission owns its names.
    "op.exec": action("workspace", object({ command: NONEMPTY, env: { type: "object", additionalProperties: string() } }, ["command"]), OPERATION_RESULT),
    "op.parse": action("workspace", object({ text: NONEMPTY }, ["text"]), object({
        results: array(OPERATION_RESULT),
    }, ["results"])),
    "run.fork": action("workspace", object({ name: NONEMPTY }), object({
        workerId: POSITIVE,
        workerName: nullable(NONEMPTY),
        parentWorkerId: POSITIVE,
    }, ["workerId", "workerName", "parentWorkerId"])),
    "worker.model.get": action("workspace", EMPTY, object({
        model: nullable(MODEL_ROUTE),
        spawnModel: nullable(MODEL_ROUTE),
    }, ["model", "spawnModel"])),
    "worker.model.set": action("workspace", object({ selector: NONEMPTY, effort: EFFORT }, ["selector"]), MODEL_ROUTE),
    "worker.child.set": action("workspace", object({ selector: nullable(NONEMPTY) }, ["selector"]), nullable(MODEL_ROUTE)),
    "worker.effort.get": action("workspace", EMPTY, effortResult),
    "worker.effort.set": action("workspace", object({ effort: EFFORT }, ["effort"]), {
        ...effortResult,
        properties: { ...effortProperties, policy: EFFORT },
    }),
    "workspace.capabilities.get": action("workspace", EMPTY, capabilityProjection),
    "workspace.capabilities.set": action("workspace", object({
        policy: ref("CapabilityPolicy"),
    }, ["policy"]), capabilityProjection),
} satisfies Readonly<Record<string, AguiActionContract>>);

export const AGUI_NOTIFICATIONS = APPLICATION_NOTIFICATIONS;
