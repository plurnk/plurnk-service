// {§acp-history-window} Inference-free session history replay and pagination links for ACP v2.

import {
    addressOf,
    extractActor,
    isRecord,
    isSafeInteger,
    type ApplicationInboxMessage,
    type LogEntryWire,
} from "@plurnk/plurnk-contracts";
import { attrRecord, extractMessageId, statusOf } from "./log-entry-projection.ts";
import type SessionTranslator from "./SessionTranslator.ts";
import type { AcpSessionUpdate } from "./SessionTranslator.ts";

interface ReplayHistoryLinks {
    readonly older?: string;
    readonly newer?: string;
}

export type ReplayResult = AcpSessionUpdate[] & {
    readonly updates: AcpSessionUpdate[];
    readonly history: ReplayHistoryLinks;
};

export const replaySessionHistory = (
    translator: SessionTranslator,
    rows: readonly LogEntryWire[],
    inbox: readonly ApplicationInboxMessage[] = [],
    options: {
        readonly historyLoops?: number;
        readonly historyPageChars?: number;
        readonly beforeLoopSeq?: number;
        readonly afterLoopSeq?: number;
        readonly exactLoopSeq?: number;
        readonly hasOlderHint?: boolean;
        readonly hasNewerHint?: boolean;
        readonly openStreamTargets?: ReadonlySet<string>;
    } = {},
): ReplayResult => {
    const activeRows = rows
        .filter((row) => !("inherited_history" in row && row.inherited_history === 1))
        .toSorted(
            (a, b) =>
                (a.loopSeq - b.loopSeq) ||
                (a.turnSeq - b.turnSeq) ||
                (a.sequence - b.sequence) ||
                (a.id - b.id),
        );

    const allLoopSeqs = [...new Set(activeRows.map((r) => r.loopSeq).filter(isSafeInteger))].toSorted(
        (a, b) => a - b,
    );

    let candidateSeqs = allLoopSeqs;
    if (typeof options.exactLoopSeq === "number") {
        candidateSeqs = allLoopSeqs.filter((seq) => seq === options.exactLoopSeq);
    } else if (typeof options.beforeLoopSeq === "number") {
        candidateSeqs = allLoopSeqs.filter((seq) => seq < options.beforeLoopSeq!);
    } else if (typeof options.afterLoopSeq === "number") {
        candidateSeqs = allLoopSeqs.filter((seq) => seq > options.afterLoopSeq!);
    }

    const selectedLoops =
        typeof options.exactLoopSeq !== "number" &&
        typeof options.historyLoops === "number" &&
        options.historyLoops > 0 &&
        candidateSeqs.length > options.historyLoops
            ? new Set(
                  typeof options.afterLoopSeq === "number"
                      ? candidateSeqs.slice(0, options.historyLoops)
                      : candidateSeqs.slice(-options.historyLoops),
              )
            : new Set(candidateSeqs);

    const updatesByLoop = new Map<number, AcpSessionUpdate[]>();
    for (let i = 0; i < activeRows.length; i += 1) {
        const row = activeRows[i];
        if (!selectedLoops.has(row.loopSeq)) continue;
        const bucket = updatesByLoop.get(row.loopSeq) ?? [];
        bucket.push(...translator.logEntry({ entry: row }));
        const attrs = attrRecord(row.attrs);
        if (typeof attrs.stream === "string") {
            const streamEnded =
                (options.openStreamTargets !== undefined && !options.openStreamTargets.has(attrs.stream)) ||
                activeRows
                    .slice(i + 1)
                    .some(
                        (later) =>
                            addressOf(later) === attrs.stream ||
                            later.loopSeq > row.loopSeq ||
                            (later.loopSeq === row.loopSeq && later.turnSeq > row.turnSeq),
                    );
            if (streamEnded) {
                bucket.push(
                    ...translator.terminalConcluded(row.id, statusOf(row), { target: attrs.stream }),
                );
            }
        }
        updatesByLoop.set(row.loopSeq, bucket);
    }

    let trimmedSingleLoopSeq: number | undefined;
    if (
        typeof options.exactLoopSeq !== "number" &&
        typeof options.historyPageChars === "number" &&
        options.historyPageChars > 0 &&
        selectedLoops.size > 0
    ) {
        const orderedSelected = [...selectedLoops].toSorted((a, b) => a - b);
        const charsByLoop = new Map<number, number>();
        let totalChars = 0;
        for (const seq of orderedSelected) {
            const len = JSON.stringify(updatesByLoop.get(seq) ?? []).length;
            charsByLoop.set(seq, len);
            totalChars += len;
        }
        if (selectedLoops.size > 1) {
            if (typeof options.afterLoopSeq === "number") {
                for (let i = orderedSelected.length - 1; i > 0 && totalChars > options.historyPageChars; i -= 1) {
                    const dropSeq = orderedSelected[i];
                    selectedLoops.delete(dropSeq);
                    updatesByLoop.delete(dropSeq);
                    totalChars -= charsByLoop.get(dropSeq) ?? 0;
                }
            } else {
                for (let i = 0; i < orderedSelected.length - 1 && totalChars > options.historyPageChars; i += 1) {
                    const dropSeq = orderedSelected[i];
                    selectedLoops.delete(dropSeq);
                    updatesByLoop.delete(dropSeq);
                    totalChars -= charsByLoop.get(dropSeq) ?? 0;
                }
            }
        }
        if (selectedLoops.size === 1 && totalChars > options.historyPageChars) {
            const [onlySeq] = selectedLoops;
            const loopUpdates = updatesByLoop.get(onlySeq) ?? [];
            const openingUpdates: AcpSessionUpdate[] = [];
            let idx = 0;
            while (
                idx < loopUpdates.length &&
                (loopUpdates[idx].update.sessionUpdate === "user_message_chunk" ||
                    loopUpdates[idx].update.sessionUpdate === "user_message")
            ) {
                openingUpdates.push(loopUpdates[idx]);
                idx += 1;
            }
            const turnBuckets: Array<{ readonly turnSeq: number | null; readonly items: AcpSessionUpdate[]; readonly chars: number }> = [];
            for (; idx < loopUpdates.length; idx += 1) {
                const item = loopUpdates[idx];
                const meta = isRecord(item.update._meta) && isRecord(item.update._meta.plurnk)
                    ? item.update._meta.plurnk
                    : undefined;
                const turnSeq = isSafeInteger(meta?.turnSeq) ? meta.turnSeq : null;
                const prev = turnBuckets.at(-1);
                if (prev !== undefined && prev.turnSeq === turnSeq && turnSeq !== null) {
                    prev.items.push(item);
                } else {
                    turnBuckets.push({ turnSeq, items: [item], chars: 0 });
                }
            }
            const sizedBuckets = turnBuckets.map((b) => ({
                ...b,
                chars: JSON.stringify(b.items).length,
            }));
            const openingChars = JSON.stringify(openingUpdates).length;
            let remainingChars = openingChars + sizedBuckets.reduce((sum, b) => sum + b.chars, 0);
            let dropCount = 0;
            while (dropCount < sizedBuckets.length - 1 && remainingChars > options.historyPageChars) {
                remainingChars -= sizedBuckets[dropCount].chars;
                dropCount += 1;
            }
            if (dropCount > 0) {
                trimmedSingleLoopSeq = onlySeq;
                updatesByLoop.set(onlySeq, [
                    ...openingUpdates,
                    ...sizedBuckets.slice(dropCount).flatMap((b) => b.items),
                ]);
            }
        }
    }

    const updates: AcpSessionUpdate[] = [];
    for (const seq of [...selectedLoops].toSorted((a, b) => a - b)) {
        updates.push(...(updatesByLoop.get(seq) ?? []));
    }

    const selectedSorted = [...selectedLoops].toSorted((a, b) => a - b);
    const oldestSelected = selectedSorted[0];
    const newestSelected = selectedSorted.at(-1);
    const hasOlder =
        trimmedSingleLoopSeq !== undefined ||
        options.hasOlderHint === true ||
        (oldestSelected !== undefined && allLoopSeqs.some((seq) => seq < oldestSelected));
    const hasNewer =
        options.hasNewerHint === true ||
        (newestSelected !== undefined && allLoopSeqs.some((seq) => seq > newestSelected));

    if (options.beforeLoopSeq === undefined && options.exactLoopSeq === undefined && !hasNewer) {
        const publishedSources = new Set<string>();
        const publishedMessageIds = new Set<string>();
        for (const row of activeRows) {
            if (row.op !== "send") continue;
            if (typeof row.source === "string" && row.source.length > 0) {
                publishedSources.add(row.source);
                const mid = extractMessageId(row.source, translator.acpSessionId);
                if (mid !== null) publishedMessageIds.add(mid);
            }
        }
        for (const msg of inbox) {
            if (
                msg.lifecycle !== "running" &&
                msg.lifecycle !== "queued" &&
                msg.lifecycle !== "parked" &&
                msg.lifecycle !== "cancelled"
            ) {
                continue;
            }
            const messageId = extractMessageId(msg.source ?? msg.path, translator.acpSessionId) ?? msg.path;
            if (
                (typeof msg.source === "string" && publishedSources.has(msg.source)) ||
                publishedSources.has(msg.path) ||
                publishedMessageIds.has(messageId)
            ) {
                continue;
            }
            const inboxUrl =
                translator.origin !== undefined && translator.origin.length > 0
                    ? `${translator.origin}/acp/${translator.workspaceId}/${translator.sessionId}/entry?target=${encodeURIComponent(msg.path)}`
                    : undefined;
            const inboxActor = extractActor(msg.source ?? msg.path);
            updates.push({
                sessionId: translator.acpSessionId,
                update: {
                    sessionUpdate: "user_message_chunk",
                    messageId,
                    content: { type: "text", text: msg.body },
                    _meta: {
                        plurnk: {
                            loopId: msg.loopId,
                            lifecycle: msg.lifecycle,
                            published: false,
                            ...(typeof msg.source === "string" ? { source: msg.source } : {}),
                            ...(inboxActor !== undefined ? { actor: inboxActor } : {}),
                            ...(inboxUrl !== undefined
                                ? { body: { url: inboxUrl, mimeType: "text/plain" } }
                                : {}),
                        },
                    },
                },
            });
        }
    }

    const baseOrigin = translator.origin ?? "http://127.0.0.1";
    const modeParams = `${translator.reasoningMode === "link" ? "&reasoning=link" : ""}${translator.bodiesMode === "link" ? "&bodies=link" : ""}`;
    const messagesBase = `${baseOrigin}/acp/${translator.workspaceId}/${translator.sessionId}/messages?session=${encodeURIComponent(translator.acpSessionId)}${modeParams}`;
    const history: ReplayHistoryLinks = {
        ...(trimmedSingleLoopSeq !== undefined
            ? { older: `${messagesBase}&loop=${trimmedSingleLoopSeq}` }
            : hasOlder && oldestSelected !== undefined
              ? { older: `${messagesBase}&before=${oldestSelected}` }
              : {}),
        ...(hasNewer && newestSelected !== undefined ? { newer: `${messagesBase}&after=${newestSelected}` } : {}),
    };

    return Object.assign(updates, { updates, history });
};
