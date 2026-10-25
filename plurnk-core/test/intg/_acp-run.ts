// Driving the assembled daemon over its ACP v2 listener from a test: a packet-capturing Mock, the
// JSON-RPC 2.0 request shape, the posted SSE notification/response stream and the action result,
// shared by the MCP composition witnesses and the third-party live specimen.
import assert from "node:assert/strict";
import { chatMessageText, Mock } from "@plurnk/plurnk-providers";

export type Event = Readonly<Record<string, unknown>>;

export class PacketCapturingMock extends Mock {
    readonly requests: Array<ReadonlyArray<{ readonly role: string; readonly content: string }>> = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.requests.push(args[0].messages.map((message) => ({ role: message.role, content: chatMessageText(message) })));
        return super.generate(...args);
    }
}

export const parseEvents = (body: string): Event[] => body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as Event);

export const post = async (port: number, input: Readonly<Record<string, unknown>>): Promise<Event[]> => {
    // {§credential-authority} — both tiers boot their daemon with PLURNK_AUTH=0, so the listener admits anonymously.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
    const events: Event[] = [];
    const method = typeof input.method === "string" ? input.method : "";
    const reqId = typeof input.id === "string" ? input.id : crypto.randomUUID();
    const permissionOptionId = method === "session/resume"
        ? ((input.params as { permissionOptionId?: string } | undefined)?.permissionOptionId ?? null)
        : null;

    return await new Promise<Event[]>((resolve, reject) => {
        let settled = false;
        const finish = (terminal?: Event) => {
            if (settled) return;
            settled = true;
            if (terminal !== undefined) events.push(terminal);
            ws.close();
            resolve(events);
        };
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
            }));
        });
        ws.addEventListener("message", (msg) => {
            const frame = JSON.parse(String(msg.data)) as Event & {
                id?: string | number;
                method?: string;
                params?: {
                    update?: {
                        sessionUpdate?: string;
                        state?: string;
                        stopReason?: string;
                    };
                    _meta?: {
                        plurnk?: {
                            proposal?: unknown;
                        };
                    };
                };
                result?: Record<string, unknown>;
                error?: unknown;
            };
            if (frame.id === "init") {
                if (method === "session/resume") {
                    const params = input.params as { sessionId?: string; _meta?: unknown } | undefined;
                    ws.send(JSON.stringify({
                        jsonrpc: "2.0",
                        id: reqId,
                        method: "session/resume",
                        params: {
                            sessionId: params?.sessionId ?? "default",
                            cwd: "/",
                            _meta: params?._meta,
                        },
                    }));
                } else {
                    ws.send(JSON.stringify(input));
                }
                return;
            }
            if (frame.method === "session/request_permission") {
                if (permissionOptionId !== null && frame.id !== undefined) {
                    ws.send(JSON.stringify({
                        jsonrpc: "2.0",
                        id: frame.id,
                        result: {
                            outcome: {
                                outcome: "selected",
                                optionId: permissionOptionId,
                            },
                        },
                    }));
                    return;
                }
                const proposal = frame.params?._meta?.plurnk?.proposal;
                finish({
                    jsonrpc: "2.0",
                    id: reqId,
                    result: {
                        stopReason: "requires_action",
                        _meta: {
                            plurnk: {
                                stopReason: "requires_action",
                                ...(proposal !== undefined ? { proposal } : {}),
                            },
                        },
                    },
                });
                return;
            }
            if (frame.method === "session/update") {
                events.push(frame);
                const update = frame.params?.update;
                if (method === "session/prompt" || method === "session/resume") {
                    if (update?.sessionUpdate === "state_update" && update.state === "idle") {
                        // In session/resume with a permission decision, ignore the initial replay state_update before permission is answered
                        if (method === "session/resume" && permissionOptionId !== null) {
                            const hasRunning = events.some(
                                (e) => ((e.params as { update?: { sessionUpdate?: string; state?: string } } | undefined)?.update?.sessionUpdate === "state_update")
                                    && ((e.params as { update?: { state?: string } } | undefined)?.update?.state === "running"),
                            );
                            if (!hasRunning) return;
                        }
                        finish({
                            jsonrpc: "2.0",
                            id: reqId,
                            result: {
                                stopReason: update.stopReason ?? "end_turn",
                                _meta: {
                                    plurnk: {
                                        stopReason: update.stopReason ?? "end_turn",
                                    },
                                },
                            },
                        });
                    }
                }
                return;
            }
            if (frame.id === reqId) {
                if (method === "_plurnk/action" || frame.error !== undefined) {
                    finish(frame);
                }
            }
        });
        ws.addEventListener("error", (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        });
    });
};

export interface RunInputOptions {
    readonly projectRoot?: string | null;
    readonly prompt?: string;
    readonly action?: { readonly kind: string; readonly [key: string]: unknown };
    readonly proposalResolve?: {
        readonly logEntryId: number;
        readonly optionId: "allow_once" | "allow_always" | "reject_once" | "reject_always";
    };
}

export const runInput = (
    workspace: string,
    id: string,
    options: RunInputOptions,
): Readonly<Record<string, unknown>> => {
    if (options.action !== undefined) {
        const { kind, ...params } = options.action;
        return {
            jsonrpc: "2.0",
            id,
            method: "_plurnk/action",
            params: {
                sessionId: workspace,
                workspace,
                ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
                kind,
                params,
            },
        };
    }
    if (options.proposalResolve !== undefined) {
        return {
            jsonrpc: "2.0",
            id,
            method: "session/resume",
            params: {
                sessionId: workspace,
                cwd: "/",
                _meta: {
                    plurnk: {
                        workspace,
                        ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
                    },
                },
                permissionOptionId: options.proposalResolve.optionId,
            },
        };
    }
    return {
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: {
            sessionId: workspace,
            prompt: [{ type: "text", text: options.prompt ?? "" }],
            _meta: {
                plurnk: {
                    workspace,
                    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
                },
            },
        },
    };
};

// {§acp-plurnk-metadata} A JSON-RPC _plurnk/action response carries result or error.data.problem.
export const actionResult = (events: readonly Event[]): {
    readonly ok: boolean;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly problem?: Readonly<Record<string, unknown>>;
} => {
    const terminal = events.find((candidate) => "result" in candidate || "error" in candidate) as {
        readonly result?: Readonly<Record<string, unknown>>;
        readonly error?: { readonly data?: { readonly problem?: Readonly<Record<string, unknown>> } };
    } | undefined;
    assert.ok(terminal !== undefined, "the ACP action request settled with a JSON-RPC response");
    if (terminal.error !== undefined) {
        return { ok: false, problem: terminal.error.data?.problem };
    }
    return { ok: true, result: terminal.result };
};

export const sessionUpdates = (events: readonly Event[]): ReadonlyArray<Readonly<Record<string, unknown>>> =>
    events
        .filter((e) => e.method === "session/update")
        .map((e) => ((e.params as { update?: Readonly<Record<string, unknown>> } | undefined)?.update ?? {}));

export const terminalMeta = (events: readonly Event[]): Readonly<Record<string, unknown>> | undefined => {
    const terminal = events.findLast((candidate) => "result" in candidate) as {
        readonly result?: { readonly _meta?: { readonly plurnk?: Readonly<Record<string, unknown>> } };
    } | undefined;
    return terminal?.result?._meta?.plurnk;
};

export const packet = (requests: PacketCapturingMock["requests"], index: number): string =>
    requests[index]?.map(({ content }) => content).join("\n\n") ?? "";
