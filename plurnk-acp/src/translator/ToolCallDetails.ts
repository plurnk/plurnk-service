// {§acp-body-reference} {§acp-plurnk-metadata} {§acp-topology-scope}
// Diff content blocks, subagent session references, and initial `terminal_update` projection.

import type { ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isRecord, type LogEntryWire } from "@plurnk/plurnk-contracts";
import { buildDiffChanges, buildUnifiedDiff } from "../diff.ts";
import type { TrackedSessionUpdate } from "./PlanTracker.ts";
import { terminalIdForEntry, type StreamCorrelationTracker } from "./StreamTracker.ts";

export const appendDiffContentBlocks = (args: {
    readonly content: ToolCallContent[];
    readonly entry: LogEntryWire;
    readonly address: string | null;
    readonly statusRx: number;
    readonly attrs: Record<string, unknown>;
    readonly parsedTx: unknown;
    readonly omitSettledDiffPatch: boolean;
}): void => {
    const { content, entry, address, statusRx, attrs, parsedTx, omitSettledDiffPatch } = args;
    if (entry.op === null) return;
    if (typeof attrs.patch === "string" && attrs.patch.length > 0) {
        const path = address ?? entry.pathname ?? "";
        content.push({
            type: "diff",
            changes: buildDiffChanges({ op: entry.op, path, statusRx, attrs, parsedTx }),
            ...(omitSettledDiffPatch
                ? {}
                : {
                      patch: { format: "git_patch", text: attrs.patch },
                  }),
        });
        return;
    }
    if (typeof attrs.original === "string" && typeof attrs.patched === "string") {
        const path = address ?? entry.pathname ?? "";
        content.push({
            type: "diff",
            changes: buildDiffChanges({ op: entry.op, path, statusRx, attrs, parsedTx }),
            ...(omitSettledDiffPatch
                ? {}
                : {
                      patch: { format: "git_patch", text: buildUnifiedDiff(path, attrs.original, attrs.patched) },
                  }),
        });
        return;
    }
    if (entry.op === "move" || entry.op === "copy") {
        const path = address ?? entry.pathname ?? "";
        const changes = buildDiffChanges({ op: entry.op, path, statusRx, attrs, parsedTx });
        if (changes.some((c) => c.operation === "move" || c.operation === "copy")) {
            content.push({ type: "diff", changes });
        }
    }
};

export const appendSubagentSessionReference = (args: {
    readonly updates: TrackedSessionUpdate[];
    readonly content: ToolCallContent[];
    readonly acpSessionId: string;
    readonly workspaceId: number;
    readonly sessionName: string;
    readonly entry: LogEntryWire;
    readonly address: string | null;
    readonly attrs: Record<string, unknown>;
    readonly receipt: unknown;
    readonly status: ToolCallStatus;
    readonly effectiveStatusRx: number;
    readonly streams: StreamCorrelationTracker;
}): void => {
    const {
        updates,
        content,
        acpSessionId,
        workspaceId,
        sessionName,
        entry,
        address,
        attrs,
        receipt,
        status,
        effectiveStatusRx,
        streams,
    } = args;
    if (
        (entry.op !== "work" &&
            entry.op !== "fork" &&
            entry.op !== "send" &&
            entry.op !== "read" &&
            entry.op !== "kill") ||
        (status === "failed" && effectiveStatusRx !== 425)
    ) {
        return;
    }
    const rawTargetSession =
        typeof attrs.session === "string" && attrs.session.length > 0
            ? attrs.session.replace(/^session:\/\//u, "")
            : isRecord(receipt) && typeof receipt.session === "string" && receipt.session.length > 0
              ? receipt.session.replace(/^session:\/\//u, "")
              : address !== null && address.startsWith("session://")
                ? address.slice("session://".length)
                : "";
    if (
        rawTargetSession.length === 0 ||
        /[/?#]/u.test(rawTargetSession) ||
        rawTargetSession === sessionName ||
        rawTargetSession === "_plurnk"
    ) {
        return;
    }
    const referencedSessionId = `${workspaceId}#${rawTargetSession}`;
    if (streams.rememberSubagent(referencedSessionId)) {
        updates.push({
            sessionId: acpSessionId,
            update: {
                sessionUpdate: "subagent_update",
                sessionId: referencedSessionId,
                title: rawTargetSession,
                capabilities: { cancel: {} },
                state: entry.op === "fork" ? { state: "idle" } : { state: "running" },
                _meta: { plurnk: { name: rawTargetSession } },
            },
        });
    }
    content.push({ type: "session", sessionId: referencedSessionId });
};

export const buildTerminalOpeningUpdate = (args: {
    readonly acpSessionId: string;
    readonly entryId: number;
    readonly text: string;
    readonly status: ToolCallStatus;
    readonly effectiveStatusRx: number;
    readonly parsedRx: unknown;
    readonly omitSettledTerminalOutput: boolean;
}): TrackedSessionUpdate => {
    const { acpSessionId, entryId, text, status, effectiveStatusRx, parsedRx, omitSettledTerminalOutput } = args;
    const terminalId = terminalIdForEntry(entryId);
    const command = text.length > 0 ? text : undefined;
    const initialOut = omitSettledTerminalOutput
        ? undefined
        : isRecord(parsedRx) && typeof parsedRx.stdout === "string"
          ? parsedRx.stdout + (typeof parsedRx.stderr === "string" ? parsedRx.stderr : "")
          : isRecord(parsedRx) && typeof parsedRx.content === "string"
            ? parsedRx.content
            : undefined;
    return {
        sessionId: acpSessionId,
        update: {
            sessionUpdate: "terminal_update",
            terminalId,
            capabilities: { cancel: status === "in_progress" ? {} : null },
            ...(command !== undefined ? { command } : {}),
            ...(initialOut !== undefined && initialOut.length > 0
                ? { output: { data: Buffer.from(initialOut, "utf8").toString("base64") } }
                : {}),
            ...(status === "completed" || status === "failed"
                ? { exitStatus: { exitCode: effectiveStatusRx === 200 ? 0 : effectiveStatusRx } }
                : {}),
        },
    };
};
