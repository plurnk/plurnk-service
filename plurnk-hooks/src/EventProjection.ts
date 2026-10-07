import { writtenOp, type ApplicationOperationEvent, type ClientInteractionProjection, type Notice, type ProposalProjection } from "@plurnk/plurnk-contracts";

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

    static project(workspaceId: number | null, method: string, params: unknown): HookEvent | null {
        if (!EventProjection.sources.has(method)) return null;
        const workerId = (params as { workerId?: number | null }).workerId;
        const shared = {
            ...(typeof workerId === "number" ? { session_id: String(workerId) } : {}),
            plurnk: { workspaceId, method, params },
        };
        switch (method) {
            case "operation/event": {
                const event = params as ApplicationOperationEvent;
                if (event.origin !== "model" && event.origin !== "client") return null;
                return {
                    hook_event_name: event.phase === "started" ? "PreToolUse"
                        : event.result!.status >= 400 ? "PostToolUseFailure" : "PostToolUse",
                    ...shared,
                    ...(event.projectRoot === null ? {} : { cwd: event.projectRoot }),
                    tool_use_id: `${event.turnId}/${event.sequence}`,
                    tool_name: writtenOp(event.statement),
                    tool_input: event.statement,
                    ...(event.phase === "settled" ? { tool_response: event.result } : {}),
                };
            }
            case "loop/terminated":
                return { hook_event_name: "Stop", ...shared };
            case "notice/event": {
                const { notice } = params as { notice: Notice };
                return { hook_event_name: "Notification", ...shared, ...(typeof notice.message === "string" ? { message: notice.message } : {}) };
            }
            case "loop/proposal": {
                const event = params as ProposalProjection;
                if (event.disposition.decision !== "review") return null;
                return { hook_event_name: "PermissionRequest", ...shared, tool_name: event.op,
                    tool_input: { target: event.target, body: event.body, attrs: event.attrs } };
            }
            case "loop/interaction": {
                const { request } = params as ClientInteractionProjection;
                return { hook_event_name: "PermissionRequest", ...shared, tool_name: request.toolName,
                    tool_input: request.arguments, ...(request.message === undefined ? {} : { message: request.message }) };
            }
            default:
                throw new Error(`Hook event ${method} has no projection.`);
        }
    }
}
