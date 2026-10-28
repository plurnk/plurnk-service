// {§acp-plurnk-metadata} Pure log-entry field extraction and response classification for ACP v2 translation.

import type { ToolCallContent } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isRecord, type LogEntryWire } from "@plurnk/plurnk-contracts";

const MODEL_FACTS: ReadonlySet<string> = new Set(["lineAnchors", "lineAnchorIdentity", "lineNumberWidth"]);

export const extractMessageId = (source: string | null, sessionId: string): string | null => {
    if (typeof source !== "string" || source.length === 0) return null;
    try {
        const url = new URL(source);
        if (url.protocol !== "acp:") return null;
        const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (segments.length === 4 && segments[0] === "sessions" && segments[2] === "messages") {
            return segments[1] === sessionId ? segments[3] ?? null : null;
        }
        return null;
    } catch {
        return null;
    }
};

export const invocationCoordinate = (ref: string | undefined): string | null => {
    if (typeof ref !== "string" || ref.length === 0) return null;
    const match = /^log:\/\/\/(\d+\/\d+\/\d+)(?:\/|$)/u.exec(ref);
    return match?.[1] ?? ref;
};

export const statusOf = (row: { readonly status_rx?: unknown }): number =>
    typeof row.status_rx === "number" ? row.status_rx : 200;

export const parseJsonOrValue = (value: unknown): unknown => {
    if (value === undefined || value === "") return null;
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
};

export const attrRecord = (attrs: unknown): Readonly<Record<string, unknown>> => {
    const parsed = parseJsonOrValue(attrs);
    return isRecord(parsed) ? parsed : {};
};

export const txBody = (tx: unknown, attrs?: Readonly<Record<string, unknown>>, parsedRx?: unknown): string => {
    const parsed = parseJsonOrValue(tx);
    if (typeof parsed === "string") return parsed;
    if (isRecord(parsed)) {
        if (typeof parsed.body === "string") return parsed.body;
        if (isRecord(parsed.body)) {
            if (typeof parsed.body.raw === "string") return parsed.body.raw;
            if (parsed.body.json !== undefined) return JSON.stringify(parsed.body.json);
        }
    }
    if (attrs !== undefined) {
        if (typeof attrs.body === "string") return attrs.body;
        if (typeof attrs.content === "string") return attrs.content;
    }
    if (isRecord(parsedRx) && typeof parsedRx.content === "string") {
        return parsedRx.content;
    }
    return "";
};

export const cleanReceipt = (rx: unknown): {
    readonly receipt: unknown;
    readonly contentBlocks: ToolCallContent[];
} => {
    const parsed = parseJsonOrValue(rx);
    if (!isRecord(parsed)) {
        const text = typeof rx === "string" ? rx : rx == null ? "" : JSON.stringify(rx);
        return {
            receipt: parsed,
            contentBlocks: text.length > 0 ? [{ type: "content", content: { type: "text", text } }] : [],
        };
    }
    const rawContent = typeof parsed.content === "string" && parsed.content.length > 0 ? parsed.content : null;
    const kept = Object.entries(parsed).filter(([key]) => !MODEL_FACTS.has(key));
    const receipt = Object.fromEntries(kept);
    const contentBlocks: ToolCallContent[] = [];
    if (rawContent !== null) {
        contentBlocks.push({
            type: "content",
            content: { type: "text", text: rawContent },
        });
    } else if (isRecord(parsed.problem) && typeof parsed.problem.detail === "string") {
        contentBlocks.push({
            type: "content",
            content: { type: "text", text: parsed.problem.detail },
        });
    }
    return { receipt, contentBlocks };
};

export const isResponseMessage = (
    entry: LogEntryWire,
    parsedRx: unknown,
    attrs: Readonly<Record<string, unknown>>,
    text: string,
    sessionId: string,
): boolean => {
    if ("inherited_history" in entry && entry.inherited_history === 1) return false;
    if (entry.op !== "SEND" && entry.op !== "KILL") return false;
    const statusRx = statusOf(entry);
    if (statusRx < 200 || statusRx >= 300) return false;
    if (text.trim().length === 0) return false;
    const deliveredReply = attrs.kind === "reply";
    if (entry.origin !== "model" && !deliveredReply) return false;
    if (deliveredReply) {
        const sessionName = sessionId.slice(sessionId.indexOf("#") + 1);
        return isRecord(parsedRx)
            && Array.isArray(parsedRx.repliedTo)
            && parsedRx.repliedTo.some((addr) => typeof addr === "string" && addr.startsWith(`message://${sessionName}/`));
    }
    if (entry.scheme === "session" || entry.scheme === "workspace") return false;
    if (typeof attrs.to === "string" && (attrs.to.startsWith("session://") || attrs.to.startsWith("workspace://"))) return false;
    if (isRecord(parsedRx) && Array.isArray(parsedRx.repliedTo)) return true;
    if (attrs.kind === "response" || attrs.kind === "message") return true;
    if (entry.op === "SEND" && (entry.scheme === null || entry.scheme === undefined || entry.scheme === "acp") && !entry.pathname) return true;
    return false;
};
