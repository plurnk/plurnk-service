// {§acp-history-window} Inference-free session history replay and pagination links for ACP v2.

import {
    addressOf,
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
        readonly beforeLoopSeq?: number;
        readonly exactLoopSeq?: number;
    } = {},
): ReplayResult => {
    const activeRows = rows
        .filter((row) => !("inherited_history" in row && row.inherited_history === 1))
        .toSorted(
            (a, b) =>
                (a.loop_seq - b.loop_seq) ||
                (a.turn_seq - b.turn_seq) ||
                (a.sequence - b.sequence) ||
                (a.id - b.id),
        );
    const allLoopSeqs = [...new Set(activeRows.map((r) => r.loop_seq).filter(isSafeInteger))].toSorted((a, b) => a - b);

    let candidateSeqs = allLoopSeqs;
    if (typeof options.exactLoopSeq === "number") {
        candidateSeqs = allLoopSeqs.filter((seq) => seq === options.exactLoopSeq);
    } else if (typeof options.beforeLoopSeq === "number") {
        candidateSeqs = allLoopSeqs.filter((seq) => seq < options.beforeLoopSeq!);
    }

    const selectedLoops =
        typeof options.exactLoopSeq !== "number" &&
        typeof options.historyLoops === "number" &&
        options.historyLoops > 0 &&
        candidateSeqs.length > options.historyLoops
            ? new Set(candidateSeqs.slice(-options.historyLoops))
            : new Set(candidateSeqs);

    const updates: AcpSessionUpdate[] = [];
    for (let i = 0; i < activeRows.length; i += 1) {
        const row = activeRows[i];
        if (!selectedLoops.has(row.loop_seq)) continue;
        updates.push(...translator.logEntry({ entry: row }));
        const attrs = attrRecord(row.attrs);
        if (typeof attrs.stream === "string") {
            const streamEnded = activeRows
                .slice(i + 1)
                .some(
                    (later) =>
                        addressOf(later) === attrs.stream ||
                        later.loop_seq > row.loop_seq ||
                        (later.loop_seq === row.loop_seq && later.turn_seq > row.turn_seq),
                );
            if (streamEnded) {
                updates.push(
                    ...translator.terminalConcluded(row.id, statusOf(row)),
                );
            }
        }
    }

    if (options.beforeLoopSeq === undefined && options.exactLoopSeq === undefined) {
        for (const msg of inbox) {
            if (
                msg.lifecycle !== "running" &&
                msg.lifecycle !== "queued" &&
                msg.lifecycle !== "parked"
            ) {
                continue;
            }
            const messageId = extractMessageId(msg.source ?? msg.path, translator.acpSessionId) ?? msg.path;
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
                        },
                    },
                },
            });
        }
    }

    const selectedSorted = [...selectedLoops].toSorted((a, b) => a - b);
    const oldestSelected = selectedSorted[0];
    const newestSelected = selectedSorted.at(-1);
    const hasOlder = oldestSelected !== undefined && allLoopSeqs.some((seq) => seq < oldestSelected);
    const hasNewer = newestSelected !== undefined && allLoopSeqs.some((seq) => seq > newestSelected);

    const baseOrigin = translator.origin ?? "http://127.0.0.1";
    const messagesBase = `${baseOrigin}/acp/${translator.workspaceId}/${translator.sessionId}/messages?session=${encodeURIComponent(translator.acpSessionId)}`;
    const history: ReplayHistoryLinks = {
        ...(hasOlder && oldestSelected !== undefined ? { older: `${messagesBase}&before=${oldestSelected}` } : {}),
        ...(hasNewer && newestSelected !== undefined ? { newer: `${messagesBase}&after=${newestSelected}` } : {}),
    };

    return Object.assign(updates, { updates, history });
};
