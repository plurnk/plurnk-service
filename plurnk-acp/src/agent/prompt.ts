// {§acp-session-owner} {§acp-action-binding} {§acp-http-authorization}
// `session/prompt` admission, actor authorization, skill/command resolution, and `runLoop` dispatch.

import { fileURLToPath } from "node:url";
import {
    ContentBlock,
    RequestError,
    methods,
    type AgentApp,
    type PromptResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    actorsMatch,
    formatExteriorActorInput,
    isDefaultExteriorActor,
    isRecord,
    parseExteriorActor,
    type ExteriorActorProfile,
    type MessageResource,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import { executeSlashCommand } from "../actions.ts";
import { projectInboxItems } from "../log-entry-projection.ts";
import {
    resolvePromptCommand,
    resolveSkillReference,
    type ResolvedPromptCommand,
} from "../session-commands.ts";
import {
    extractPlurnkMeta,
    registerAcpSessionOwner,
    resolveSessionBinding,
    toRequestError,
} from "../sessions.ts";
import { joinPromptSegments, uriLeaf, type AgentPeerRuntime, type PromptSegment } from "./context.ts";

export const registerSessionPromptHandler = (app: AgentApp, rt: AgentPeerRuntime): void => {
    const { peer, actionCallbacks } = rt;
    const {
        seam,
        opts,
        httpOrigin,
        requestSubject,
        requestHandle,
        requestName,
        requestCanDelegateActor,
        notifyPeerSession,
        broadcastSessionUpdate,
    } = rt.host;

    app.onRequest(methods.agent.session.prompt, async (ctx): Promise<PromptResponse> => {
        peer.client = ctx.client;
        try {
            const existingBound = peer.sessions.get(ctx.params.sessionId);
            const bound = existingBound
                ?? (await resolveSessionBinding(
                    seam,
                    httpOrigin(),
                    peer,
                    ctx.params.sessionId,
                    undefined,
                    true,
                    ctx.params._meta,
                    opts.historyPageChars,
                ));
            const plurnkMeta = extractPlurnkMeta(ctx.params._meta);
            if (
                existingBound !== undefined &&
                plurnkMeta.control !== false &&
                (plurnkMeta.interactive !== undefined || plurnkMeta.tools !== undefined)
            ) {
                await registerAcpSessionOwner(seam, bound.workspaceId, plurnkMeta);
            }
            const verifiedSubject = requestSubject?.() ?? peer.subject ?? null;
            const verifiedHandle = requestHandle?.() ?? peer.handle;
            const verifiedName = requestName?.() ?? peer.name;
            const canDelegateActor = requestCanDelegateActor?.() ?? peer.canDelegateActor ?? false;
            const authActive = seam.credentials?.face() !== null;
            let principalId: string;
            let actorProfile: ExteriorActorProfile | undefined;
            if (plurnkMeta.actor !== undefined) {
                const parsedActor = parseExteriorActor(plurnkMeta.actor, "acp");
                if (parsedActor === null) {
                    const formatted = formatExteriorActorInput(plurnkMeta.actor);
                    const problem = Problems.create(
                        "acp",
                        "actor-invalid",
                        400,
                        `Invalid exterior actor '${formatted}'.`,
                    );
                    throw new RequestError(-32602, `${problem.detail} (actor-invalid)`, { ...problem, problem });
                }
                const subjectMatches = verifiedSubject !== null && actorsMatch(plurnkMeta.actor, verifiedSubject);
                const delegatedAllowed = canDelegateActor && !isDefaultExteriorActor(parsedActor.id);
                if (authActive && !subjectMatches && !delegatedAllowed) {
                    const problem = Problems.create(
                        "acp",
                        "actor-not-authorized",
                        403,
                        `Actor '${parsedActor.id}' does not match authenticated subject '${verifiedSubject ?? ""}'.`,
                    );
                    throw new RequestError(-32000, `${problem.detail} (actor-not-authorized)`, {
                        ...problem,
                        problem,
                    });
                }
                principalId = parsedActor.id;
                if (!isDefaultExteriorActor(principalId)) {
                    const explicitHandleProvided =
                        typeof plurnkMeta.actor === "object" &&
                        plurnkMeta.actor !== null &&
                        plurnkMeta.actor.handle !== undefined &&
                        plurnkMeta.actor.handle !== null;
                    const explicitNameProvided =
                        typeof plurnkMeta.actor === "object" &&
                        plurnkMeta.actor !== null &&
                        plurnkMeta.actor.name !== undefined &&
                        plurnkMeta.actor.name !== null;
                    const effectiveName = explicitNameProvided
                        ? parsedActor.name
                        : subjectMatches
                          ? verifiedName
                          : parsedActor.name;
                    const effectiveHandle = explicitHandleProvided
                        ? parsedActor.handle
                        : subjectMatches && verifiedHandle !== undefined
                          ? verifiedHandle
                          : parsedActor.handle;
                    actorProfile = {
                        id: principalId,
                        handle: effectiveHandle,
                        ...(effectiveName !== undefined ? { name: effectiveName } : {}),
                    };
                }
            } else if (verifiedSubject !== null && verifiedSubject.trim().length > 0) {
                const parsedSubject = parseExteriorActor(verifiedSubject, "acp");
                const fallbackSubject = verifiedSubject.replace(/^acp:\/\//u, "").trim();
                principalId = parsedSubject?.id ?? (fallbackSubject.length > 0 ? fallbackSubject : "operator");
                if (!isDefaultExteriorActor(principalId)) {
                    actorProfile = {
                        id: principalId,
                        handle: verifiedHandle ?? principalId,
                        ...(verifiedName !== undefined ? { name: verifiedName } : {}),
                    };
                }
            } else {
                principalId = "operator";
            }
            const displayActor = actorProfile?.handle ?? principalId;
            const isDelegatedExteriorActor = plurnkMeta.actor !== undefined && !isDefaultExteriorActor(principalId);

            const promptSegments: PromptSegment[] = [];
            const promptOpenPaths: string[] = [];
            const attachments: MessageResource[] = [];
            let pendingBuiltinCommand: Extract<ResolvedPromptCommand, { readonly kind: "builtin" }> | null = null;
            for (const block of ctx.params.prompt as readonly ContentBlock[]) {
                const rawBlock: unknown = block;
                if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
                    promptSegments.push({ kind: "text", value: block.text });
                } else if (ContentBlock.isSkill(block)) {
                    const skillRef = await resolveSkillReference(seam, bound.workspaceId, block.name);
                    if (skillRef === null) {
                        throw RequestError.invalidParams({
                            detail: `Unknown or unavailable skill '${block.name}'.`,
                        });
                    }
                    promptOpenPaths.push(skillRef.target);
                    promptSegments.push({ kind: "skill", value: `$${skillRef.alias}` });
                } else if (
                    isRecord(rawBlock) &&
                    rawBlock.type === "command" &&
                    typeof rawBlock.name === "string"
                ) {
                    const cmdName = rawBlock.name;
                    const cmdInput = rawBlock.input;
                    const resolved = await resolvePromptCommand(
                        seam,
                        bound.workspaceId,
                        cmdName,
                        cmdInput,
                        bound.projectRoot,
                    );
                    if (isDelegatedExteriorActor && (resolved?.kind === "builtin" || resolved?.kind === "learn")) {
                        const problem = Problems.create(
                            "acp",
                            "actor-not-authorized",
                            403,
                            `Actor '${principalId}' is not authorized to invoke operator command '/${cmdName}'.`,
                        );
                        throw new RequestError(-32000, `${problem.detail} (actor-not-authorized)`, {
                            ...problem,
                            problem,
                        });
                    }
                    if (resolved?.kind === "learn") {
                        if (!resolved.expansion.ok) {
                            throw RequestError.invalidParams({ detail: resolved.expansion.error });
                        }
                        promptSegments.push({ kind: "text", value: resolved.expansion.prompt });
                    } else if (resolved?.kind === "builtin") {
                        if (ctx.params.prompt.length === 1) {
                            pendingBuiltinCommand = resolved;
                        }
                        const suffix = resolved.rest.length > 0 ? ` ${resolved.rest}` : "";
                        promptSegments.push({ kind: "text", value: `/${resolved.cmd}${suffix}` });
                    } else if (resolved?.kind === "open_path") {
                        promptOpenPaths.push(resolved.target);
                        if (resolved.text.length > 0) {
                            promptSegments.push({ kind: "text", value: resolved.text });
                        }
                    } else {
                        const rawInputStr =
                            typeof cmdInput === "string"
                                ? cmdInput.trim()
                                : isRecord(cmdInput) && typeof cmdInput.text === "string"
                                  ? cmdInput.text.trim()
                                  : "";
                        promptSegments.push({
                            kind: "text",
                            value: rawInputStr.length > 0 ? `/${cmdName} ${rawInputStr}` : `/${cmdName}`,
                        });
                    }
                } else if (block.type === "resource_link" && typeof block.uri === "string" && block.uri.length > 0) {
                    let targetPath = block.uri;
                    if (block.uri.startsWith("file://")) {
                        try {
                            targetPath = fileURLToPath(block.uri);
                        } catch {
                            targetPath = block.uri;
                        }
                    }
                    promptOpenPaths.push(targetPath);
                } else if (block.type === "resource" && isRecord(block.resource)) {
                    const res = block.resource;
                    const uri = typeof res.uri === "string" && res.uri.length > 0 ? res.uri : "resource";
                    const name = uriLeaf(uri) ?? "resource";
                    const mediaType =
                        typeof res.mimeType === "string" && res.mimeType.length > 0
                            ? res.mimeType
                            : "text" in res
                              ? "text/plain"
                              : "application/octet-stream";
                    if ("text" in res && typeof res.text === "string") {
                        attachments.push({
                            name,
                            mediaType,
                            bytes: new TextEncoder().encode(res.text),
                            target: uri,
                        });
                    } else if ("blob" in res && typeof res.blob === "string") {
                        attachments.push({
                            name,
                            mediaType,
                            bytes: new Uint8Array(Buffer.from(res.blob, "base64")),
                            target: uri,
                        });
                    }
                } else if (
                    (block.type === "image" || block.type === "audio") &&
                    typeof block.data === "string" &&
                    typeof block.mimeType === "string"
                ) {
                    const blockUri = isRecord(rawBlock) && typeof rawBlock.uri === "string" ? rawBlock.uri : undefined;
                    const name = (blockUri !== undefined ? uriLeaf(blockUri) : null) ?? block.type;
                    attachments.push({
                        name,
                        mediaType: block.mimeType,
                        bytes: new Uint8Array(Buffer.from(block.data, "base64")),
                        ...(blockUri !== undefined && blockUri.length > 0 ? { target: blockUri } : {}),
                    });
                }
            }
            if (
                !isDelegatedExteriorActor &&
                pendingBuiltinCommand === null &&
                promptSegments.length === 1 &&
                promptSegments[0].kind === "text" &&
                promptSegments[0].value.trim().startsWith("/")
            ) {
                const trimmedPart = promptSegments[0].value.trim();
                const spaceIdx = trimmedPart.indexOf(" ");
                const rawCmd = spaceIdx === -1 ? trimmedPart.slice(1) : trimmedPart.slice(1, spaceIdx);
                const rest = spaceIdx === -1 ? "" : trimmedPart.slice(spaceIdx + 1).trim();
                const resolved = await resolvePromptCommand(seam, bound.workspaceId, rawCmd, rest, bound.projectRoot);
                if (resolved?.kind === "learn") {
                    if (!resolved.expansion.ok) {
                        throw RequestError.invalidParams({ detail: resolved.expansion.error });
                    }
                    promptSegments.splice(0, promptSegments.length, { kind: "text" as const, value: resolved.expansion.prompt });
                } else if (resolved?.kind === "builtin") {
                    pendingBuiltinCommand = resolved;
                } else if (resolved?.kind === "open_path") {
                    promptOpenPaths.push(resolved.target);
                    promptSegments.splice(
                        0,
                        promptSegments.length,
                        ...(resolved.text.length > 0 ? [{ kind: "text" as const, value: resolved.text }] : []),
                    );
                }
            }
            const mergedOpenPaths = [...(plurnkMeta.openPaths ?? []), ...promptOpenPaths];
            const rawText = joinPromptSegments(promptSegments);
            if (rawText.trim().length === 0 && attachments.length === 0 && mergedOpenPaths.length === 0) {
                throw new RequestError(
                    -32602,
                    "Prompt must contain non-empty text. (user-message-text-required)",
                    Problems.create("acp", "user-message-text-required", 400, "Prompt must contain non-empty text."),
                );
            }
            const text =
                rawText.trim().length > 0
                    ? rawText
                    : mergedOpenPaths.length > 0
                      ? mergedOpenPaths.map((p) => `<${p}>`).join("\n")
                      : "";
            const messageId = plurnkMeta.messageId ?? crypto.randomUUID();
            const messageAddress = `acp://${encodeURIComponent(principalId)}/sessions/${encodeURIComponent(bound.acpSessionId)}/messages/${encodeURIComponent(messageId)}`;
            const admissionBody = text.length > 0 ? text : attachments.map((a) => `<${a.name}>`).join("\n");

            await seam.messageAdmission({
                workspaceId: bound.workspaceId,
                address: messageAddress,
                body: admissionBody,
            });

            if (pendingBuiltinCommand !== null) {
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: { sessionUpdate: "state_update", state: "running" },
                    },
                ]);
                const replyText = await executeSlashCommand(
                    seam,
                    httpOrigin(),
                    bound,
                    pendingBuiltinCommand.cmd,
                    pendingBuiltinCommand.rest,
                    peer,
                    notifyPeerSession,
                    actionCallbacks,
                    verifiedSubject,
                    verifiedHandle,
                    verifiedName,
                );
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            messageId,
                            content: { type: "text", text: replyText },
                        },
                    },
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "idle",
                            stopReason: "end_turn",
                        },
                    },
                ]);
                return { messageId };
            }

            notifyPeerSession(peer, bound.acpSessionId, {
                sessionUpdate: "_plurnk_telemetry",
                _meta: {
                    plurnk: {
                        workspace: {
                            id: bound.workspaceId,
                            name: bound.workspaceName,
                            projectRoot: bound.projectRoot,
                            projectLabel: bound.projectLabel,
                            preparation: seam.workspacePreparationStatus(bound.workspaceId),
                            activity: seam.workspaceDerivationStatus(bound.workspaceId),
                        },
                    },
                },
            });
            broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                {
                    sessionId: s.acpSessionId,
                    update: {
                        sessionUpdate: "state_update",
                        state: "running",
                        _meta: {
                            plurnk: {
                                actor: displayActor,
                                ...(actorProfile !== undefined ? { actorProfile } : {}),
                            },
                        },
                    },
                },
            ]);

            const maxTurns = plurnkMeta.maxTurns ?? opts.maxTurns;
            const broadcastPromptRefusal = (problem: ProblemDetails): void => {
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "idle",
                            stopReason: "refusal",
                            _meta: {
                                plurnk: {
                                    actor: displayActor,
                                    ...(actorProfile !== undefined ? { actorProfile } : {}),
                                    terminal: {
                                        status: problem.status ?? 500,
                                        turnCount: 0,
                                        elapsedMs: 0,
                                        reason: "refusal",
                                        problem,
                                    },
                                },
                            },
                        },
                    },
                ]);
            };
            let ack: Awaited<ReturnType<typeof seam.runLoop>>;
            try {
                ack = await seam.runLoop({
                    workspaceId: bound.workspaceId,
                    sessionId: bound.sessionId,
                    prompt: text,
                    source: messageAddress,
                    messageAddress,
                    ...(actorProfile !== undefined ? { actor: actorProfile } : {}),
                    ...(attachments.length > 0 ? { attachments } : {}),
                    ...(maxTurns !== undefined ? { maxTurns } : {}),
                    ...(plurnkMeta.proposalPolicy !== undefined ? { proposalPolicy: plurnkMeta.proposalPolicy } : {}),
                    ...(mergedOpenPaths.length > 0 ? { openPaths: mergedOpenPaths } : {}),
                    ...(plurnkMeta.envelope !== undefined ? { envelope: plurnkMeta.envelope } : {}),
                });
            } catch (runErr) {
                const reqErr = toRequestError(runErr);
                const problemData =
                    Problems.fromError(runErr) ??
                    Problems.create("module:acp", "prompt-failed", 500, reqErr.message);
                broadcastPromptRefusal(problemData);
                throw reqErr;
            }

            if (ack.problem !== undefined) {
                broadcastPromptRefusal(ack.problem);
                throw new RequestError(-32000, ack.problem.detail, ack.problem);
            }

            const [rawInbox, rawOpenMessages] = await Promise.all([
                seam.readInbox({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.readOpenMessages({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
            ]);
            const origin = httpOrigin();
            const mappedInbox = projectInboxItems(rawInbox, bound.acpSessionId, origin, bound.workspaceId, bound.sessionId);
            const mappedOpenMessages = projectInboxItems(rawOpenMessages, bound.acpSessionId, origin, bound.workspaceId, bound.sessionId);
            if (
                mappedInbox.some((item) => item.id === messageId) ||
                mappedOpenMessages.some((item) => item.id === messageId)
            ) {
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "_plurnk_telemetry",
                            _meta: {
                                plurnk: {
                                    status: {
                                        inbox: mappedInbox,
                                        openMessages: mappedOpenMessages,
                                    },
                                },
                            },
                        },
                    },
                ]);
            }

            return {
                messageId,
                _meta: {
                    plurnk: {
                        workspaceId: bound.workspaceId,
                        sessionId: bound.sessionId,
                        loopId: ack.loopId,
                        ...(typeof ack.resource === "string" ? { resource: ack.resource } : {}),
                        ...(actorProfile !== undefined ? { actor: actorProfile.handle, actorProfile } : {}),
                        workspace: {
                            id: bound.workspaceId,
                            name: bound.workspaceName,
                        },
                    },
                },
            };
        } catch (err) {
            throw toRequestError(err);
        }
    });
};
