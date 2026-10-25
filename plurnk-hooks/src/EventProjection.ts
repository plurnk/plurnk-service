import { Validator, isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";

export interface HookEvent {
    readonly hook_event_name: string;
    readonly session_id?: string;
    readonly cwd?: string;
    readonly tool_use_id?: string;
    readonly tool_name?: string;
    readonly tool_input?: unknown;
    readonly tool_response?: unknown;
    readonly message?: string;
    readonly plurnk: { readonly workspaceId: number | null; readonly method: string; readonly params: unknown };
}

// {§hooks-event-projection} Translate facts at the command boundary, not core lifetimes.
export default class EventProjection {
    static readonly sources: ReadonlyMap<string, readonly string[]> = new Map([
        ["operation/event", ["PreToolUse", "PostToolUse", "PostToolUseFailure"]],
        ["loop/terminated", ["Stop"]],
        ["notice/event", ["Notification"]],
        ["loop/proposal", ["PermissionRequest"]],
        ["loop/interaction", ["PermissionRequest"]],
    ]);
    static readonly names: ReadonlySet<string> = new Set([...EventProjection.sources.values()].flat());

    // An operation event's fields the projection reads, each by its type: the native evidence as the daemon sent it.
    static #operationEvent(params: unknown): {
        origin: unknown;
        phase: unknown;
        result: Record<string, unknown> | undefined;
        cwd: string | undefined;
        toolUseId: string;
        toolName: string;
        statement: unknown;
    } {
        const event = isRecord(params) ? params : {};
        const statement = isRecord(event.statement) ? event.statement : {};
        return {
            origin: event.origin,
            phase: event.phase,
            result: isRecord(event.result) ? event.result : undefined,
            cwd: typeof event.projectRoot === "string" ? event.projectRoot : undefined,
            toolUseId: [event.turnId, event.sequence].map((n) => isSafeInteger(n) ? String(n) : "").join("/"),
            // The heading as written: an execution's runtime, otherwise the op ({§executor-heading}).
            toolName: typeof statement.runtime === "string" ? statement.runtime : typeof statement.op === "string" ? statement.op : "",
            statement: event.statement,
        };
    }

    static project(workspaceId: number | null, method: string, params: unknown): HookEvent | null {
        if (!EventProjection.sources.has(method)) return null;
        const workerId = isRecord(params) ? params.workerId : undefined;
        const shared = {
            ...(typeof workerId === "number" ? { session_id: String(workerId) } : {}),
            plurnk: { workspaceId, method, params },
        };
        switch (method) {
            case "operation/event": {
                const event = EventProjection.#operationEvent(params);
                if (event.origin !== "model" && event.origin !== "client") return null;
                const status = typeof event.result?.status === "number" ? event.result.status : 0;
                return {
                    hook_event_name: event.phase === "started" ? "PreToolUse"
                        : status >= 400 ? "PostToolUseFailure" : "PostToolUse",
                    ...shared,
                    ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
                    tool_use_id: event.toolUseId,
                    tool_name: event.toolName,
                    tool_input: event.statement,
                    ...(event.phase === "settled" ? { tool_response: event.result } : {}),
                };
            }
            case "loop/terminated":
                return { hook_event_name: "Stop", ...shared };
            case "notice/event": {
                const notice = isRecord(params) && isRecord(params.notice) ? params.notice : undefined;
                return { hook_event_name: "Notification", ...shared, ...(typeof notice?.message === "string" ? { message: notice.message } : {}) };
            }
            case "loop/proposal": {
                const event = Validator.assertProposalProjection(params);
                if (event.disposition.decision !== "review") return null;
                return { hook_event_name: "PermissionRequest", ...shared, tool_name: event.op,
                    tool_input: { target: event.target, body: event.body, attrs: event.attrs } };
            }
            case "loop/interaction": {
                const request = isRecord(params) && isRecord(params.request) ? params.request : {};
                return { hook_event_name: "PermissionRequest", ...shared, tool_name: typeof request.toolName === "string" ? request.toolName : "",
                    tool_input: request, ...(typeof request.message === "string" ? { message: request.message } : {}) };
            }
            default:
                throw new Error(`Hook event ${method} has no projection.`);
        }
    }
}
