// {§acp-plurnk-metadata} {§acp-history-window} Pure standard ACP v2 projection from daemon events onto ACP v2 SessionUpdate notifications.

import type {
    SessionUpdate,
    ToolCallContent,
    ToolCallStatus,
    ToolKind,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    addressOf,
    extractActor,
    extractExteriorActorId,
    isRecord,
    isSafeInteger,
    normalizeExteriorActorProfiles,
    toolKindOf,
    type ApplicationInboxMessage,
    type ApplicationLoopPacket,
    type ExteriorActorProfile,
    type LogEntryNotification,
    type LogEntryWire,
    type Notice,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import {
    attrRecord,
    cleanReceipt,
    extractMessageId,
    extractStartLine,
    invocationCoordinate,
    isResponseMessage,
    parseJsonOrValue,
    statusOf,
    stripBodyAttrs,
    txBody,
} from "./log-entry-projection.ts";
import { replaySessionHistory, type ReplayResult } from "./replay.ts";
import { PlanTracker } from "./translator/PlanTracker.ts";
import { StreamCorrelationTracker, terminalIdForEntry } from "./translator/StreamTracker.ts";
import {
    appendDiffContentBlocks,
    appendSubagentSessionReference,
    buildTerminalOpeningUpdate,
} from "./translator/ToolCallDetails.ts";
import {
    translateNoticeUpdates,
    translatePacketUpdates,
    translateReasoningUpdates,
    translateTerminatedUpdates,
} from "./translator/UsageAndNotice.ts";

export { terminalIdForEntry };

export interface AcpSessionUpdate {
    readonly sessionId: string;
    readonly update: SessionUpdate;
}

export default class SessionTranslator {
    readonly #acpSessionId: string;
    readonly #workspaceId: number;
    readonly #sessionId: number;
    readonly #sessionName: string;
    readonly #origin: string | undefined;
    readonly #streams: StreamCorrelationTracker;
    readonly #plan: PlanTracker;
    #reasoningMode: "inline" | "link" = "inline";
    #bodiesMode: "inline" | "link" = "inline";

    constructor(args: {
        readonly acpSessionId: string;
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly sessionName?: string;
        readonly origin?: string;
        readonly reasoningMode?: "inline" | "link";
        readonly bodiesMode?: "inline" | "link";
        readonly historyPageChars?: number;
        readonly streamTombstones?: number;
    }) {
        this.#acpSessionId = args.acpSessionId;
        this.#workspaceId = args.workspaceId;
        this.#sessionId = args.sessionId;
        const hashIdx = args.acpSessionId.indexOf("#");
        this.#sessionName =
            args.sessionName ??
            (hashIdx > 0 && hashIdx < args.acpSessionId.length - 1
                ? args.acpSessionId.slice(hashIdx + 1)
                : args.acpSessionId);
        this.#origin = args.origin;
        if (args.reasoningMode !== undefined) {
            this.#reasoningMode = args.reasoningMode;
        }
        if (args.bodiesMode !== undefined) {
            this.#bodiesMode = args.bodiesMode;
        }
        this.#streams = new StreamCorrelationTracker(args.streamTombstones);
        this.#plan = new PlanTracker(args.acpSessionId);
    }

    clear(): void {
        this.#streams.clear();
        this.#plan.clear();
    }

    get acpSessionId(): string { return this.#acpSessionId; }
    get workspaceId(): number { return this.#workspaceId; }
    get sessionId(): number { return this.#sessionId; }
    get origin(): string | undefined { return this.#origin; }
    get reasoningMode(): "inline" | "link" { return this.#reasoningMode; }
    get bodiesMode(): "inline" | "link" { return this.#bodiesMode; }

    configureModes(modes: {
        readonly reasoning?: "inline" | "link";
        readonly bodies?: "inline" | "link";
    }): void {
        if (modes.reasoning !== undefined) this.#reasoningMode = modes.reasoning;
        if (modes.bodies !== undefined) this.#bodiesMode = modes.bodies;
    }

    static coordinateOf(row: { readonly loopSeq?: unknown; readonly turnSeq?: unknown; readonly sequence?: unknown }): string {
        if (!isSafeInteger(row.loopSeq) || !isSafeInteger(row.turnSeq) || !isSafeInteger(row.sequence)) {
            throw new TypeError(`Log entry missing logical coordinate: ${JSON.stringify(row)}`);
        }
        return `${row.loopSeq}/${row.turnSeq}/${row.sequence}`;
    }

    static toolKindOf(op: string | null, scheme: string | null): ToolKind {
        return toolKindOf(op, scheme);
    }

    static toolStatusOf(row: { readonly state?: unknown; readonly statusRx?: unknown; readonly attrs?: unknown }): ToolCallStatus {
        if (row.state === "proposed") return "pending";
        const statusRx = statusOf(row);
        if (row.state === "failed" || row.state === "cancelled" || statusRx >= 400) {
            return "failed";
        }
        const attrs = attrRecord(row.attrs);
        if (statusRx < 400 && typeof attrs.stream === "string") {
            return "in_progress";
        }
        return "completed";
    }

    logEntry({ entry }: LogEntryNotification): AcpSessionUpdate[] {
        if (entry.sessionId !== this.#sessionId) return [];
        const updates: AcpSessionUpdate[] = [];
        const prunedPlanUpdate = this.#plan.advanceTurn(entry);
        if (prunedPlanUpdate !== null) {
            updates.push(prunedPlanUpdate);
        }

        const coordinate = SessionTranslator.coordinateOf(entry);
        const attrs = attrRecord(entry.attrs);
        const parsedTx = parseJsonOrValue(entry.tx);
        const parsedRx = parseJsonOrValue(entry.rx);
        const text = txBody(parsedTx, attrs, parsedRx);
        const leaf = entry.op ?? (attrs.kind === "emissionAttempt" ? "attempt" : null);
        const bodyUrl =
            this.#origin !== undefined && leaf !== null
                ? `${this.#origin}/acp/${this.#workspaceId}/${this.#sessionId}/entry?target=${encodeURIComponent(`log:///${coordinate}/${leaf}`)}`
                : undefined;
        const { receipt, contentBlocks } = cleanReceipt(
            entry.rx,
            bodyUrl,
            leaf !== null ? `log:///${coordinate}/${leaf}` : undefined,
            { linkBodies: this.#bodiesMode === "link", mimeType: entry.mimetypeRx },
        );
        const rawAddress = addressOf(entry);
        const address =
            rawAddress ??
            (typeof attrs.path === "string"
                ? attrs.path
                : typeof attrs.session === "string" && attrs.session.length > 0
                  ? attrs.session.includes("://")
                      ? attrs.session
                      : `session://${attrs.session}`
                  : typeof attrs.to === "string" && attrs.to.length > 0
                    ? attrs.to
                    : typeof entry.scheme === "string" && typeof entry.hostname === "string" && entry.hostname.length > 0
                      ? `${entry.scheme}://${entry.hostname}`
                      : null);
        const statusRx = statusOf(entry);

        const reasoningText = typeof entry.reasoning === "string" && entry.reasoning.length > 0 ? entry.reasoning : null;
        const sessionName =
            typeof entry.sessionName === "string" && entry.sessionName.length > 0
                ? entry.sessionName
                : this.#sessionName;
        const turnCoordinate = `${entry.loopSeq}/${entry.turnSeq}`;
        const reasoningUrl =
            reasoningText !== null && this.#origin !== undefined
                ? `${this.#origin}/acp/${this.#workspaceId}/${this.#sessionId}/entry?target=${encodeURIComponent(`reasoning://${sessionName}/${turnCoordinate}`)}`
                : undefined;
        const reasoningTurnKey = `${entry.sessionId}:${entry.turnId}`;
        const reasoningResourceName = `reasoning://${sessionName}/${turnCoordinate}`;
        if (entry.op !== null && reasoningText !== null && !this.#streams.hasStreamedReasoning(reasoningTurnKey)) {
            this.#streams.rememberReasoningTurn(reasoningTurnKey);
            const thoughtMessageId = entry.reasoningModelCallId !== null && entry.reasoningModelCallId !== undefined
                ? `model-call-${entry.reasoningModelCallId}/request-${entry.reasoningRequestSequence ?? 1}/reasoning`
                : `${coordinate}/reasoning`;
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: thoughtMessageId,
                    content:
                        this.#reasoningMode === "link" && reasoningUrl !== undefined
                            ? {
                                  type: "resource_link",
                                  name: reasoningResourceName,
                                  uri: reasoningUrl,
                                  mimeType: "text/plain",
                              }
                            : { type: "text", text: reasoningText },
                    _meta: {
                        plurnk: {
                            sessionId: entry.sessionId,
                            sessionName,
                            loopId: entry.loopId,
                            loopSeq: entry.loopSeq,
                            turnId: entry.turnId,
                            turnSeq: entry.turnSeq,
                            coordinate: turnCoordinate,
                            ...(reasoningUrl !== undefined ? { body: { url: reasoningUrl, mimeType: "text/plain" } } : {}),
                        },
                    },
                },
            });
        }

        const isResponse = isResponseMessage(entry, parsedRx, attrs, text, this.#acpSessionId);
        const isBodiedWait = entry.origin === "model" && entry.op === "wait" && text.trim().length > 0;
        const repliedToSources =
            Array.isArray(entry.repliedToSources) && entry.repliedToSources.length > 0
                ? entry.repliedToSources.filter((s): s is string => typeof s === "string" && s.length > 0)
                : undefined;
        const repliedToMessageIds =
            repliedToSources !== undefined
                ? repliedToSources
                      .map((src) => extractMessageId(src, this.#acpSessionId))
                      .filter((id): id is string => id !== null)
                : undefined;
        const rawRepliedTo =
            isRecord(receipt) && Array.isArray(receipt.repliedTo)
                ? receipt.repliedTo.map((src) => (typeof src === "string" ? src : undefined))
                : [];
        const repliedToKeyActors = rawRepliedTo
            .map((src) => extractActor(src))
            .filter((a): a is string => typeof a === "string" && a.length > 0);
        const replyActorProfiles = normalizeExteriorActorProfiles(entry.repliedToActors);
        const seenReplyActorIds = new Set(replyActorProfiles.map((p) => p.id));
        if (repliedToSources !== undefined) {
            for (const [index, src] of repliedToSources.entries()) {
                const fallbackId = extractExteriorActorId(src);
                if (fallbackId !== undefined && !seenReplyActorIds.has(fallbackId)) {
                    seenReplyActorIds.add(fallbackId);
                    const keyHandle = extractActor(rawRepliedTo[index]);
                    replyActorProfiles.push({ id: fallbackId, handle: keyHandle ?? fallbackId });
                }
            }
        } else {
            const directTargetId = extractExteriorActorId(address);
            if (directTargetId !== undefined && !seenReplyActorIds.has(directTargetId)) {
                seenReplyActorIds.add(directTargetId);
                replyActorProfiles.push({ id: directTargetId, handle: directTargetId });
            }
        }
        const enrichedReceipt = isRecord(receipt)
            ? {
                  ...receipt,
                  ...(repliedToMessageIds !== undefined && repliedToMessageIds.length > 0 ? { repliedToMessageIds } : {}),
                  ...(repliedToSources !== undefined && repliedToSources.length > 0 ? { repliedToSources } : {}),
                  ...(replyActorProfiles.length > 0 ? { repliedToActors: replyActorProfiles } : {}),
              }
            : receipt;
        const addressActor =
            address !== null &&
            (address.startsWith("session://") ||
                address.startsWith("schedule://") ||
                (replyActorProfiles.length === 0 && repliedToKeyActors.length === 0))
                ? extractActor(address)
                : undefined;
        const replyActors = [
            ...new Set([
                ...(repliedToSources ?? [])
                    .filter((src) => src.startsWith("session://"))
                    .map((src) => extractActor(src)),
                ...replyActorProfiles.map((p) => p.handle),
                ...(replyActorProfiles.length > 0
                    ? []
                    : repliedToKeyActors.length > 0
                      ? repliedToKeyActors
                      : (repliedToSources ?? [])
                            .filter((src) => !src.startsWith("session://"))
                            .map((src) => extractActor(src))),
                addressActor,
            ]),
        ].filter((a): a is string => typeof a === "string" && a.length > 0);
        const replyActor = replyActors[0];
        const attrsActor: ExteriorActorProfile | undefined =
            isRecord(attrs.actor) && typeof attrs.actor.id === "string" && typeof attrs.actor.handle === "string"
                ? {
                      id: attrs.actor.id,
                      handle: attrs.actor.handle,
                      ...(typeof attrs.actor.name === "string" && attrs.actor.name.length > 0
                          ? { name: attrs.actor.name }
                          : {}),
                  }
                : undefined;
        const strippedAttrs = stripBodyAttrs(attrs);
        const opMeta = {
            id: entry.id,
            sessionId: entry.sessionId,
            sessionName,
            coordinate,
            op: entry.op,
            origin: entry.origin,
            status: statusRx,
            turnId: entry.turnId,
            turnSeq: entry.turnSeq,
            loopId: entry.loopId,
            loopSeq: entry.loopSeq,
            sequence: entry.sequence,
            scope: null,
            ...(typeof entry.state === "string" ? { state: entry.state } : {}),
            ...(typeof entry.source === "string" ? { source: entry.source } : {}),
            ...(typeof entry.signal === "number" ? { signal: entry.signal } : {}),
            ...(address !== null ? { address, target: address } : {}),
            ...(replyActor !== undefined ? { actor: replyActor } : {}),
            ...(replyActorProfiles[0] !== undefined
                ? { actorProfile: replyActorProfiles[0], actorProfiles: replyActorProfiles }
                : {}),
            ...(replyActors.length > 0 ? { actors: replyActors } : {}),
            ...(Object.keys(strippedAttrs).length > 0 ? { attrs: strippedAttrs } : {}),
            ...(isRecord(enrichedReceipt) ? { receipt: enrichedReceipt } : {}),
            ...(reasoningUrl !== undefined ? { reasoning: { url: reasoningUrl, mimeType: "text/plain" } } : {}),
        };

        if (isResponse || isBodiedWait) {
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: coordinate,
                    content: { type: "text", text },
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            ...(bodyUrl !== undefined
                                ? {
                                      body: {
                                          url: bodyUrl,
                                          mimeType: typeof entry.mimetypeRx === "string" ? entry.mimetypeRx : "text/markdown",
                                      },
                                  }
                                : {}),
                            ...(repliedToMessageIds !== undefined && repliedToMessageIds.length > 0
                                ? { inReplyTo: repliedToMessageIds[0], repliedToMessageIds }
                                : {}),
                            ...(isBodiedWait && isRecord(enrichedReceipt) ? { receipt: enrichedReceipt } : {}),
                        },
                    },
                },
            });
            return updates;
        }

        const completingAnswer = entry.origin === "_plurnk"
            && typeof entry.answering === "string"
            && (entry.signal === 200 || entry.signal === 499 || (isRecord(parsedRx) && (parsedRx.completion === 200 || parsedRx.completion === 499)));
        const rawInvocation = typeof entry.invocation === "string"
            ? entry.invocation
            : typeof attrs.invocation === "string"
                ? attrs.invocation
                : completingAnswer
                    ? entry.answering
                    : undefined;
        const targetCallId = invocationCoordinate(rawInvocation);
        if (targetCallId !== null) {
            const dischargeCompletion = isRecord(parsedRx) ? parsedRx.completion : undefined;
            const dischargeStatus: ToolCallStatus =
                entry.op === "fail" || entry.signal === 499 || dischargeCompletion === 499
                    ? "failed"
                    : SessionTranslator.toolStatusOf(entry);
            const dischargeContent: ToolCallContent[] =
                (entry.op === "send" || entry.op === "done" || entry.op === "fail") && text.length > 0
                    ? [{ type: "content", content: { type: "text", text } }]
                    : contentBlocks;
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: targetCallId,
                    status: dischargeStatus,
                    capabilities: { cancel: dischargeStatus === "in_progress" ? {} : null },
                    rawOutput: receipt,
                    ...(dischargeContent.length === 0 ? {} : { content: dischargeContent }),
                    _meta: { plurnk: opMeta },
                },
            });
            const nextPlanStatus: "in_progress" | "completed" | "cancelled" =
                dischargeStatus === "completed"
                    ? "completed"
                    : dischargeStatus === "failed"
                      ? "cancelled"
                      : "in_progress";
            const settledPlan = this.#plan.settleEntry(targetCallId, nextPlanStatus, opMeta);
            if (settledPlan !== null) {
                if (prunedPlanUpdate !== null) {
                    const idx = updates.indexOf(prunedPlanUpdate);
                    if (idx !== -1) updates.splice(idx, 1);
                }
                updates.push(settledPlan);
            }
            return updates;
        }

        if (
            entry.origin === "_plurnk"
            && entry.op === "send"
            && (attrs.kind === "message" || typeof entry.answering === "string")
        ) {
            const messageId = extractMessageId(entry.source, this.#acpSessionId) ?? coordinate;
            const userActor = extractActor(entry.source, attrsActor) ?? extractActor(address, attrsActor);
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "user_message_chunk",
                    messageId,
                    content: { type: "text", text },
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            ...(bodyUrl !== undefined
                                ? {
                                      body: {
                                          url: bodyUrl,
                                          mimeType: typeof entry.mimetypeTx === "string" ? entry.mimetypeTx : "text/plain",
                                      },
                                  }
                                : {}),
                            ...(typeof entry.answering === "string" ? { answering: entry.answering } : {}),
                            ...(typeof entry.source === "string" ? { source: entry.source } : {}),
                            ...(userActor !== undefined ? { actor: userActor } : {}),
                            ...(attrsActor !== undefined ? { actorProfile: attrsActor } : {}),
                        },
                    },
                },
            });
            return updates;
        }

        if (entry.op === "error") {
            if (attrs.retry === true) return updates;
            const attempt = isRecord(attrs.attempt) ? attrs.attempt : null;
            if (entry.origin === "model" && attempt !== null && typeof attempt.verb === "string") {
                const verb = attempt.verb;
                updates.push({
                    sessionId: this.#acpSessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: coordinate,
                        name: verb,
                        title: verb,
                        kind: SessionTranslator.toolKindOf(verb, null),
                        status: "failed",
                        rawInput: { text: typeof attempt.text === "string" ? attempt.text : "" },
                        rawOutput: receipt,
                        ...(contentBlocks.length === 0 ? {} : { content: contentBlocks }),
                        _meta: { plurnk: opMeta },
                    },
                });
                return updates;
            }
            const problemRec = isRecord(parsedRx) && isRecord(parsedRx.problem) ? parsedRx.problem : null;
            if (problemRec?.type === "https://problems.plurnk.xyz/engine/rail/no-operation") {
                return updates;
            }
            const detail =
                typeof problemRec?.detail === "string"
                    ? problemRec.detail
                    : typeof problemRec?.title === "string"
                      ? problemRec.title
                      : undefined;
            const isRecoverableStrike =
                entry.origin === "model" ||
                entry.source === "rail" ||
                (entry.source === "provider" &&
                    (problemRec?.providerKind === "generation_failed" ||
                        problemRec?.providerKind === "invalid_response"));
            const severity = isRecoverableStrike ? "warning" : "error";
            const noticeSource =
                typeof entry.source === "string" && /^[a-z]+(:[a-z][a-z0-9+._-]*)?$/u.test(entry.source)
                    ? entry.source
                    : "engine:log";
            const synthesizedNotice: Notice = {
                source: noticeSource,
                kind: "error",
                level: severity === "error" ? "error" : "warn",
                ...(detail !== undefined ? { message: detail } : {}),
                position: {
                    type: "log-coordinate",
                    coordinate: `log:///${coordinate}`,
                    op: "error",
                },
            };
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "notice",
                    severity,
                    title: typeof entry.source === "string" && entry.source.length > 0 ? `${entry.source}:error` : "error",
                    ...(detail !== undefined ? { description: detail } : {}),
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            notice: synthesizedNotice,
                            ...(bodyUrl !== undefined ? { body: { url: bodyUrl } } : {}),
                        },
                    },
                },
            });
            return updates;
        }

        if (
            entry.origin === "_plurnk" &&
            entry.op === "read" &&
            (attrs.kind === "emission" || (address !== null && address.startsWith("ops://")))
        ) {
            return updates;
        }
        if (entry.origin === "_plurnk" && entry.op === "edit" && attrs.kind === "entry_materialized") {
            return updates;
        }
        if (entry.op !== null && entry.op !== "error") {
            const streamTarget = typeof attrs.stream === "string" && attrs.stream.length > 0 ? attrs.stream : null;
            const kind = SessionTranslator.toolKindOf(entry.op, entry.scheme ?? null);
            const concludedStream = this.#streams.consumeConcluded(entry.id, streamTarget);
            const concludedStreamStatus = concludedStream?.status;
            const rawStatus = SessionTranslator.toolStatusOf(entry);
            const status: ToolCallStatus =
                rawStatus === "in_progress" && concludedStreamStatus !== undefined
                    ? concludedStreamStatus < 400
                        ? "completed"
                        : "failed"
                    : rawStatus;
            const effectiveStatusRx =
                rawStatus === "in_progress" && concludedStreamStatus !== undefined
                    ? concludedStreamStatus
                    : statusRx;
            if (streamTarget !== null && concludedStream === undefined) {
                this.#streams.rememberActive(entry.id, streamTarget, coordinate);
            }
            const rawInput = isRecord(parsedTx)
                ? Object.fromEntries(Object.entries(parsedTx).filter(([k]) => k !== "op" && k !== "position"))
                : parsedTx;
            const content: ToolCallContent[] = [];
            const omitSettledPayload =
                this.#bodiesMode === "link" &&
                bodyUrl !== undefined &&
                (status === "completed" || status === "failed");

            appendDiffContentBlocks({
                content,
                entry,
                address,
                statusRx,
                attrs,
                parsedTx,
                omitSettledDiffPatch: omitSettledPayload,
            });

            if (typeof attrs.stream === "string") {
                content.push({ type: "terminal", terminalId: terminalIdForEntry(entry.id) });
            }

            appendSubagentSessionReference({
                updates,
                content,
                acpSessionId: this.#acpSessionId,
                workspaceId: this.#workspaceId,
                sessionName: this.#sessionName,
                entry,
                address,
                attrs,
                receipt,
                status,
                effectiveStatusRx,
                streams: this.#streams,
            });

            for (const block of contentBlocks) {
                content.push(block);
            }

            const comment = isRecord(parsedTx) && typeof parsedTx.aside === "string" && parsedTx.aside.length > 0
                ? parsedTx.aside
                : isRecord(parsedTx) && typeof parsedTx.comment === "string" && parsedTx.comment.length > 0
                    ? parsedTx.comment
                    : typeof attrs.aside === "string" && attrs.aside.length > 0
                        ? attrs.aside
                        : typeof attrs.comment === "string" && attrs.comment.length > 0
                            ? attrs.comment
                            : null;
            const baseTitle = address === null ? entry.op : `${entry.op} (${address})`;
            const title = comment === null ? baseTitle : `${baseTitle} — ${comment}`;
            const startLine = extractStartLine(attrs, parsedTx, parsedRx);
            const cancellable =
                status === "in_progress" ||
                status === "pending" ||
                ((entry.op === "work" || entry.op === "fork") &&
                    status === "completed" &&
                    typeof attrs.session === "string" &&
                    attrs.session.length > 0);
            const settledStream = typeof attrs.stream === "string" && status !== "in_progress";

            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: coordinate,
                    name: entry.op,
                    title,
                    kind,
                    status,
                    ...(cancellable
                        ? { capabilities: { cancel: {} } }
                        : settledStream
                          ? { capabilities: { cancel: null } }
                          : {}),
                    ...(address === null
                        ? {}
                        : {
                              locations: [
                                  {
                                      path: address,
                                      ...(startLine !== undefined ? { line: startLine } : {}),
                                  },
                              ],
                          }),
                    rawInput,
                    rawOutput: receipt,
                    ...(content.length === 0 ? {} : { content }),
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            status: effectiveStatusRx,
                            ...(bodyUrl !== undefined ? { body: { url: bodyUrl } } : {}),
                        },
                    },
                },
            });

            if (typeof attrs.stream === "string") {
                updates.push(
                    buildTerminalOpeningUpdate({
                        acpSessionId: this.#acpSessionId,
                        entryId: entry.id,
                        text,
                        status,
                        effectiveStatusRx,
                        parsedRx,
                        omitSettledTerminalOutput: omitSettledPayload,
                    }),
                );
            }

            const trimmedAside = comment === null ? "" : comment.trim();
            if (entry.origin === "model" && trimmedAside.length > 0 && !/^(?:fact|idea|plan)$/iu.test(trimmedAside)) {
                const planMeta = {
                    sessionId: entry.sessionId,
                    sessionName,
                    coordinate,
                    origin: entry.origin,
                    turnId: entry.turnId,
                    turnSeq: entry.turnSeq,
                    loopId: entry.loopId,
                    loopSeq: entry.loopSeq,
                    sequence: entry.sequence,
                };
                const planStatus: "in_progress" | "completed" | "cancelled" =
                    status === "completed" ? "completed" : status === "failed" ? "cancelled" : "in_progress";
                if (prunedPlanUpdate !== null) {
                    const idx = updates.indexOf(prunedPlanUpdate);
                    if (idx !== -1) updates.splice(idx, 1);
                }
                updates.push(this.#plan.recordAside(coordinate, trimmedAside, planStatus, entry.turnSeq, planMeta));
            }
            return updates;
        }

        updates.push({
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "notice",
                severity: statusRx >= 400 ? "warning" : "info",
                title: typeof attrs.kind === "string" && attrs.kind.length > 0 ? attrs.kind : "log:entry",
                ...(text.length > 0 ? { description: text } : {}),
                _meta: {
                    plurnk: {
                        ...opMeta,
                        ...(bodyUrl !== undefined ? { body: { url: bodyUrl } } : {}),
                    },
                },
            },
        });
        return updates;
    }

    reasoning(event: ReasoningEventNotification): AcpSessionUpdate[] {
        return translateReasoningUpdates({
            acpSessionId: this.#acpSessionId,
            workspaceId: this.#workspaceId,
            sessionId: this.#sessionId,
            sessionName: this.#sessionName,
            origin: this.#origin,
            reasoningMode: this.#reasoningMode,
            event,
            streams: this.#streams,
        });
    }

    terminalChunk(entryId: number, text: string, meta?: Record<string, unknown>): AcpSessionUpdate[] {
        if (text.length === 0) return [];
        return [{
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "terminal_output_chunk",
                terminalId: terminalIdForEntry(entryId),
                data: Buffer.from(text, "utf8").toString("base64"),
                ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
            },
        }];
    }

    terminalConcluded(entryId: number, status: number, meta?: Record<string, unknown>): AcpSessionUpdate[] {
        const terminalId = terminalIdForEntry(entryId);
        const target = typeof meta?.target === "string" && meta.target.length > 0 ? meta.target : null;
        const resultRec = isRecord(meta?.result) ? meta.result : null;
        const exitCode = typeof resultRec?.exitCode === "number" ? resultRec.exitCode : status === 200 ? 0 : status;
        const signal = typeof resultRec?.signal === "string" ? resultRec.signal : undefined;
        const updates: AcpSessionUpdate[] = [
            {
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "terminal_update",
                    terminalId,
                    capabilities: { cancel: null },
                    exitStatus: { exitCode, ...(signal !== undefined ? { signal } : {}) },
                    ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
                },
            },
        ];
        const activeStream = this.#streams.consumeActive(entryId, target);
        if (activeStream === undefined) {
            this.#streams.rememberConcluded(entryId, target, status);
            return updates;
        }
        const toolCallId = activeStream.coordinate;
        updates.push({
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: status < 400 ? "completed" : "failed",
                capabilities: { cancel: null },
                _meta: {
                    plurnk: {
                        status,
                        ...(target !== null ? { attrs: { stream: target } } : {}),
                    },
                },
            },
        });
        const settledPlan = this.#plan.settleEntry(toolCallId, status < 400 ? "completed" : "cancelled", meta);
        if (settledPlan !== null) {
            updates.push(settledPlan);
        }
        return updates;
    }

    notice(notice: Notice): AcpSessionUpdate[] {
        return translateNoticeUpdates(this.#acpSessionId, notice, this.#streams);
    }

    packet(event: ApplicationLoopPacket, spend?: unknown): AcpSessionUpdate[] {
        return translatePacketUpdates({
            acpSessionId: this.#acpSessionId,
            sessionId: this.#sessionId,
            sessionName: this.#sessionName,
            event,
            spend,
            plan: this.#plan,
        });
    }

    terminated(
        event: TerminatedNotification,
        spend?: unknown,
        inbox?: unknown,
        openMessages?: unknown,
    ): AcpSessionUpdate[] {
        return translateTerminatedUpdates({
            acpSessionId: this.#acpSessionId,
            sessionId: this.#sessionId,
            sessionName: this.#sessionName,
            event,
            spend,
            inbox,
            openMessages,
            streams: this.#streams,
            plan: this.#plan,
        });
    }

    static replay(
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
    ): ReplayResult {
        translator.#streams.resetForReplay();
        translator.#plan.clear();
        return replaySessionHistory(translator, rows, inbox, options);
    }
}
