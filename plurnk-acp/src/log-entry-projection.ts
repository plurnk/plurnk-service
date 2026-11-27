// {§acp-plurnk-metadata} Pure log-entry field extraction and response classification for ACP v2 translation.

import type { ToolCallContent } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    extractActor,
    isRecord,
    isSafeInteger,
    type ApplicationInboxMessage,
    type LogEntryWire,
} from "@plurnk/plurnk-contracts";
import type { AcpInboxItem } from "./client.ts";

const MODEL_FACTS: ReadonlySet<string> = new Set(["lineAnchors", "lineAnchorIdentity", "lineNumberWidth"]);
const BODY_ATTR_KEYS: ReadonlySet<string> = new Set(["original", "patched", "patch", "body", "content"]);
const TOOL_CHANNEL_IMAGE_LINE = /^<(?:session|mcp|file):\/\/[^>\s]+>\s+—\s+image\/(?:png|jpeg|gif|webp)$/iu;

export const stripBodyAttrs = (attrs: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
    Object.fromEntries(Object.entries(attrs).filter(([key]) => !BODY_ATTR_KEYS.has(key)));

export const extractMessageId = (source: string | null | undefined, sessionId: string): string | null => {
    if (typeof source !== "string" || source.length === 0) return null;
    try {
        const url = new URL(source);
        if (url.protocol !== "acp:") return null;
        const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (segments.length === 4 && segments[0] === "sessions" && segments[2] === "messages") {
            const sourceSession = segments[1] ?? "";
            const sourceUnqualified = sourceSession.includes("#")
                ? sourceSession.slice(sourceSession.indexOf("#") + 1)
                : sourceSession;
            const targetUnqualified = sessionId.includes("#")
                ? sessionId.slice(sessionId.indexOf("#") + 1)
                : sessionId;
            return sourceSession === sessionId || sourceUnqualified === targetUnqualified
                ? (segments[3] ?? null)
                : null;
        }
        return null;
    } catch {
        return null;
    }
};

export const readAllLogEntries = async (
    seam: {
        readonly readLog: (args: {
            readonly workspaceId: number;
            readonly sessionId: number;
            readonly loopId?: number;
            readonly loopSeq?: number;
            readonly beforeLoopSeq?: number;
            readonly afterLoopSeq?: number;
            readonly lastLoops?: number;
            readonly beforeId?: number;
            readonly limit?: number;
        }) => Promise<LogEntryWire[]>;
    },
    args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly loopId?: number;
        readonly loopSeq?: number;
        readonly beforeLoopSeq?: number;
        readonly afterLoopSeq?: number;
        readonly lastLoops?: number;
    },
): Promise<LogEntryWire[]> => {
    const all: LogEntryWire[] = [];
    const seenIds = new Set<number>();
    let beforeId: number | undefined;
    for (;;) {
        const page = await seam.readLog({
            workspaceId: args.workspaceId,
            sessionId: args.sessionId,
            ...(args.loopId !== undefined ? { loopId: args.loopId } : {}),
            ...(args.loopSeq !== undefined ? { loopSeq: args.loopSeq } : {}),
            ...(args.beforeLoopSeq !== undefined ? { beforeLoopSeq: args.beforeLoopSeq } : {}),
            ...(args.afterLoopSeq !== undefined ? { afterLoopSeq: args.afterLoopSeq } : {}),
            ...(args.lastLoops !== undefined ? { lastLoops: args.lastLoops } : {}),
            ...(beforeId !== undefined ? { beforeId } : {}),
        });
        if (page.length === 0) break;
        let added = 0;
        let minId = Infinity;
        for (const row of page) {
            if (row.id < minId) minId = row.id;
            if (!seenIds.has(row.id)) {
                seenIds.add(row.id);
                all.push(row);
                added += 1;
            }
        }
        if (added === 0 || !Number.isFinite(minId) || minId <= 1) break;
        if (beforeId !== undefined && minId >= beforeId) break;
        beforeId = minId;
    }
    return all;
};

export const projectInboxItems = (
    messages: readonly ApplicationInboxMessage[],
    acpSessionId: string,
    origin: string,
    workspaceId: number,
    sessionId: number,
): AcpInboxItem[] =>
    messages.map((msg) => {
        const actor = extractActor(msg.source ?? msg.path, msg.actor);
        return {
            path: msg.path,
            id: extractMessageId(msg.source ?? msg.path, acpSessionId),
            ...(actor !== undefined ? { actor } : {}),
            ...(msg.actor !== undefined ? { actorProfile: msg.actor } : {}),
            loopId: msg.loopId,
            lifecycle: msg.lifecycle,
            ...(origin.length > 0
                ? {
                      body: {
                          url: `${origin}/acp/${workspaceId}/${sessionId}/entry?target=${encodeURIComponent(msg.path)}`,
                          mimeType: "text/plain",
                      },
                  }
                : {}),
        };
    });

export const invocationCoordinate = (ref: string | undefined): string | null => {
    if (typeof ref !== "string" || ref.length === 0) return null;
    const match = /^log:\/\/\/(\d+\/\d+\/\d+)(?:\/|$)/u.exec(ref);
    return match?.[1] ?? ref;
};

export const statusOf = (row: { readonly statusRx?: unknown }): number =>
    typeof row.statusRx === "number" ? row.statusRx : 200;

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
        if (parsed.op === "wait" && typeof parsed.aside === "string") return parsed.aside;
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

export const cleanReceipt = (
    rx: unknown,
    bodyUrl?: string,
    targetName?: string,
    options?: {
        readonly linkBodies?: boolean;
        readonly mimeType?: string | null;
    },
): {
    readonly receipt: unknown;
    readonly contentBlocks: ToolCallContent[];
} => {
    const parsed = parseJsonOrValue(rx);
    if (!isRecord(parsed)) {
        const text = typeof rx === "string" ? rx : rx == null ? "" : JSON.stringify(rx);
        if (options?.linkBodies === true && text.length > 0 && typeof bodyUrl === "string" && bodyUrl.length > 0) {
            return {
                receipt: parsed,
                contentBlocks: [
                    {
                        type: "content",
                        content: {
                            type: "resource_link",
                            name: targetName ?? "result",
                            uri: bodyUrl,
                            ...(typeof options.mimeType === "string" && options.mimeType.length > 0
                                ? { mimeType: options.mimeType }
                                : {}),
                        },
                    },
                ],
            };
        }
        return {
            receipt: parsed,
            contentBlocks: text.length > 0 ? [{ type: "content", content: { type: "text", text } }] : [],
        };
    }
    const rawContent = typeof parsed.content === "string" && parsed.content.length > 0 ? parsed.content : null;
    const status = typeof parsed.status === "number" ? parsed.status : 200;
    const useReference = rawContent !== null && status < 400 && typeof bodyUrl === "string" && bodyUrl.length > 0;
    const kept = Object.entries(parsed).filter(
        ([key]) => !MODEL_FACTS.has(key) && (!useReference || key !== "content"),
    );
    const receipt = Object.fromEntries(kept);
    const contentBlocks: ToolCallContent[] = [];
    if (rawContent !== null) {
        if (options?.linkBodies === true && useReference && bodyUrl !== undefined) {
            const channelImageLines = rawContent
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => TOOL_CHANNEL_IMAGE_LINE.test(line));
            if (channelImageLines.length > 0) {
                contentBlocks.push({
                    type: "content",
                    content: { type: "text", text: channelImageLines.join("\n") },
                });
            }
            const resolvedMime =
                typeof parsed.mimetype === "string" && parsed.mimetype.length > 0
                    ? parsed.mimetype
                    : typeof options.mimeType === "string" && options.mimeType.length > 0
                      ? options.mimeType
                      : undefined;
            contentBlocks.push({
                type: "content",
                content: {
                    type: "resource_link",
                    name: targetName ?? "result",
                    uri: bodyUrl,
                    ...(resolvedMime !== undefined ? { mimeType: resolvedMime } : {}),
                },
            });
        } else {
            contentBlocks.push({
                type: "content",
                content: { type: "text", text: rawContent },
            });
        }
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
    if (entry.op !== "send" && entry.op !== "done" && entry.op !== "fail" && entry.op !== "kill") return false;
    const statusRx = statusOf(entry);
    if (statusRx < 200 || statusRx >= 300) return false;
    if (text.trim().length === 0) return false;
    const deliveredReply = attrs.kind === "reply";
    if (entry.origin !== "model" && !deliveredReply) return false;
    const repliedToList = isRecord(parsedRx)
        ? Array.isArray(parsedRx.repliedTo)
            ? parsedRx.repliedTo
            : isRecord(parsedRx.receipt) && Array.isArray(parsedRx.receipt.repliedTo)
              ? parsedRx.receipt.repliedTo
              : null
        : null;
    if (deliveredReply) {
        const sessionName = sessionId.slice(sessionId.indexOf("#") + 1);
        return repliedToList !== null
            && repliedToList.some((addr) => typeof addr === "string" && addr.startsWith(`message://${sessionName}/`));
    }
    if (entry.scheme === "session" || entry.scheme === "workspace") return false;
    if (typeof attrs.to === "string" && (attrs.to.startsWith("session://") || attrs.to.startsWith("workspace://"))) return false;
    if (repliedToList !== null) return true;
    if (attrs.kind === "response" || attrs.kind === "message") return true;
    if (
        (entry.op === "send" || entry.op === "done" || entry.op === "fail") &&
        (entry.scheme === null ||
            entry.scheme === undefined ||
            entry.scheme === "acp" ||
            entry.scheme === "message")
    ) {
        return true;
    }
    return false;
};

export const extractStartLine = (
    attrs: Readonly<Record<string, unknown>>,
    parsedTx?: unknown,
    parsedRx?: unknown,
): number | undefined => {
    for (const candidate of [attrs.line, attrs.startLine]) {
        if (isSafeInteger(candidate) && candidate >= 1) {
            return candidate;
        }
    }
    if (isRecord(parsedTx) && isRecord(parsedTx.lineMarker) && Array.isArray(parsedTx.lineMarker.marks)) {
        const firstMark = parsedTx.lineMarker.marks[0];
        if (isSafeInteger(firstMark) && firstMark >= 1) {
            return firstMark;
        }
        if (typeof firstMark === "string") {
            const match = /^:?(\d+)/u.exec(firstMark);
            if (match !== null) {
                const parsed = Number.parseInt(match[1] ?? "", 10);
                if (isSafeInteger(parsed) && parsed >= 1) return parsed;
            }
        }
    }
    if (isRecord(parsedRx)) {
        if (isRecord(parsedRx.range) && parsedRx.range.unit === "line" && Array.isArray(parsedRx.range.returned)) {
            const start = parsedRx.range.returned[0];
            if (isSafeInteger(start) && start >= 1) {
                return start;
            }
        }
        if (isRecord(parsedRx.receipt)) {
            const effectObj = isRecord(parsedRx.receipt.effect)
                ? parsedRx.receipt.effect
                : isRecord(parsedRx.receipt.replacement)
                  ? parsedRx.receipt.replacement
                  : null;
            const span = typeof effectObj?.result === "string"
                ? effectObj.result
                : typeof parsedRx.receipt.requested === "string"
                  ? parsedRx.receipt.requested
                  : null;
            if (span !== null) {
                const match = /^:?(\d+)/u.exec(span);
                if (match !== null) {
                    const parsed = Number.parseInt(match[1] ?? "", 10);
                    if (isSafeInteger(parsed) && parsed >= 1) return parsed;
                }
            }
        }
    }
    return undefined;
};
