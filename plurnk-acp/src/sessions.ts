// {§acp-daemon-client} {§acp-session-owner} {§acp-overview} {§acp-action-binding} Session and workspace binding, configOptions, and overview projection.

import {
    RequestError,
    type AgentContext,
    type AvailableCommand,
    type SessionConfigOption,
    type SessionInfo,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    isRecord,
    isSafeInteger,
    type ApplicationOverviewWorkspace,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { ResolvedModuleOptions } from "./config.ts";
import SessionTranslator from "./SessionTranslator.ts";

export const OWNER_ADDRESS = "acp:///owner";

export const AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([
    { name: "mcp", description: "Manage workspace MCP servers" },
    { name: "skills", description: "Manage workspace skills" },
    { name: "members", description: "Manage workspace members" },
    { name: "env", description: "Manage workspace environment variables" },
    { name: "schedule", description: "Manage workspace schedules" },
    { name: "rollback", description: "Roll back reversible session operations" },
    { name: "share", description: "Write a diagnostic digest of the workspace" },
    { name: "script", description: "Execute PLURNK statements directly" },
    { name: "update", description: "Update the model catalog and service packages" },
]);

export interface BoundSession {
    readonly acpSessionId: string;
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly sessionId: number;
    readonly sessionName: string;
    readonly translator: SessionTranslator;
}

export interface AcpPeer {
    readonly family: string | null;
    readonly sessions: Map<string, BoundSession>;
    client: AgentContext | null;
    closeTransport?: () => void;
    closeWithProblem(problem: ProblemDetails): Promise<void>;
}

export const formatSessionId = (workspaceId: number, sessionName: string): string => `${workspaceId}#${sessionName}`;

export const parseSessionId = (raw: string): { readonly workspaceId: number; readonly sessionName: string } | null => {
    const idx = raw.indexOf("#");
    if (idx <= 0 || idx === raw.length - 1) return null;
    const prefix = raw.slice(0, idx);
    if (!/^[1-9]\d*$/.test(prefix)) return null;
    const wsId = Number(prefix);
    const sessionName = raw.slice(idx + 1);
    if (!isSafeInteger(wsId) || wsId <= 0 || sessionName.length === 0) return null;
    return { workspaceId: wsId, sessionName };
};

export const assertSinglePortSecurity = (params: unknown): void => {
    if (!isRecord(params)) return;
    if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
        throw RequestError.invalidParams({
            detail: "Client-supplied mcpServers are forbidden by the single-port security contract.",
        });
    }
    if (params.systemPrompt !== undefined && params.systemPrompt !== null) {
        throw RequestError.invalidParams({
            detail: "Client-supplied systemPrompt overrides are forbidden by the single-port security contract.",
        });
    }
};

const extractProblemFromError = (err: unknown): ProblemDetails | null =>
    Problems.fromError(err) ??
    (isRecord(err) && isRecord(err.problem)
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          (err.problem as unknown as ProblemDetails)
        : null);

export const toRequestError = (err: unknown): RequestError => {
    if (err instanceof RequestError) return err;
    const problem = extractProblemFromError(err);
    if (problem !== null) {
        const slug = typeof problem.code === "string" ? problem.code : problem.type;
        return new RequestError(-32000, `${problem.detail} (${slug})`, { ...problem, problem });
    }
    return RequestError.internalError(err instanceof Error ? { detail: err.message } : undefined);
};

export const tryListProviders = (
    seam: ApplicationPort,
): {
    readonly aliases: ReturnType<ApplicationPort["listProviders"]>["aliases"] | null;
    readonly problem: ProblemDetails | null;
} => {
    try {
        return { aliases: seam.listProviders().aliases, problem: null };
    } catch (err) {
        return { aliases: null, problem: extractProblemFromError(err) };
    }
};

export const extractPlurnkMeta = (meta: unknown): {
    readonly workspaceId?: number;
    readonly workspaceName?: string;
    readonly sessionName?: string;
    readonly create?: boolean;
    readonly activate?: boolean;
    readonly messageId?: string;
    readonly projectRoot?: string | null;
    readonly settings?: Record<string, unknown>;
    readonly maxTurns?: number;
    readonly openPaths?: string[];
    readonly envelope?: Readonly<Record<string, unknown>>;
} => {
    if (!isRecord(meta) || !isRecord(meta.plurnk)) return {};
    const p = meta.plurnk;
    const workspaceId = typeof p.workspaceId === "number" && Number.isInteger(p.workspaceId) && p.workspaceId > 0
        ? p.workspaceId
        : undefined;
    const workspaceName = typeof p.workspaceName === "string" && p.workspaceName.trim().length > 0
        ? p.workspaceName.trim()
        : typeof p.workspace === "string" && p.workspace.trim().length > 0
            ? p.workspace.trim()
            : undefined;
    const sessionName = typeof p.sessionName === "string" && p.sessionName.trim().length > 0
        ? p.sessionName.trim()
        : typeof p.session === "string" && p.session.trim().length > 0
            ? p.session.trim()
            : typeof p.name === "string" && p.name.trim().length > 0
                ? p.name.trim()
                : undefined;
    const create = typeof p.create === "boolean" ? p.create : undefined;
    const activate = typeof p.activate === "boolean" ? p.activate : undefined;
    const messageId = typeof p.messageId === "string" && p.messageId.trim().length > 0
        ? p.messageId.trim()
        : undefined;
    const projectRoot = p.projectRoot === null || typeof p.projectRoot === "string"
        ? p.projectRoot
        : undefined;
    const settings = isRecord(p.settings) ? p.settings : undefined;
    const maxTurns = typeof p.maxTurns === "number" && Number.isInteger(p.maxTurns) && p.maxTurns > 0
        ? p.maxTurns
        : undefined;
    const openPaths = Array.isArray(p.openPaths)
        ? p.openPaths.filter((x): x is string => typeof x === "string")
        : undefined;
    const envelope = isRecord(p.envelope) ? p.envelope : undefined;
    return {
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(sessionName !== undefined ? { sessionName } : {}),
        ...(create !== undefined ? { create } : {}),
        ...(activate !== undefined ? { activate } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        ...(settings !== undefined ? { settings } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(openPaths !== undefined ? { openPaths } : {}),
        ...(envelope !== undefined ? { envelope } : {}),
    };
};

export const resolveWorkspace = async (
    seam: ApplicationPort,
    cwd: string | undefined,
    workspaceIdHint: number | undefined,
    workspaceNameHint: string | undefined,
    createIfMissing: boolean,
    explicitProjectRoot?: string | null,
    settings?: Record<string, unknown>,
): Promise<{
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
}> => {
    if (workspaceIdHint !== undefined) {
        const attached = await seam.attachWorkspace({ workspaceId: workspaceIdHint });
        return {
            workspaceId: attached.workspaceId,
            workspaceName: attached.workspaceName,
            projectRoot: attached.projectRoot ?? null,
            projectLabel: attached.projectLabel ?? null,
        };
    }

    const effectiveProjectRoot = explicitProjectRoot !== undefined
        ? (explicitProjectRoot === "" ? null : explicitProjectRoot)
        : typeof cwd === "string" && cwd.length > 0 && cwd !== "/"
          ? cwd
          : undefined;

    if (workspaceNameHint !== undefined && workspaceNameHint.length > 0) {
        try {
            const attached = await seam.attachWorkspace({ name: workspaceNameHint });
            return {
                workspaceId: attached.workspaceId,
                workspaceName: attached.workspaceName,
                projectRoot: attached.projectRoot ?? null,
                projectLabel: attached.projectLabel ?? null,
            };
        } catch (err) {
            const problem = extractProblemFromError(err);
            if (!createIfMissing || (problem !== null && problem.status !== 404)) {
                throw err;
            }
            const created = await seam.createWorkspace({
                name: workspaceNameHint,
                ...(effectiveProjectRoot !== undefined ? { projectRoot: effectiveProjectRoot } : {}),
                ...(settings !== undefined ? { settings } : {}),
            });
            return {
                workspaceId: created.workspaceId,
                workspaceName: created.workspaceName,
                projectRoot: created.projectRoot ?? null,
                projectLabel: created.projectLabel ?? null,
            };
        }
    }

    if (effectiveProjectRoot !== undefined && effectiveProjectRoot !== null) {
        try {
            const attached = await seam.attachWorkspace({ projectRoot: effectiveProjectRoot });
            return {
                workspaceId: attached.workspaceId,
                workspaceName: attached.workspaceName,
                projectRoot: attached.projectRoot ?? null,
                projectLabel: attached.projectLabel ?? null,
            };
        } catch (err) {
            const problem = extractProblemFromError(err);
            if (!createIfMissing || (problem !== null && problem.status !== 404)) {
                throw err;
            }
            const created = await seam.createWorkspace({
                projectRoot: effectiveProjectRoot,
                ...(settings !== undefined ? { settings } : {}),
            });
            return {
                workspaceId: created.workspaceId,
                workspaceName: created.workspaceName,
                projectRoot: created.projectRoot ?? null,
                projectLabel: created.projectLabel ?? null,
            };
        }
    }

    try {
        const attached = await seam.attachWorkspace({ name: "default" });
        return {
            workspaceId: attached.workspaceId,
            workspaceName: attached.workspaceName,
            projectRoot: attached.projectRoot ?? null,
            projectLabel: attached.projectLabel ?? null,
        };
    } catch (err) {
        const problem = extractProblemFromError(err);
        if (!createIfMissing || (problem !== null && problem.status !== 404)) {
            throw err;
        }
        const created = await seam.createWorkspace({
            name: "default",
            ...(settings !== undefined ? { settings } : {}),
        });
        return {
            workspaceId: created.workspaceId,
            workspaceName: created.workspaceName,
            projectRoot: created.projectRoot ?? null,
            projectLabel: created.projectLabel ?? null,
        };
    }
};

export const resolveSessionBinding = async (
    seam: ApplicationPort,
    origin: string,
    peer: AcpPeer,
    rawSessionId: string | undefined,
    cwd: string | undefined,
    createIfMissing: boolean,
    meta?: unknown,
): Promise<BoundSession> => {
    const plurnkMeta = extractPlurnkMeta(meta);
    const allowCreate = plurnkMeta.create ?? createIfMissing;

    let workspaceId: number;
    let workspaceName: string;
    let projectRoot: string | null = null;
    let projectLabel: string | null = null;
    let requestedSessionName: string | undefined;

    if (rawSessionId !== undefined && rawSessionId.includes("#")) {
        const parsed = parseSessionId(rawSessionId);
        if (parsed === null) {
            throw new RequestError(
                -32602,
                `Invalid session address '${rawSessionId}'. (session-address-invalid)`,
                Problems.create("acp", "session-address-invalid", 400, `Invalid session address '${rawSessionId}'.`),
            );
        }
        try {
            const attached = await seam.attachWorkspace({ workspaceId: parsed.workspaceId });
            workspaceId = attached.workspaceId;
            workspaceName = attached.workspaceName;
            projectRoot = attached.projectRoot ?? null;
            projectLabel = attached.projectLabel ?? null;
        } catch (err) {
            const problem = extractProblemFromError(err);
            if (problem !== null && problem.status === 404) {
                throw new RequestError(
                    -32004,
                    `Session '${rawSessionId}' does not exist. (session-not-found)`,
                    Problems.create("acp", "session-not-found", 404, `Session '${rawSessionId}' does not exist.`),
                );
            }
            throw err;
        }
        requestedSessionName = parsed.sessionName;
    } else if (rawSessionId !== undefined && rawSessionId.length > 0) {
        const ref = await seam.readSessionReference({ namespace: "acp", reference: rawSessionId });
        if (ref !== null) {
            const attached = await seam.attachWorkspace({ workspaceId: ref.workspaceId });
            const session = await seam.readSession({
                workspaceId: ref.workspaceId,
                identity: { id: ref.sessionId },
            });
            if (session === null) {
                throw new RequestError(
                    -32004,
                    `Session '${rawSessionId}' does not exist. (session-not-found)`,
                    Problems.create("acp", "session-not-found", 404, `Session '${rawSessionId}' does not exist.`),
                );
            }
            workspaceId = attached.workspaceId;
            workspaceName = attached.workspaceName;
            projectRoot = attached.projectRoot ?? null;
            projectLabel = attached.projectLabel ?? null;
            requestedSessionName = session.name;
        } else {
            try {
                const resolved = await resolveWorkspace(
                    seam,
                    cwd,
                    plurnkMeta.workspaceId,
                    plurnkMeta.workspaceName,
                    allowCreate,
                    plurnkMeta.projectRoot,
                    plurnkMeta.settings,
                );
                workspaceId = resolved.workspaceId;
                workspaceName = resolved.workspaceName;
                projectRoot = resolved.projectRoot;
                projectLabel = resolved.projectLabel;
            } catch (err) {
                const problem = extractProblemFromError(err);
                if (!allowCreate && problem !== null && problem.status === 404) {
                    throw new RequestError(
                        -32004,
                        `Session '${rawSessionId}' does not exist. (session-not-found)`,
                        Problems.create("acp", "session-not-found", 404, `Session '${rawSessionId}' does not exist.`),
                    );
                }
                throw err;
            }
            requestedSessionName = rawSessionId;
        }
    } else {
        const resolved = await resolveWorkspace(
            seam,
            cwd,
            plurnkMeta.workspaceId,
            plurnkMeta.workspaceName,
            allowCreate,
            plurnkMeta.projectRoot,
            plurnkMeta.settings,
        );
        workspaceId = resolved.workspaceId;
        workspaceName = resolved.workspaceName;
        projectRoot = resolved.projectRoot;
        projectLabel = resolved.projectLabel;
        requestedSessionName = plurnkMeta.sessionName;
    }

    if (plurnkMeta.activate === true) {
        await seam.activateWorkspace({ workspaceId });
    }
    await seam.registerSessionOwner(workspaceId, {
        address: OWNER_ADDRESS,
        tools: ["request_approval", "question", "mcp_input_required"],
        interactive: true,
    });

    let session = requestedSessionName !== undefined
        ? await seam.readSession({ workspaceId, identity: { name: requestedSessionName } })
        : null;

    if (session === null) {
        if (!allowCreate) {
            const label = rawSessionId ?? requestedSessionName ?? "unknown";
            throw new RequestError(
                -32004,
                `Session '${label}' does not exist. (session-not-found)`,
                Problems.create("acp", "session-not-found", 404, `Session '${label}' does not exist.`),
            );
        }
        const created = await seam.createSession({
            workspaceId,
            ...(requestedSessionName !== undefined ? { name: requestedSessionName } : {}),
            owner: OWNER_ADDRESS,
        });
        session = await seam.readSession({
            workspaceId,
            identity: { id: created.sessionId },
        });
        if (session === null) throw new Error(`Failed to read newly created session ${created.sessionId}`);
    } else {
        if (session.hidden_at !== null) {
            await seam.setSessionHidden({
                workspaceId,
                sessionId: session.id,
                hidden: false,
            });
        }
        await seam.claimSessionOwner({
            workspaceId,
            sessionId: session.id,
            owner: OWNER_ADDRESS,
        });
    }

    const canonicalSessionId = formatSessionId(workspaceId, session.name);
    const acpSessionId = rawSessionId !== undefined && rawSessionId.length > 0 ? rawSessionId : canonicalSessionId;
    const translator = new SessionTranslator({
        acpSessionId,
        workspaceId,
        sessionId: session.id,
        origin,
    });

    const bound: BoundSession = {
        acpSessionId,
        workspaceId,
        workspaceName,
        projectRoot,
        projectLabel,
        sessionId: session.id,
        sessionName: session.name,
        translator,
    };
    peer.sessions.set(acpSessionId, bound);
    if (canonicalSessionId !== acpSessionId) {
        peer.sessions.set(canonicalSessionId, bound);
    }
    return bound;
};

export const buildConfigOptions = async (
    seam: ApplicationPort,
    workspaceId: number,
    sessionId: number,
): Promise<SessionConfigOption[]> => {
    const providerCatalog = tryListProviders(seam);
    const aliases = providerCatalog.aliases ?? [];
    const [{ model, spawnModel }, capabilities] = await Promise.all([
        seam.readSessionModel({ workspaceId, sessionId }),
        seam.readWorkspaceCapabilities({ workspaceId }),
    ]);
    const effortInfo = model !== null
        ? await seam.readSessionEffort({ workspaceId, sessionId })
        : { effort: null, supportedEfforts: [] as const };

    const modelOptions = aliases.map((a) => ({
        value: a.alias,
        name: `${a.alias} (${a.provider}/${a.model})`,
        description: a.inputCapacity ? `${Math.round(a.inputCapacity / 1000)}k context` : null,
    }));
    const currentModelValue = model !== null
        ? (model.alias ?? `${model.provider}/${model.model}`)
        : (aliases.find((a) => a.active)?.alias ?? "");
    if (currentModelValue.length > 0 && !modelOptions.some((o) => o.value === currentModelValue)) {
        modelOptions.unshift({
            value: currentModelValue,
            name: currentModelValue,
            description: null,
        });
    }

    const effortLevels = effortInfo.supportedEfforts.length > 0
        ? effortInfo.supportedEfforts
        : (["low", "medium", "high"] as const);
    const currentEffort = effortInfo.effort ?? "medium";

    const spawnOptions = [
        { value: "inherit", name: "Inherit from parent", description: null },
        ...modelOptions,
    ];
    const currentSpawnValue = spawnModel !== null
        ? (spawnModel.alias ?? `${spawnModel.provider}/${spawnModel.model}`)
        : "inherit";

    const wsPolicy = capabilities.workspace;
    const wsDeny = wsPolicy?.deny;
    const wsAllow = wsPolicy?.allow;
    const currentPolicy = Array.isArray(wsDeny) && wsDeny.length > 0
        ? "deny"
        : Array.isArray(wsAllow) && wsAllow.length > 0
            ? "allow"
            : "propose";

    return [
        {
            configId: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: currentModelValue,
            options: modelOptions,
        },
        {
            configId: "thought_level",
            name: "Thinking Effort",
            category: "thought_level",
            type: "select",
            currentValue: currentEffort,
            options: effortLevels.map((lvl) => ({
                value: lvl,
                name: lvl,
                description: null,
            })),
        },
        {
            configId: "spawn_model",
            name: "Child Session Model",
            category: "model_config",
            type: "select",
            currentValue: currentSpawnValue,
            options: spawnOptions,
        },
        {
            configId: "mode",
            name: "Approval Policy",
            category: "mode",
            type: "select",
            currentValue: currentPolicy,
            options: [
                { value: "propose", name: "Ask before external mutations", description: null },
                { value: "allow", name: "Auto-approve all operations", description: null },
                { value: "deny", name: "Deny gated operations", description: null },
            ],
        },
    ];
};

export const applyConfigOption = async (
    seam: ApplicationPort,
    bound: BoundSession,
    configId: string,
    rawValue: unknown,
): Promise<SessionConfigOption[]> => {
    const value = typeof rawValue === "string" ? rawValue : String(rawValue);
    switch (configId) {
        case "model":
            await seam.setSessionModel({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                selector: value,
            });
            break;
        case "thought_level":
            await seam.setSessionEffort({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                effort: value,
            });
            break;
        case "spawn_model":
            await seam.setSessionSpawnModel({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                selector: value === "inherit" ? null : value,
            });
            break;
        case "mode":
            if (value === "propose") {
                await seam.setWorkspaceCapabilities({
                    workspaceId: bound.workspaceId,
                    policy: {},
                });
            } else if (value === "allow") {
                await seam.setWorkspaceCapabilities({
                    workspaceId: bound.workspaceId,
                    policy: {
                        allow: [
                            { access: "observe" },
                            { access: "mutate" },
                            { access: "execute" },
                            { access: "interact" },
                            { access: "control" },
                        ],
                    },
                });
            } else if (value === "deny") {
                await seam.setWorkspaceCapabilities({
                    workspaceId: bound.workspaceId,
                    policy: { deny: [{ access: "mutate" }, { access: "execute" }, { access: "control" }] },
                });
            } else {
                throw RequestError.invalidParams({ detail: `Unsupported mode '${value}'.` });
            }
            break;
        default: {
            const colonIdx = configId.indexOf(":");
            const family = colonIdx > 0 ? configId.slice(0, colonIdx) : "";
            const alias = colonIdx > 0 ? configId.slice(colonIdx + 1) : "";
            if ((family === "mcp" || family === "skills" || family === "schedule") && alias.length > 0) {
                const enabled = rawValue === true || value === "true" || value === "1" || value === "on";
                const verb = enabled ? "enable" : "disable";
                await seam.invokeModuleAction(
                    `workspace.${family}.${verb}`,
                    { alias },
                    { scope: "workspace", workspaceId: bound.workspaceId },
                );
                break;
            }
            throw RequestError.invalidParams({ detail: `Unknown configId '${configId}'.` });
        }
    }
    return await buildConfigOptions(seam, bound.workspaceId, bound.sessionId);
};

export const listSessionsOverview = async (
    seam: ApplicationPort,
    opts: ResolvedModuleOptions,
    origin: string,
    cwd?: string | null,
): Promise<SessionInfo[]> => {
    const overview = await seam.readSessionOverview({
        limit: opts.overviewSessions,
        excerptChars: opts.excerptChars,
    });
    const wsById = new Map<number, ApplicationOverviewWorkspace>();
    for (const ws of overview.workspaces) {
        wsById.set(ws.id, ws);
    }

    return overview.sessions
        .filter((s) => {
            if (!cwd) return true;
            const ws = wsById.get(s.workspaceId);
            return ws?.projectRoot === cwd;
        })
        .map((s) => {
            const ws = wsById.get(s.workspaceId);
            const wsName = ws?.name ?? String(s.workspaceId);
            const projectRoot = ws?.projectRoot ?? "/";
            const reply = s.reply;
            const replyAt = reply !== null ? new Date(reply.at).toISOString() : undefined;
            const replyMeta = reply !== null
                ? {
                      ...reply,
                      body: {
                          url: `${origin}/acp/${s.workspaceId}/${s.id}/entry?target=${encodeURIComponent(
                              `log:///${reply.coordinate}/SEND`,
                          )}`,
                      },
                  }
                : null;
            return {
                sessionId: formatSessionId(s.workspaceId, s.name),
                cwd: projectRoot,
                title: `${wsName}#${s.name}`,
                updatedAt: replyAt,
                _meta: {
                    plurnk: {
                        workspaceId: s.workspaceId,
                        workspaceName: wsName,
                        sessionId: s.id,
                        sessionName: s.name,
                        lifecycle: s.lifecycle,
                        reply: replyMeta,
                    },
                },
            };
        });
};
