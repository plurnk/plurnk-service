// {§acp-projection} Pure projection from Plurnk log rows and daemon notifications onto ACP v2 session/update notifications.
import {
    addressOf,
    isRecord,
    isSafeInteger,
    withoutBodies,
    type ApplicationInboxMessage,
    type ApplicationLoopPacket,
    type LogEntryNotification,
    type LogEntryWire,
    type OutsideEventNotification,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import MessageAddress from "./MessageAddress.ts";

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpSessionUpdate {
    readonly sessionId: string;
    readonly update: Readonly<Record<string, unknown>>;
}

const MODEL_FACTS: ReadonlySet<string> = new Set(["lineAnchors", "lineAnchorIdentity", "lineNumberWidth"]);

export default class Translator {
    readonly #sessionId: string;
    readonly #workspaceId: number;
    readonly #workerId: number;
    readonly #origin: string;
    readonly #ceiling: number;
    readonly #streamedReasoningTurns = new Set<number>();

    constructor(args: {
        readonly sessionId: string;
        readonly workspaceId: number;
        readonly workerId: number;
        readonly origin: string;
        readonly historyPageChars?: number;
    }) {
        this.#sessionId = args.sessionId;
        this.#workspaceId = args.workspaceId;
        this.#workerId = args.workerId;
        this.#origin = args.origin;
        this.#ceiling = args.historyPageChars ?? Number.MAX_SAFE_INTEGER;
    }

    static coordinateOf(row: { readonly loop_seq?: unknown; readonly turn_seq?: unknown; readonly sequence?: unknown }): string {
        if (!isSafeInteger(row.loop_seq) || !isSafeInteger(row.turn_seq) || !isSafeInteger(row.sequence)) {
            throw new TypeError(`Log entry missing logical coordinate: ${JSON.stringify(row)}`);
        }
        return `${row.loop_seq}/${row.turn_seq}/${row.sequence}`;
    }

    static toolKindOf(op: string | null, scheme: string | null): AcpToolKind {
        switch (op) {
            case "READ":
                return scheme === "http" || scheme === "https" ? "fetch" : "read";
            case "EDIT":
            case "COPY":
                return "edit";
            case "MOVE":
                return "move";
            case "KILL":
                return "delete";
            case "FIND":
                return "search";
            case "NOTE":
            case "WAIT":
                return "think";
            case "SEND":
                return "other";
            case "WORK":
            case "FORK":
                return "execute";
            default:
                return op === null ? "other" : "execute";
        }
    }

    static toolStatusOf(row: { readonly state?: unknown; readonly status_rx?: unknown }): AcpToolStatus {
        if (row.state === "proposed") return "pending";
        if (row.state === "failed" || row.state === "cancelled" || (typeof row.status_rx === "number" && row.status_rx >= 400)) {
            return "failed";
        }
        return "completed";
    }

    static #parsed(value: unknown): unknown {
        if (value === undefined || value === "") return null;
        if (typeof value !== "string") return value;
        try { return JSON.parse(value) as unknown; } catch { return value; }
    }

    static #txBody(tx: unknown): string {
        const parsed = Translator.#parsed(tx);
        if (typeof parsed === "string") return parsed;
        if (isRecord(parsed) && typeof parsed.body === "string") return parsed.body;
        return "";
    }

    static #attrRecord(attrs: unknown): Readonly<Record<string, unknown>> {
        const parsed = Translator.#parsed(attrs);
        return isRecord(parsed) ? parsed : {};
    }

    static #rowMetadata(row: LogEntryWire): Record<string, unknown> {
        const attrs = Translator.#parsed(row.attrs);
        return {
            id: row.id,
            coordinate: Translator.coordinateOf(row),
            worker: row.worker_id,
            origin: row.origin,
            op: row.op,
            source: row.source,
            address: addressOf(row),
            signal: row.signal,
            status: row.status_rx,
            attrs: isRecord(attrs) ? withoutBodies(attrs) : attrs,
            state: row.state,
        };
    }

    #entryUrl(workerId: number, target: string): string {
        const params = new URLSearchParams({
            workspaceId: String(this.#workspaceId),
            workerId: String(workerId),
            target,
        });
        return `${this.#origin}/acp/entry?${params.toString()}`;
    }

    #bodyContentBlock(row: LogEntryWire, text: string, mimeType: string = "text/plain"): Record<string, unknown> {
        if (text.length <= this.#ceiling || row.op === null) {
            return { type: "text", text };
        }
        const target = `log:///${Translator.coordinateOf(row)}/${row.op}`;
        return {
            type: "resource_link",
            uri: this.#entryUrl(row.worker_id, target),
            name: target,
            mimeType,
        };
    }

    #leanReceipt(row: LogEntryWire): { receipt: unknown; contentBlock: Record<string, unknown> | null } {
        const parsed = Translator.#parsed(row.rx);
        if (!isRecord(parsed)) {
            const text = typeof row.rx === "string" ? row.rx : JSON.stringify(row.rx ?? null);
            return { receipt: parsed, contentBlock: text.length > 0 ? this.#bodyContentBlock(row, text, row.mimetype_rx) : null };
        }
        const rawContent = typeof parsed.content === "string" ? parsed.content : null;
        const mimeType = typeof parsed.mimetype === "string" ? parsed.mimetype : row.mimetype_rx;
        const kept = Object.entries(parsed).filter(([key]) => !MODEL_FACTS.has(key) && !(rawContent !== null && rawContent.length > this.#ceiling && key === "content"));
        const receipt = Object.fromEntries(kept);
        const contentBlock = rawContent !== null && rawContent.length > this.#ceiling
            ? this.#bodyContentBlock(row, rawContent, mimeType)
            : { type: "text", text: JSON.stringify(receipt) };
        return { receipt, contentBlock };
    }

    logEntry({ entry }: LogEntryNotification): AcpSessionUpdate[] {
        if (entry.worker_id !== this.#workerId) return [];
        const updates: AcpSessionUpdate[] = [];
        const coordinate = Translator.coordinateOf(entry);
        const meta = Translator.#rowMetadata(entry);
        const attrs = Translator.#attrRecord(entry.attrs);

        if (typeof entry.reasoning === "string" && entry.reasoning.length > 0 && !this.#streamedReasoningTurns.has(entry.turn_id)) {
            this.#streamedReasoningTurns.add(entry.turn_id);
            updates.push({
                sessionId: this.#sessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: entry.reasoning },
                    _meta: { plurnk: { coordinate, turnId: entry.turn_id } },
                },
            });
        }

        // 1. Model speech: SEND response or WAIT with body
        if (entry.origin === "model" && (
            (entry.op === "SEND" && (attrs.kind === "response" || entry.scheme === null || entry.scheme === "acp" || entry.scheme === "agui"))
            || (entry.op === "WAIT" && Translator.#txBody(entry.tx).length > 0)
        )) {
            const text = Translator.#txBody(entry.tx);
            const statement = Translator.#parsed(entry.tx);
            const aside = isRecord(statement) ? statement.aside ?? null : null;
            updates.push({
                sessionId: this.#sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: this.#bodyContentBlock(entry, text, "text/markdown"),
                    _meta: {
                        plurnk: {
                            ...meta,
                            aside,
                            receipt: Translator.#parsed(entry.rx),
                        },
                    },
                },
            });
            return updates;
        }

        // 2. User / external message arrival
        if (entry.origin === "_plurnk" && entry.op === "SEND" && attrs.kind === "message") {
            const text = Translator.#txBody(entry.tx);
            const messageId = MessageAddress.messageId(entry.source, this.#sessionId);
            updates.push({
                sessionId: this.#sessionId,
                update: {
                    sessionUpdate: "user_message_chunk",
                    content: this.#bodyContentBlock(entry, text, "text/markdown"),
                    _meta: {
                        plurnk: {
                            ...meta,
                            ...(messageId === null ? {} : { messageId }),
                        },
                    },
                },
            });
            return updates;
        }

        // 3. Model operation -> ACP tool_call + tool_call_update
        if (entry.origin === "model" && entry.op !== null) {
            const kind = Translator.toolKindOf(entry.op, entry.scheme);
            const status = Translator.toolStatusOf(entry);
            const address = addressOf(entry);
            const statement = Translator.#parsed(entry.tx);
            const rawInput = isRecord(statement)
                ? Object.fromEntries(Object.entries(statement).filter(([k]) => k !== "op" && k !== "position"))
                : statement;
            const { receipt, contentBlock } = this.#leanReceipt(entry);
            const content: Array<Record<string, unknown>> = [];
            if (typeof attrs.original === "string" && typeof attrs.patched === "string") {
                content.push({
                    type: "diff",
                    path: address ?? entry.pathname ?? "",
                    oldText: attrs.original,
                    newText: attrs.patched,
                });
            } else if (contentBlock !== null) {
                content.push({
                    type: "content",
                    content: contentBlock,
                });
            }
            const title = address === null ? entry.op : `${entry.op} (${address})`;
            updates.push({
                sessionId: this.#sessionId,
                update: {
                    sessionUpdate: "tool_call",
                    toolCallId: coordinate,
                    title,
                    kind,
                    status,
                    ...(address === null ? {} : { locations: [{ path: address }] }),
                    rawInput,
                    rawOutput: receipt,
                    ...(content.length === 0 ? {} : { content }),
                    _meta: { plurnk: meta },
                },
            });
            return updates;
        }

        // 4. Ambient / system log row
        const { receipt } = this.#leanReceipt(entry);
        updates.push({
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "_plurnk/ambient",
                row: {
                    ...meta,
                    tx: Translator.#parsed(entry.tx),
                    rx: receipt,
                },
            },
        });
        return updates;
    }

    reasoning(event: ReasoningEventNotification): AcpSessionUpdate[] {
        if (event.workerId !== this.#workerId) return [];
        this.#streamedReasoningTurns.add(event.turnId);
        if (event.phase !== "content") return [];
        return [{
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: event.delta },
                _meta: {
                    plurnk: {
                        turnId: event.turnId,
                        loopSeq: event.loopSeq,
                        turnSeq: event.turnSeq,
                        modelCallId: event.modelCallId,
                        requestSequence: event.requestSequence,
                    },
                },
            },
        }];
    }

    outside(event: OutsideEventNotification): AcpSessionUpdate[] {
        if (event.workerId !== this.#workerId) return [];
        return [{
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "_plurnk/outside",
                coordinate: event.coordinate,
                text: event.text,
                tokens: event.tokens,
            },
        }];
    }

    packet(event: ApplicationLoopPacket): AcpSessionUpdate[] {
        if (event.workerId !== this.#workerId) return [];
        return [{
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "usage_update",
                used: event.gauge.contextTokens ?? event.gauge.curationWeight ?? 0,
                size: event.gauge.contextCapacity ?? event.gauge.curationBudget ?? 0,
                _meta: {
                    plurnk: {
                        loopId: event.loopId,
                        loopSeq: event.loopSeq,
                        packetCount: event.packetCount,
                        gauge: event.gauge,
                    },
                },
            },
        }];
    }

    terminated(event: TerminatedNotification): AcpSessionUpdate[] {
        if (event.workerId !== this.#workerId) return [];
        const costUsd = event.usage.accounting.costUsd ?? event.usage.accounting.knownCostUsd;
        const cost = costUsd !== null
            ? { amount: costUsd, currency: "USD" }
            : undefined;
        return [{
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "usage_update",
                used: event.usage.contextTokens ?? event.usage.curationWeight ?? 0,
                size: event.usage.contextCapacity ?? event.usage.curationBudget ?? 0,
                ...(cost === undefined ? {} : { cost }),
                _meta: {
                    plurnk: {
                        terminal: event,
                    },
                },
            },
        }];
    }

    static replay(
        translator: Translator,
        entries: readonly LogEntryWire[],
        inbox: readonly ApplicationInboxMessage[],
        options: { readonly historyLoops: number; readonly beforeLoopSeq?: number } = { historyLoops: 2 },
    ): {
        readonly updates: AcpSessionUpdate[];
        readonly hasMore: boolean;
        readonly beforeLoopSeq: number | null;
    } {
        const filtered = options.beforeLoopSeq === undefined
            ? entries
            : entries.filter((row) => row.loop_seq < options.beforeLoopSeq!);
        const loopSeqs = [...new Set(filtered.map((row) => row.loop_seq))].toSorted((a, b) => a - b);
        const windowLoopSeqs = loopSeqs.slice(-options.historyLoops);
        const minLoopSeq = windowLoopSeqs[0] ?? null;
        const hasMore = loopSeqs.length > windowLoopSeqs.length;
        const allowedLoops = new Set(windowLoopSeqs);
        const updates: AcpSessionUpdate[] = [];
        for (const row of filtered) {
            if (!allowedLoops.has(row.loop_seq)) continue;
            updates.push(...translator.logEntry({ entry: row }));
        }
        if (options.beforeLoopSeq === undefined) {
            for (const msg of inbox) {
                updates.push({
                    sessionId: translator.#sessionId,
                    update: {
                        sessionUpdate: "_plurnk/inbox",
                        path: msg.path,
                        source: msg.source,
                        loopId: msg.loopId,
                        lifecycle: msg.lifecycle,
                    },
                });
            }
        }
        return {
            updates,
            hasMore,
            beforeLoopSeq: hasMore ? minLoopSeq : null,
        };
    }
}
