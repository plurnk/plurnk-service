// {§acp-action-binding} {§acp-daemon-client} `_plurnk/action` dispatch, discovery advertisement, and slash commands.

import { RequestError, methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    SCHEDULE_USAGE,
    Validator,
    actorsMatch,
    excerptOf,
    formatExteriorActorInput,
    formatFamilyResult,
    formatScheduleInspect,
    formatServiceUpdateReport,
    isDefaultExteriorActor,
    isRecord,
    isSafeInteger,
    lifecycleOfLoopStatus,
    parseExteriorActor,
    parseFamilyCommand,
    tokenizeSlashArgs,
    type AcpDiscovery,
    type ParsedFamilyCommand,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import SessionTranslator from "./SessionTranslator.ts";
import { readAllLogEntries } from "./log-entry-projection.ts";
import { buildAvailableCommands } from "./session-commands.ts";
import {
    OWNER_ADDRESS,
    formatSessionId,
    parseSessionId,
    resolveWorkspace,
    type AcpPeer,
    type BoundSession,
} from "./sessions.ts";

const TARGET_PROPS = {
    workspace: { type: "string" },
    workspaceId: { type: "integer" },
    session: { type: "string" },
    sessionId: { type: ["string", "integer"] },
    cwd: { type: "string" },
    projectRoot: { type: ["string", "null"] },
} as const;

const EMPTY_OBJECT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {},
} as const;

const BUILTIN_ACTIONS: Readonly<
    Record<
        string,
        {
            readonly scope: "daemon" | "workspace" | "session";
            readonly inputSchema: Record<string, unknown>;
            readonly outputSchema: Record<string, unknown>;
        }
    >
> = {
    ping: {
        scope: "daemon",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        outputSchema: EMPTY_OBJECT_SCHEMA,
    },
    discover: {
        scope: "daemon",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        outputSchema: {
            type: "object",
            required: ["schemaVersion", "actions", "display"],
            additionalProperties: false,
            properties: {
                schemaVersion: { type: "integer", const: 1 },
                actions: { type: "object" },
                display: { type: "array" },
            },
        },
    },
    "models.list": {
        scope: "daemon",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                search: { type: "string" },
                provider: { type: "string" },
                availability: { enum: ["configured", "all"] },
                all: { type: "boolean" },
                minInputPer1M: { type: "number", minimum: 0 },
                maxInputPer1M: { type: "number", minimum: 0 },
                sort: { enum: ["selector", "cost-asc", "cost-desc", "context-desc"] },
                offset: { type: "integer", minimum: 0 },
                limit: { type: "integer", minimum: 1, maximum: 100 },
            },
        },
        outputSchema: {
            type: "object",
            required: ["total", "offset", "items"],
            additionalProperties: false,
            properties: {
                total: { type: "integer" },
                offset: { type: "integer" },
                nextOffset: { type: "integer" },
                providers: { type: "array", items: { type: "string" } },
                items: { type: "array" },
            },
        },
    },
    "models.providers": {
        scope: "daemon",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        outputSchema: {
            $ref: "https://schemas.plurnk.xyz/v0/ModelProvidersResult.json",
        },
    },
    "service.update": {
        scope: "daemon",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        outputSchema: {
            type: "object",
            required: ["catalog", "service"],
            additionalProperties: false,
            properties: {
                catalog: { type: "object" },
                service: { type: "object" },
            },
        },
    },
    "workspace.create": {
        scope: "daemon",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                name: { type: "string" },
                projectRoot: { type: ["string", "null"] },
                config: {
                    type: "object",
                    additionalProperties: { type: "string" },
                },
                client: { type: "string" },
            },
        },
        outputSchema: {
            type: "object",
            required: ["workspaceId", "workspaceName"],
            additionalProperties: false,
            properties: {
                workspaceId: { type: "integer" },
                workspaceName: { type: "string" },
                projectRoot: { type: ["string", "null"] },
                projectLabel: { type: ["string", "null"] },
            },
        },
    },
    "workspace.attach": {
        scope: "daemon",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                id: { type: "integer" },
                workspaceId: { type: "integer" },
                name: { type: "string" },
                projectRoot: { type: "string" },
            },
        },
        outputSchema: {
            type: "object",
            required: ["workspaceId", "workspaceName"],
            additionalProperties: false,
            properties: {
                workspaceId: { type: "integer" },
                workspaceName: { type: "string" },
                projectRoot: { type: ["string", "null"] },
                projectLabel: { type: ["string", "null"] },
            },
        },
    },
    "workspace.list": {
        scope: "daemon",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                archived: { type: "boolean" },
                includeArchived: { type: "boolean" },
            },
        },
        outputSchema: {
            type: "object",
            required: ["workspaces"],
            additionalProperties: false,
            properties: {
                workspaces: { type: "array" },
            },
        },
    },
    "workspace.sessions": {
        scope: "workspace",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                archived: { type: "boolean" },
                includeArchived: { type: "boolean" },
            },
        },
        outputSchema: {
            type: "object",
            required: ["sessions"],
            additionalProperties: false,
            properties: {
                sessions: { type: "array" },
            },
        },
    },
    "workspace.rename": {
        scope: "workspace",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                from: { type: "string" },
                name: { type: "string" },
                to: { type: "string" },
            },
        },
        outputSchema: {
            type: "object",
            required: ["id", "name"],
            additionalProperties: false,
            properties: {
                id: { type: "integer" },
                name: { type: "string" },
            },
        },
    },
    "workspace.archive": {
        scope: "workspace",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                archived: { type: "boolean" },
            },
        },
        outputSchema: {
            type: "object",
            required: ["id", "archivedAt"],
            additionalProperties: false,
            properties: {
                id: { type: "integer" },
                archivedAt: { type: ["string", "null"] },
            },
        },
    },
    "workspace.share": {
        scope: "workspace",
        inputSchema: {
            type: "object",
            required: ["folder"],
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                folder: { type: "string" },
            },
        },
        outputSchema: {
            type: "object",
            required: ["folder"],
            additionalProperties: true,
            properties: {
                folder: { type: "string" },
            },
        },
    },
    "session.rollback": {
        scope: "session",
        inputSchema: {
            type: "object",
            required: ["to"],
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                to: { type: "string" },
            },
        },
        outputSchema: {
            $ref: "https://schemas.plurnk.xyz/v0/RollbackReport.json",
        },
    },
    "workspace.prompts": {
        scope: "workspace",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                limit: { type: "integer", minimum: 1 },
            },
        },
        outputSchema: {
            type: "object",
            required: ["prompts"],
            additionalProperties: false,
            properties: {
                prompts: { type: "array", items: { type: "string" } },
            },
        },
    },
    "session.loops": {
        scope: "workspace",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                loopSeq: { type: "integer", minimum: 1 },
            },
        },
        outputSchema: {
            type: "object",
            required: ["items"],
            additionalProperties: false,
            properties: {
                items: { type: "array" },
                updates: { type: "array" },
            },
        },
    },
    "log.read": {
        scope: "session",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                loopId: { type: "integer" },
                turnId: { type: "integer" },
                sinceId: { type: "integer" },
                beforeId: { type: "integer" },
                limit: { type: "integer", minimum: 1 },
                loopSeq: { type: "integer", minimum: 1 },
                beforeLoopSeq: { type: "integer", minimum: 1 },
                afterLoopSeq: { type: "integer", minimum: 1 },
                lastLoops: { type: "integer", minimum: 1 },
                turnSeq: { type: "integer", minimum: 1 },
                sequence: { type: "integer", minimum: 1 },
            },
        },
        outputSchema: {
            type: "object",
            required: ["entries"],
            additionalProperties: false,
            properties: {
                entries: { type: "array" },
            },
        },
    },
    "entry.read": {
        scope: "session",
        inputSchema: {
            type: "object",
            required: ["target"],
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                target: { type: "string" },
                channel: { type: "string" },
                offset: { type: "integer", minimum: 0 },
            },
        },
        outputSchema: {
            type: "object",
            required: ["status"],
            additionalProperties: true,
            properties: {
                status: { type: "integer" },
                entry: { type: "object" },
            },
        },
    },
    "op.exec": {
        scope: "workspace",
        inputSchema: {
            type: "object",
            required: ["text"],
            additionalProperties: false,
            properties: {
                ...TARGET_PROPS,
                text: { type: "string" },
            },
        },
        outputSchema: {
            type: "object",
            required: ["results"],
            additionalProperties: false,
            properties: {
                results: { type: "array" },
            },
        },
    },
};

const buildDiscovery = async (seam: ApplicationPort): Promise<AcpDiscovery> => {
    const display = (await seam.listClientDisplayCapabilities?.()) ?? [];
    const moduleActions = seam.listModuleActions?.() ?? [];
    const actions: Record<
        string,
        {
            readonly scope: "daemon" | "workspace" | "session";
            readonly inputSchema: Record<string, unknown>;
            readonly outputSchema: Record<string, unknown>;
        }
    > = { ...BUILTIN_ACTIONS };
    for (const act of moduleActions) {
        actions[act.name] = {
            scope: act.scope,
            inputSchema: act.inputSchema,
            outputSchema: act.outputSchema,
        };
    }
    return {
        schemaVersion: 1,
        actions,
        display,
    };
};

const resolveActionTarget = async (
    seam: ApplicationPort,
    rawParams: Record<string, unknown>,
    params: Record<string, unknown>,
    createWorkspace = true,
): Promise<{
    readonly workspaceId: number;
    readonly sessionName: string;
    readonly sessionId: number;
    readonly hasSession: boolean;
}> => {
    const sessionHint = typeof rawParams.sessionId === "string"
        ? rawParams.sessionId
        : typeof params.sessionId === "string"
          ? params.sessionId
          : undefined;
    const parsedSession = sessionHint !== undefined ? parseSessionId(sessionHint) : null;
    const explicitWsId = typeof rawParams.workspaceId === "number"
        ? rawParams.workspaceId
        : typeof params.workspaceId === "number"
          ? params.workspaceId
          : parsedSession?.workspaceId;
    const workspaceHint = typeof rawParams.workspace === "string"
        ? rawParams.workspace
        : typeof params.workspace === "string"
          ? params.workspace
          : parsedSession?.workspaceName;
    const cwdHint = typeof rawParams.cwd === "string"
        ? rawParams.cwd
        : typeof params.cwd === "string"
          ? params.cwd
          : undefined;
    const explicitProjectRoot = rawParams.projectRoot === null || typeof rawParams.projectRoot === "string"
        ? rawParams.projectRoot
        : params.projectRoot === null || typeof params.projectRoot === "string"
          ? params.projectRoot
          : undefined;
    const ws = await resolveWorkspace(
        seam,
        cwdHint,
        explicitWsId,
        workspaceHint,
        createWorkspace,
        explicitProjectRoot,
    );
    const explicitSessionName = typeof rawParams.session === "string"
        ? rawParams.session
        : typeof params.session === "string"
          ? params.session
          : parsedSession?.sessionName;
    let session = explicitSessionName !== undefined
        ? await seam.readSession({ workspaceId: ws.workspaceId, identity: { name: explicitSessionName } })
        : null;
    if (session === null && sessionHint !== undefined && parsedSession === null) {
        const ref = await seam.readSessionReference({ namespace: "acp", reference: sessionHint });
        if (ref !== null && ref.workspaceId === ws.workspaceId) {
            session = await seam.readSession({ workspaceId: ws.workspaceId, identity: { id: ref.sessionId } });
        } else {
            session = await seam.readSession({ workspaceId: ws.workspaceId, identity: { name: sessionHint } });
        }
    }
    if (session === null && explicitSessionName === undefined) {
        session = await seam.readSession({ workspaceId: ws.workspaceId, identity: { name: "session1" } });
    }
    const sessionName = session?.name ?? explicitSessionName ?? sessionHint ?? "session1";
    return {
        workspaceId: ws.workspaceId,
        sessionName,
        sessionId: session?.id ?? 1,
        hasSession: session !== null,
    };
};

export interface PlurnkActionCallbacks {
    readonly excerptChars?: number;
    readonly onWorkspaceRenamed?: (workspaceId: number, name: string) => void;
    readonly onAuthStatusChanged?: () => void;
    readonly getCommandsGeneration?: (workspaceId: number) => number;
    readonly onWorkspaceCommandsChanged?: (workspaceId: number, prevGeneration?: number) => Promise<void> | void;
}

export const handlePlurnkAction = async (
    seam: ApplicationPort,
    origin: string,
    rawParams: unknown,
    peer: AcpPeer | undefined,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
    callbacks?: PlurnkActionCallbacks,
    subject?: string | null,
    canDelegateActor = false,
    handle?: string,
    name?: string,
): Promise<unknown> => {
    if (!isRecord(rawParams) || typeof rawParams.kind !== "string") {
        throw RequestError.invalidParams({ detail: "_plurnk/action requires a string 'kind'." });
    }
    const verifiedSubject = subject ?? peer?.subject ?? null;
    const verifiedHandle = handle ?? peer?.handle;
    const verifiedName = name ?? peer?.name;
    const delegationEnabled = canDelegateActor || peer?.canDelegateActor === true;
    const callerActor =
        typeof verifiedSubject === "string" && verifiedSubject.trim().length > 0
            ? (parseExteriorActor(verifiedSubject, "acp")?.uri ??
              `acp://${encodeURIComponent(verifiedSubject.trim())}`)
            : OWNER_ADDRESS;
    const kind = rawParams.kind;
    const params = isRecord(rawParams.params) ? rawParams.params : {};
    const sessionHint = typeof rawParams.sessionId === "string" && rawParams.sessionId.length > 0
        ? rawParams.sessionId
        : undefined;

    const builtin = BUILTIN_ACTIONS[kind];
    if (builtin !== undefined) {
        const validation = Validator.validateJsonSchemaInstance(builtin.inputSchema, params);
        if (!validation.valid) {
            throw new RequestError(-32602, `Action '${kind}' rejected parameters.`);
        }
    }

    if (kind === "ping") {
        return {};
    }

    if (kind === "discover") {
        const noticeSessionId = sessionHint ?? [...(peer?.sessions.values() ?? [])][0]?.acpSessionId;
        if (peer !== undefined && peer.client !== null && noticeSessionId !== undefined) {
            const tempTranslator = new SessionTranslator({
                acpSessionId: noticeSessionId,
                workspaceId: 1,
                sessionId: 1,
                origin,
            });
            for (const notice of seam.configurationNotices()) {
                for (const { update } of tempTranslator.notice(notice)) {
                    notifyPeerSession(peer, noticeSessionId, update);
                }
            }
        }
        return await buildDiscovery(seam);
    }

    if (kind === "workspace.create") {
        let config: Record<string, string> | undefined;
        if (isRecord(params.config)) {
            config = {};
            for (const [key, value] of Object.entries(params.config)) {
                if (typeof value === "string") config[key] = value;
            }
        }
        return await seam.createWorkspace({
            ...(typeof params.name === "string" ? { name: params.name } : {}),
            ...(typeof params.projectRoot === "string" || params.projectRoot === null ? { projectRoot: params.projectRoot } : {}),
            ...(config !== undefined ? { config } : {}),
            ...(typeof params.client === "string" ? { client: params.client } : {}),
        });
    }

    if (kind === "workspace.attach") {
        const wsId = typeof params.id === "number"
            ? params.id
            : typeof params.workspaceId === "number"
              ? params.workspaceId
              : undefined;
        return await seam.attachWorkspace(
            wsId !== undefined
                ? { workspaceId: wsId }
                : typeof params.name === "string"
                  ? { name: params.name }
                  : { projectRoot: typeof params.projectRoot === "string" ? params.projectRoot : "" },
        );
    }

    if (kind === "models.list") {
        const availability =
            params.availability === "configured" || params.availability === "all"
                ? params.availability
                : params.all === true
                  ? ("all" as const)
                  : undefined;
        const sort =
            params.sort === "selector"
            || params.sort === "cost-asc"
            || params.sort === "cost-desc"
            || params.sort === "context-desc"
                ? params.sort
                : undefined;
        return seam.listModels({
            ...(typeof params.search === "string" ? { search: params.search } : {}),
            ...(typeof params.provider === "string" ? { provider: params.provider } : {}),
            ...(availability !== undefined ? { availability } : {}),
            ...(typeof params.minInputPer1M === "number" ? { minInputPer1M: params.minInputPer1M } : {}),
            ...(typeof params.maxInputPer1M === "number" ? { maxInputPer1M: params.maxInputPer1M } : {}),
            ...(sort !== undefined ? { sort } : {}),
            ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        });
    }

    if (kind === "models.providers") {
        if (typeof seam.listModelProviders !== "function") {
            throw RequestError.internalError({ detail: "models.providers is not supported by this daemon." });
        }
        return await seam.listModelProviders();
    }

    if (kind === "service.update") {
        if (typeof seam.updateService !== "function") {
            throw RequestError.internalError({ detail: "service.update is not supported by this daemon." });
        }
        try {
            return await seam.updateService();
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw RequestError.invalidParams({ detail });
        }
    }

    if (kind === "workspace.list") {
        const archived =
            typeof params.archived === "boolean"
                ? params.archived
                : params.includeArchived === true
                  ? undefined
                  : false;
        const workspaces = await seam.listWorkspaces({
            ...(archived !== undefined ? { archived } : {}),
        });
        return { workspaces };
    }

    if (kind === "workspace.sessions") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const archived =
            typeof params.archived === "boolean"
                ? params.archived
                : params.includeArchived === true
                  ? undefined
                  : false;
        const sessions = await seam.listSessions(target.workspaceId, {
            ...(archived !== undefined ? { archived } : {}),
        });
        return { sessions };
    }

    if (kind === "workspace.rename") {
        const fromHint = typeof params.from === "string" ? params.from : undefined;
        const target = await resolveActionTarget(
            seam,
            fromHint ? { ...rawParams, workspace: fromHint } : rawParams,
            params,
            false,
        );
        const nextName = typeof params.name === "string" ? params.name : typeof params.to === "string" ? params.to : "";
        const renamed = await seam.renameWorkspace(target.workspaceId, nextName);
        callbacks?.onWorkspaceRenamed?.(renamed.id, renamed.name);
        return renamed;
    }

    if (kind === "workspace.archive") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const archived = typeof params.archived === "boolean" ? params.archived : true;
        const result = await seam.setWorkspaceArchived({
            workspaceId: target.workspaceId,
            archived,
        });
        return result;
    }

    if (kind === "workspace.share") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        return await seam.shareWorkspace({
            workspaceId: target.workspaceId,
            folder: typeof params.folder === "string" ? params.folder : "",
        });
    }

    if (kind === "session.rollback") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        return await seam.rollback({
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            actor: callerActor,
            to: typeof params.to === "string" ? params.to : "",
        });
    }

    if (kind === "workspace.prompts") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const prompts = await seam.listPrompts(
            target.workspaceId,
            typeof params.limit === "number" ? params.limit : undefined,
            typeof params.sessionId === "number" ? params.sessionId : undefined,
        );
        return { prompts };
    }

    if (kind === "session.loops") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const rawLoops = await seam.listSessionLoops({ workspaceId: target.workspaceId, sessionId: target.sessionId });
        const excerptChars =
            callbacks?.excerptChars ??
            (() => {
                const envVal = Number(process.env.PLURNK_ACP_EXCERPT_CHARS);
                return Number.isInteger(envVal) && envVal > 0 ? envVal : 160;
            })();
        const items = rawLoops.map((loop) => {
            const { excerpt: opening, continued } = excerptOf(loop.prompt ?? "", excerptChars);
            return {
                id: loop.id,
                sequence: loop.sequence,
                status: loop.status,
                lifecycle: lifecycleOfLoopStatus(loop.status),
                source: loop.promptSource,
                opening,
                continued,
                claimedAt: loop.claimedAt,
                terminatedAt: loop.terminatedAt,
            };
        });
        if (typeof params.loopSeq === "number" && isSafeInteger(params.loopSeq) && params.loopSeq > 0) {
            const [entries, streams] = await Promise.all([
                readAllLogEntries(seam, {
                    workspaceId: target.workspaceId,
                    sessionId: target.sessionId,
                    loopSeq: params.loopSeq,
                }),
                seam.readStreams({
                    workspaceId: target.workspaceId,
                    sessionId: target.sessionId,
                }),
            ]);
            const sorted = entries.toSorted((a, b) => a.id - b.id);
            const translator = new SessionTranslator({
                acpSessionId: formatSessionId(target.workspaceId, target.sessionName),
                workspaceId: target.workspaceId,
                sessionId: target.sessionId,
                sessionName: target.sessionName,
                origin,
            });
            const replayed = SessionTranslator.replay(translator, sorted, [], {
                exactLoopSeq: params.loopSeq,
                openStreamTargets: new Set(streams.map((s) => s.target)),
            });
            return { items, updates: replayed.map((r) => r.update) };
        }
        return { items };
    }

    if (kind === "log.read") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const entries = await seam.readLog({
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            ...(typeof params.loopId === "number" ? { loopId: params.loopId } : {}),
            ...(typeof params.turnId === "number" ? { turnId: params.turnId } : {}),
            ...(typeof params.sinceId === "number" ? { sinceId: params.sinceId } : {}),
            ...(typeof params.beforeId === "number" ? { beforeId: params.beforeId } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
            ...(typeof params.loopSeq === "number" ? { loopSeq: params.loopSeq } : {}),
            ...(typeof params.beforeLoopSeq === "number" ? { beforeLoopSeq: params.beforeLoopSeq } : {}),
            ...(typeof params.afterLoopSeq === "number" ? { afterLoopSeq: params.afterLoopSeq } : {}),
            ...(typeof params.lastLoops === "number" ? { lastLoops: params.lastLoops } : {}),
            ...(typeof params.turnSeq === "number" ? { turnSeq: params.turnSeq } : {}),
            ...(typeof params.sequence === "number" ? { sequence: params.sequence } : {}),
        });
        return { entries };
    }

    if (kind === "entry.read") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        return await seam.readEntry({
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            target: typeof params.target === "string" ? params.target : "",
            ...(typeof params.channel === "string" ? { channel: params.channel } : {}),
            ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
        });
    }

    if (kind === "op.exec") {
        const target = await resolveActionTarget(seam, rawParams, params, true);
        await seam.activateWorkspace?.({ workspaceId: target.workspaceId });
        const text = typeof params.text === "string" ? params.text : "";
        const executors = seam.executorTags?.(target.workspaceId) ?? ["sh", "js"];
        const parsed = PlurnkParser.parseStatements(text, { executors });
        const parseErrors = parsed.items.filter(
            (i): i is Extract<typeof i, { kind: "error" }> => i.kind === "error" && i.error.severity === "error",
        );
        const statements = parsed.items
            .filter((i): i is Extract<typeof i, { kind: "statement" }> => i.kind === "statement")
            .map((i) => i.statement);
        if (parseErrors.length > 0 || statements.length === 0) {
            const detail = parseErrors[0]?.error.message ?? PlurnkParser.NO_VALID_EXPRESSION;
            return {
                results: [
                    Validator.assertOperationResult({
                        status: 400,
                        problem: {
                            type: "https://problems.plurnk.xyz/acp/parse-failed",
                            title: "Statement parse failed",
                            status: 400,
                            detail,
                        },
                    }),
                ],
            };
        }
        const authActive = seam.credentials?.face() !== null;
        const enrichedStatements: PlurnkStatement[] = [];
        for (const stmt of statements) {
            if (stmt.op === "send" && stmt.actor !== undefined && stmt.actor !== null) {
                const parsedActor = parseExteriorActor(stmt.actor, "acp");
                if (parsedActor === null) {
                    const formatted = formatExteriorActorInput(stmt.actor);
                    return {
                        results: [
                            Validator.assertOperationResult({
                                status: 400,
                                problem: Problems.create(
                                    "acp",
                                    "actor-invalid",
                                    400,
                                    `Invalid exterior actor '${formatted}'.`,
                                ),
                            }),
                        ],
                    };
                }
                const subjectMatches = verifiedSubject !== null && actorsMatch(stmt.actor, verifiedSubject);
                const delegatedAllowed = delegationEnabled && !isDefaultExteriorActor(parsedActor.id);
                if (authActive && !subjectMatches && !delegatedAllowed) {
                    return {
                        results: [
                            Validator.assertOperationResult({
                                status: 403,
                                problem: Problems.create(
                                    "acp",
                                    "actor-not-authorized",
                                    403,
                                    `Actor '${parsedActor.id}' does not match authenticated subject '${verifiedSubject ?? ""}'.`,
                                ),
                            }),
                        ],
                    };
                }
                if (
                    typeof stmt.actor === "string" &&
                    subjectMatches &&
                    !isDefaultExteriorActor(parsedActor.id) &&
                    (verifiedHandle !== undefined || verifiedName !== undefined)
                ) {
                    enrichedStatements.push({
                        ...stmt,
                        actor: {
                            id: parsedActor.id,
                            handle: verifiedHandle ?? parsedActor.handle,
                            ...(verifiedName !== undefined ? { name: verifiedName } : {}),
                        },
                    });
                    continue;
                }
            } else if (
                stmt.op === "send" &&
                (stmt.actor === undefined || stmt.actor === null) &&
                stmt.target?.kind === "url" &&
                stmt.target.scheme === "session" &&
                (stmt.target.pathname === null || stmt.target.pathname === "" || stmt.target.pathname === "/") &&
                verifiedSubject !== null &&
                (verifiedHandle !== undefined || verifiedName !== undefined)
            ) {
                const parsedSub = parseExteriorActor(verifiedSubject, "acp");
                if (parsedSub !== null && !isDefaultExteriorActor(parsedSub.id)) {
                    enrichedStatements.push({
                        ...stmt,
                        actor: {
                            id: parsedSub.id,
                            handle: verifiedHandle ?? parsedSub.handle,
                            ...(verifiedName !== undefined ? { name: verifiedName } : {}),
                        },
                    });
                    continue;
                }
            }
            enrichedStatements.push(stmt);
        }
        await seam.ensureRuntimeSession(target.workspaceId);
        const results = await seam.dispatchClientAction({
            workspaceId: target.workspaceId,
            actor: callerActor,
            ...(target.hasSession ? { contextSessionId: target.sessionId } : {}),
            statements: enrichedStatements,
        });
        return { results };
    }

    const moduleActions = seam.listModuleActions?.() ?? [];
    const registered = moduleActions.find((a) => a.name === kind);
    if (!registered) {
        throw new RequestError(
            -32601,
            `Action '${kind}' is not registered. Recovery: Use an action advertised by discover.`,
        );
    }

    if (isRecord(registered.inputSchema)) {
        const validation = Validator.validateJsonSchemaInstance(registered.inputSchema, params);
        if (!validation.valid) {
            throw new RequestError(-32602, `Action '${kind}' rejected parameters.`);
        }
    }

    if (registered.scope === "daemon") {
        const actionResult = await seam.invokeModuleAction(kind, params, { scope: "daemon" });
        if (peer !== undefined && peer.client !== null) {
            const elicitationSessionId = sessionHint ?? [...peer.sessions.values()][0]?.acpSessionId;
            if (
                kind === "service.mcp.oauth.begin" &&
                isRecord(actionResult) &&
                isRecord(actionResult.authorization) &&
                typeof actionResult.authorization.url === "string" &&
                elicitationSessionId !== undefined
            ) {
                const alias =
                    typeof actionResult.alias === "string"
                        ? actionResult.alias
                        : typeof params.alias === "string"
                          ? params.alias
                          : "mcp";
                void peer.client
                    .request(methods.client.elicitation.create, {
                        scope: "session",
                        sessionId: elicitationSessionId,
                        mode: "url",
                        elicitationId: `mcp-oauth:service:${alias}`,
                        url: actionResult.authorization.url,
                        message: `Authorize service MCP server '${alias}'`,
                    })
                    .catch(() => undefined);
            } else if (kind === "service.mcp.oauth.complete") {
                const alias =
                    isRecord(actionResult) && typeof actionResult.alias === "string"
                        ? actionResult.alias
                        : typeof params.alias === "string"
                          ? params.alias
                          : "mcp";
                void peer.client
                    .notify(methods.client.elicitation.complete, {
                        elicitationId: `mcp-oauth:service:${alias}`,
                    })
                    .catch(() => undefined);
            }
        }
        if (kind.includes(".env.") || kind === "service.config.set" || kind === "service.config.unset") {
            callbacks?.onAuthStatusChanged?.();
        }
        return actionResult;
    }
    const target = await resolveActionTarget(seam, rawParams, params);
    const targetSessionId =
        sessionHint ??
        (target.hasSession
            ? formatSessionId(target.workspaceId, target.sessionName)
            : [...(peer?.sessions.values() ?? [])].find((s) => s.workspaceId === target.workspaceId)?.acpSessionId);
    if (peer !== undefined && peer.client !== null && targetSessionId !== undefined) {
        const preparation = seam.workspacePreparationStatus?.(target.workspaceId) ?? [];
        const activity = seam.workspaceDerivationStatus?.(target.workspaceId) ?? null;
        notifyPeerSession(peer, targetSessionId, {
            sessionUpdate: "_plurnk_telemetry",
            _meta: {
                plurnk: {
                    workspace: {
                        id: target.workspaceId,
                        preparation,
                        activity,
                    },
                },
            },
        });
    }
    const prevCommandsGen = callbacks?.getCommandsGeneration?.(target.workspaceId);
    const actionResult =
        registered.scope === "session"
            ? await seam.invokeModuleAction(kind, params, {
                  scope: "session",
                  workspaceId: target.workspaceId,
                  sessionId: target.sessionId,
              })
            : await seam.invokeModuleAction(kind, params, {
                  scope: "workspace",
                  workspaceId: target.workspaceId,
              });
    if (peer !== undefined && peer.client !== null) {
        if (
            kind === "workspace.mcp.oauth.begin" &&
            isRecord(actionResult) &&
            isRecord(actionResult.authorization) &&
            typeof actionResult.authorization.url === "string" &&
            targetSessionId !== undefined
        ) {
            const alias =
                typeof actionResult.alias === "string"
                    ? actionResult.alias
                    : typeof params.alias === "string"
                      ? params.alias
                      : "mcp";
            void peer.client
                .request(methods.client.elicitation.create, {
                    scope: "session",
                    sessionId: targetSessionId,
                    mode: "url",
                    elicitationId: `mcp-oauth:${target.workspaceId}:${alias}`,
                    url: actionResult.authorization.url,
                    message: `Authorize MCP server '${alias}'`,
                })
                .catch(() => undefined);
        } else if (kind === "workspace.mcp.oauth.complete") {
            const alias =
                isRecord(actionResult) && typeof actionResult.alias === "string"
                    ? actionResult.alias
                    : typeof params.alias === "string"
                      ? params.alias
                      : "mcp";
            void peer.client
                .notify(methods.client.elicitation.complete, {
                    elicitationId: `mcp-oauth:${target.workspaceId}:${alias}`,
                })
                .catch(() => undefined);
        }
        if (
            (kind.startsWith("workspace.skills.") ||
                kind.startsWith("workspace.mcp.") ||
                kind.startsWith("workspace.personas.")) &&
            !kind.endsWith(".list") &&
            !kind.endsWith(".discover") &&
            !kind.endsWith(".complete")
        ) {
            if (callbacks?.onWorkspaceCommandsChanged !== undefined) {
                await callbacks.onWorkspaceCommandsChanged(target.workspaceId, prevCommandsGen);
            } else {
                const availableCommands = await buildAvailableCommands(seam, target.workspaceId, {
                    includeSkills: peer.supportsSkillCommands === true,
                });
                const visited = new Set<string>();
                for (const s of peer.sessions.values()) {
                    if (s.workspaceId !== target.workspaceId || visited.has(s.acpSessionId)) continue;
                    visited.add(s.acpSessionId);
                    notifyPeerSession(peer, s.acpSessionId, {
                        sessionUpdate: "available_commands_update",
                        availableCommands,
                    });
                }
            }
        }
    }
    if (kind.includes(".env.")) {
        callbacks?.onAuthStatusChanged?.();
    }
    return actionResult;
};

export const executeSlashCommand = async (
    seam: ApplicationPort,
    origin: string,
    bound: BoundSession,
    cmd: string,
    rest: string,
    peer: AcpPeer | undefined,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
    callbacks?: PlurnkActionCallbacks,
    subject?: string | null,
    handle?: string,
    name?: string,
): Promise<string> => {
    const envelope = {
        sessionId: bound.acpSessionId,
        workspaceId: bound.workspaceId,
        workspace: bound.workspaceName,
        session: bound.sessionName,
    };
    const invoke = (action: Record<string, unknown>): Promise<unknown> =>
        handlePlurnkAction(seam, origin, action, peer, notifyPeerSession, callbacks, subject, false, handle, name);

    if (cmd === "rollback") {
        const res = await invoke({ ...envelope, kind: "session.rollback", params: { to: rest } });
        return typeof res === "string" ? res : JSON.stringify(res);
    }
    if (cmd === "share") {
        const res = await invoke({ ...envelope, kind: "workspace.share", params: { folder: rest } });
        return typeof res === "string" ? res : JSON.stringify(res);
    }
    if (cmd === "update") {
        const res = await invoke({ ...envelope, kind: "service.update", params: {} });
        if (isRecord(res) && isRecord(res.catalog) && isRecord(res.service)) {
            return formatServiceUpdateReport(res);
        }
        return typeof res === "string" ? res : JSON.stringify(res);
    }
    let tokens: string[];
    try {
        tokens = rest.length > 0 ? tokenizeSlashArgs(rest) : [];
    } catch (err) {
        const problem = Problems.fromError(err)
            ?? Problems.create("client", "usage", 400, err instanceof Error ? err.message : String(err));
        throw new RequestError(-32602, problem.detail, { ...problem, problem });
    }
    if (cmd === "schedule") {
        const firstTok = tokens[0]?.toLowerCase();
        if (firstTok === "help" || firstTok === "--help" || firstTok === "-h") {
            return SCHEDULE_USAGE.trimEnd();
        }
    }
    let parsed: ParsedFamilyCommand;
    try {
        parsed = parseFamilyCommand(cmd, tokens);
    } catch (err) {
        const problem = Problems.fromError(err)
            ?? Problems.create("client", "usage", 400, err instanceof Error ? err.message : String(err));
        throw new RequestError(-32602, problem.detail, { ...problem, problem });
    }
    if (cmd === "schedule" && parsed.sub === "inspect") {
        const alias = parsed.rest[0] ?? "";
        const listed = await invoke({ ...envelope, kind: "workspace.schedule.list", params: {} });
        const defs = isRecord(listed) && Array.isArray(listed.definitions) ? listed.definitions : [];
        const found = defs.find(
            (item): item is Record<string, unknown> => isRecord(item) && item.alias === alias,
        );
        if (found === undefined) {
            const problem = Problems.create("schedule", "not-found", 404, `Schedule '${alias}' not found.`);
            throw new RequestError(-32000, problem.detail, { ...problem, problem });
        }
        return formatScheduleInspect(found).trimEnd();
    }
    let params = parsed.params;
    if (parsed.actionName === "workspace.mcp.oauth.begin" || parsed.actionName === "service.mcp.oauth.begin") {
        const alias = typeof params.alias === "string" ? params.alias : "";
        const listKind = parsed.actionName === "service.mcp.oauth.begin" ? "service.mcp.list" : "workspace.mcp.list";
        const listed = await invoke({ ...envelope, kind: listKind, params: {} }).catch(() => null);
        if (isRecord(listed)) {
            const defs = Array.isArray(listed.definitions) ? listed.definitions : [];
            const entry = defs.find((d): d is Record<string, unknown> => isRecord(d) && d.alias === alias);
            const def = isRecord(entry?.definition) ? entry.definition : null;
            const auth = def?.type === "streamable-http" && isRecord(def.authorization) ? def.authorization : null;
            if (auth?.type === "oauth" && typeof auth.redirectUrl === "string" && auth.redirectUrl.length > 0) {
                params = { ...params, redirectUrl: auth.redirectUrl };
            }
        }
    }
    const res = await invoke({ ...envelope, kind: parsed.actionName, params });
    return formatFamilyResult(cmd, parsed.actionName, params, res);
};
