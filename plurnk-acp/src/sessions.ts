// {§acp-daemon-client} {§acp-session-owner} {§acp-overview} {§acp-action-binding} Session and workspace binding, configOptions, and overview projection.

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { McpOverAcpHttpBridge } from "@agentclientprotocol/sdk/experimental/mcp-http";
import {
    RequestError,
    isMcpServerAcp,
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

export const OWNER_ADDRESS = "acp://operator";

export const AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([
    {
        type: "command",
        name: "mcp",
        description: "Manage workspace MCP servers",
        input: { type: "text", hint: "<list|add|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "skills",
        description: "Manage workspace skills",
        input: { type: "text", hint: "<list|add|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "members",
        description: "Manage workspace members",
        input: { type: "text", hint: "<list|add|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "env",
        description: "Manage workspace environment variables",
        input: { type: "text", hint: "<list|set|unset> ..." },
    },
    {
        type: "command",
        name: "schedule",
        description: "Manage workspace schedules",
        input: { type: "text", hint: "<list|add|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "rollback",
        description: "Roll back reversible session operations",
        input: { type: "text", hint: "<coordinate>" },
    },
    {
        type: "command",
        name: "share",
        description: "Write a diagnostic digest of the workspace",
        input: { type: "text", hint: "<folder>" },
    },
    {
        type: "command",
        name: "script",
        description: "Execute PLURNK statements directly",
        input: { type: "text", hint: "<statements>" },
    },
    { type: "command", name: "update", description: "Update the model catalog" },
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

export const isDescendantSession = (
    sessions: readonly { readonly id: number; readonly parentSessionId: number | null }[],
    candidateSessionId: number,
    ancestorSessionId: number,
): boolean => {
    if (candidateSessionId === ancestorSessionId) return false;
    const parentById = new Map<number, number | null>();
    for (const s of sessions) {
        parentById.set(s.id, s.parentSessionId);
    }
    const visited = new Set<number>();
    let current: number | null | undefined = parentById.get(candidateSessionId);
    while (typeof current === "number" && !visited.has(current)) {
        if (current === ancestorSessionId) return true;
        visited.add(current);
        current = parentById.get(current);
    }
    return false;
};

export const selectBoundSessionForTarget = (
    peer: AcpPeer,
    workspaceId: number,
    targetSessionId: number,
    sessions?: readonly { readonly id: number; readonly parentSessionId: number | null }[],
): BoundSession | undefined => {
    const boundById = new Map<number, BoundSession>();
    for (const session of peer.sessions.values()) {
        if (session.workspaceId !== workspaceId) continue;
        if (session.sessionId === targetSessionId) return session;
        if (!boundById.has(session.sessionId)) {
            boundById.set(session.sessionId, session);
        }
    }
    if (sessions === undefined || boundById.size === 0) return undefined;
    const parentById = new Map<number, number | null>();
    for (const s of sessions) {
        parentById.set(s.id, s.parentSessionId);
    }
    const visited = new Set<number>();
    let current: number | null | undefined = parentById.get(targetSessionId);
    while (typeof current === "number" && !visited.has(current)) {
        const ancestorBound = boundById.get(current);
        if (ancestorBound !== undefined) return ancestorBound;
        visited.add(current);
        current = parentById.get(current);
    }
    return undefined;
};

export const assertSinglePortSecurity = (params: unknown): void => {
    if (!isRecord(params)) return;
    if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
        if (!params.mcpServers.every((srv) => isMcpServerAcp(srv))) {
            throw RequestError.invalidParams({
                detail: "Client-supplied stdio and http mcpServers are forbidden by the single-port security contract; only 'acp' (mcp/message) declarations are admitted.",
            });
        }
    }
    if (params.systemPrompt !== undefined && params.systemPrompt !== null) {
        if (
            !isRecord(params.systemPrompt) ||
            params.systemPrompt.mode !== "append" ||
            !Array.isArray(params.systemPrompt.content)
        ) {
            throw RequestError.invalidParams({
                detail: "Client-supplied systemPrompt overrides are forbidden by the single-port security contract; only mode 'append' is supported.",
            });
        }
        for (const block of params.systemPrompt.content) {
            if (!isRecord(block) || typeof block.type !== "string") {
                throw RequestError.invalidParams({
                    detail: "Client-supplied systemPrompt contains an invalid content block.",
                });
            }
            if (block.type === "text") {
                if (typeof block.text !== "string") {
                    throw RequestError.invalidParams({
                        detail: "Client-supplied systemPrompt text block requires a string 'text'.",
                    });
                }
            } else if (block.type === "resource_link") {
                if (typeof block.uri !== "string" || block.uri.length === 0) {
                    throw RequestError.invalidParams({
                        detail: "Client-supplied systemPrompt resource_link block requires a non-empty 'uri'.",
                    });
                }
            } else if (block.type === "resource") {
                if (!isRecord(block.resource) || typeof block.resource.text !== "string") {
                    throw RequestError.invalidParams({
                        detail: "Client-supplied systemPrompt resource block requires text content.",
                    });
                }
            } else {
                throw RequestError.invalidParams({
                    detail: `Client-supplied systemPrompt content block type '${block.type}' is not supported; only 'text', text 'resource', and 'resource_link' blocks are admitted.`,
                });
            }
        }
    }
};

export const applySystemPrompt = async (
    seam: ApplicationPort,
    workspaceId: number,
    sessionId: number,
    sessionName: string,
    systemPrompt: unknown,
): Promise<void> => {
    if (!isRecord(systemPrompt) || systemPrompt.mode !== "append" || !Array.isArray(systemPrompt.content)) {
        return;
    }
    const parts: string[] = [];
    for (const block of systemPrompt.content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            parts.push(block.text);
        } else if (
            block.type === "resource" &&
            isRecord(block.resource) &&
            typeof block.resource.text === "string" &&
            block.resource.text.length > 0
        ) {
            parts.push(block.resource.text);
        } else if (block.type === "resource_link" && typeof block.uri === "string" && block.uri.length > 0) {
            parts.push(`<${block.uri}>`);
        }
    }
    const body = parts.join("\n\n");
    if (body.length === 0) return;
    const targetUri = `session://${sessionName}/AGENTS.md`;
    const existing = await seam.readEntry({
        workspaceId,
        sessionId,
        target: targetUri,
    });
    if (existing.status === 200 && existing.entry?.channels.body?.content === body) {
        return;
    }
    await seam.ensureRuntimeSession(workspaceId);
    await seam.dispatchClientAction({
        workspaceId,
        actor: OWNER_ADDRESS,
        contextSessionId: sessionId,
        statements: [
            {
                op: "EDIT",
                aside: null,
                metadata: null,
                target: {
                    kind: "url",
                    raw: targetUri,
                    scheme: "session",
                    username: null,
                    password: null,
                    hostname: sessionName,
                    port: null,
                    pathname: "/AGENTS.md",
                    query: null,
                    fragment: null,
                },
                lineMarker: { marks: [1, -1] },
                matcher: null,
                body,
                position: { line: 0, column: 0 },
            },
        ],
    });
};

const clearSystemPrompt = async (
    seam: ApplicationPort,
    workspaceId: number,
    sessionId: number,
    sessionName: string,
): Promise<void> => {
    const targetUri = `session://${sessionName}/AGENTS.md`;
    const existing = await seam.readEntry({
        workspaceId,
        sessionId,
        target: targetUri,
    });
    if (existing.status !== 200) return;
    await seam.ensureRuntimeSession(workspaceId);
    await seam.dispatchClientAction({
        workspaceId,
        actor: OWNER_ADDRESS,
        contextSessionId: sessionId,
        statements: [
            {
                op: "KILL",
                aside: null,
                metadata: null,
                target: {
                    kind: "url",
                    raw: targetUri,
                    scheme: "session",
                    username: null,
                    password: null,
                    hostname: sessionName,
                    port: null,
                    pathname: "/AGENTS.md",
                    query: null,
                    fragment: null,
                },
                lineMarker: null,
                matcher: null,
                body: null,
                position: { line: 0, column: 0 },
            },
        ],
    });
};

export const applyAcpMcpServers = async (
    seam: ApplicationPort,
    bridge: McpOverAcpHttpBridge,
    client: NonNullable<AcpPeer["client"]>,
    workspaceId: number,
    mcpServers: readonly unknown[] | null | undefined,
): Promise<void> => {
    if (!Array.isArray(mcpServers) || mcpServers.length === 0) return;
    const actions = seam.listModuleActions?.() ?? [];
    const actionName = actions.some((a) => a.name === "workspace.mcp.replace")
        ? "workspace.mcp.replace"
        : actions.some((a) => a.name === "workspace.mcp.add")
          ? "workspace.mcp.add"
          : null;
    for (const srv of mcpServers) {
        if (!isMcpServerAcp(srv)) continue;
        const httpDecl = await bridge.toHttp(client, srv);
        if (actionName === null) continue;
        const alias =
            srv.name
                .toLowerCase()
                .replace(/[^a-z0-9-]+/gu, "-")
                .replace(/^-+|-+$/gu, "")
                .replace(/^([0-9])/u, "mcp-$1") || "acp-mcp";
        const headers: Record<string, string> = {};
        for (const h of httpDecl.headers) {
            headers[h.name] = h.value;
        }
        const definition = {
            name: alias,
            type: "streamable-http" as const,
            url: httpDecl.url,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
        };
        await seam.invokeModuleAction(
            actionName,
            { alias, definition },
            { scope: "workspace", workspaceId },
        );
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
    const [{ model, spawnModel }, capabilities, personas, session] = await Promise.all([
        seam.readSessionModel({ workspaceId, sessionId }),
        seam.readWorkspaceCapabilities({ workspaceId }),
        seam.listPersonas?.({ workspaceId }) ?? Promise.resolve([]),
        seam.readSession({ workspaceId, identity: { id: sessionId } }).catch(() => null),
    ]);
    const agentsEntry = session === null
        ? null
        : await seam.readEntry({
            workspaceId,
            sessionId,
            target: `session://${session.name}/AGENTS.md`,
        }).catch(() => null);
    const rawAgentsBody = agentsEntry !== null && agentsEntry.status === 200
        ? (agentsEntry.entry?.channels.body?.content ?? "").trim()
        : "";
    const matchedPersona = rawAgentsBody.length > 0
        ? personas.find((p) => p.body.trim() === rawAgentsBody)
        : undefined;
    const currentPersonaValue = rawAgentsBody.length === 0
        ? "none"
        : (matchedPersona?.name ?? "custom");
    const personaOptions = [
        { value: "none", name: "None (default)", description: null },
        ...personas.map((p) => ({
            value: p.name,
            name: p.name,
            description: p.description,
        })),
        ...(currentPersonaValue === "custom"
            ? [{ value: "custom", name: "Custom (session AGENTS.md)", description: null }]
            : []),
    ];
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

    const options: SessionConfigOption[] = [
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
        {
            configId: "persona",
            name: "Persona",
            category: "_persona",
            type: "select",
            currentValue: currentPersonaValue,
            options: personaOptions,
        },
    ];

    const registeredActions = seam.listModuleActions?.() ?? [];
    for (const family of ["mcp", "skills", "schedule"] as const) {
        if (!registeredActions.some((a) => a.name === `workspace.${family}.list`)) continue;
        const listed = await seam
            .invokeModuleAction(`workspace.${family}.list`, {}, { scope: "workspace", workspaceId })
            .catch(() => null);
        if (!isRecord(listed)) continue;
        const items = Array.isArray(listed.definitions)
            ? listed.definitions
            : Array.isArray(listed.items)
              ? listed.items
              : [];
        for (const item of items) {
            if (!isRecord(item) || typeof item.alias !== "string" || item.alias.length === 0) continue;
            const enabled = item.state !== "disabled" && item.enabled !== false;
            options.push({
                configId: `${family}:${item.alias}`,
                name: `${family}:${item.alias}`,
                category: "other",
                type: "boolean",
                currentValue: enabled,
            });
        }
    }

    return options;
};

export const buildAvailableCommands = async (
    seam: ApplicationPort,
    workspaceId: number,
): Promise<AvailableCommand[]> => {
    const commands: AvailableCommand[] = [...AVAILABLE_COMMANDS];
    const registeredActions = seam.listModuleActions?.() ?? [];

    if (registeredActions.some((a) => a.name === "workspace.skills.list")) {
        const listed = await seam
            .invokeModuleAction("workspace.skills.list", {}, { scope: "workspace", workspaceId })
            .catch(() => null);
        if (isRecord(listed)) {
            const items = Array.isArray(listed.definitions)
                ? listed.definitions
                : Array.isArray(listed.items)
                  ? listed.items
                  : [];
            for (const item of items) {
                if (!isRecord(item) || typeof item.alias !== "string" || item.alias.length === 0) continue;
                if (item.state === "disabled" || item.enabled === false || item.state === "unavailable") continue;
                const name = AVAILABLE_COMMANDS.some((c) => c.name === item.alias)
                    ? `skill:${item.alias}`
                    : item.alias;
                const description =
                    isRecord(item.detail) &&
                    typeof item.detail.description === "string" &&
                    item.detail.description.length > 0
                        ? item.detail.description
                        : isRecord(item.definition) &&
                            typeof item.definition.description === "string" &&
                            item.definition.description.length > 0
                          ? item.definition.description
                          : `Invoke Agent Skill '${item.alias}'`;
                commands.push({
                    type: "command",
                    name,
                    description,
                    input: { type: "text", hint: "<instructions>" },
                    _meta: {
                        plurnk: {
                            kind: "skill",
                            alias: item.alias,
                            target: `skill://${item.alias}/SKILL.md`,
                        },
                    },
                });
            }
        }
    }

    if (registeredActions.some((a) => a.name === "workspace.mcp.list")) {
        const listed = await seam
            .invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId })
            .catch(() => null);
        if (isRecord(listed)) {
            const items = Array.isArray(listed.definitions)
                ? listed.definitions
                : Array.isArray(listed.items)
                  ? listed.items
                  : [];
            for (const item of items) {
                if (!isRecord(item) || typeof item.alias !== "string" || item.alias.length === 0) continue;
                if (item.state !== "active" || item.enabled === false) continue;
                const promptDefs =
                    isRecord(item.detail) && Array.isArray(item.detail.promptDefinitions)
                        ? item.detail.promptDefinitions
                        : isRecord(item.detail) && Array.isArray(item.detail.prompts)
                          ? item.detail.prompts
                          : Array.isArray(item.prompts)
                            ? item.prompts
                            : [];
                for (const prompt of promptDefs) {
                    if (!isRecord(prompt) || typeof prompt.name !== "string" || prompt.name.length === 0) continue;
                    const cmdName = `${item.alias}:${prompt.name}`;
                    const description =
                        typeof prompt.description === "string" && prompt.description.length > 0
                            ? prompt.description
                            : `Invoke MCP prompt '${prompt.name}' on '${item.alias}'`;
                    const argHint =
                        Array.isArray(prompt.arguments) && prompt.arguments.length > 0
                            ? prompt.arguments
                                  .filter(
                                      (a): a is Record<string, unknown> & { readonly name: string } =>
                                          isRecord(a) && typeof a.name === "string",
                                  )
                                  .map((a) => `${a.name}=<value>`)
                                  .join(" ") || "<arguments>"
                            : "<arguments>";
                    commands.push({
                        type: "command",
                        name: cmdName,
                        description,
                        input: { type: "text", hint: argHint },
                        _meta: {
                            plurnk: {
                                kind: "mcp_prompt",
                                server: item.alias,
                                prompt: prompt.name,
                                target: `${item.alias}:///prompts/${encodeURIComponent(prompt.name)}`,
                            },
                        },
                    });
                }
            }
        }
    }

    return commands;
};

export type ResolvedPromptCommand =
    | { readonly kind: "builtin"; readonly cmd: string; readonly rest: string }
    | { readonly kind: "open_path"; readonly target: string; readonly text: string };

const formatMcpPromptTarget = (server: string, promptName: string, inputText: string): { readonly target: string; readonly text: string } => {
    const baseTarget = `${server}:///prompts/${encodeURIComponent(promptName)}`;
    const trimmed = inputText.trim();
    if (trimmed.length === 0) {
        return { target: baseTarget, text: "" };
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (isRecord(parsed)) {
                const params = new URLSearchParams();
                for (const [k, v] of Object.entries(parsed)) {
                    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
                        params.set(k, String(v));
                    }
                }
                const qs = params.toString();
                return { target: qs.length > 0 ? `${baseTarget}?${qs}` : baseTarget, text: "" };
            }
        } catch {
            // Fall through to key=value or free-form text
        }
    }
    const tokens = trimmed.split(/\s+/u);
    if (tokens.length > 0 && tokens.every((t) => /^[A-Za-z_][A-Za-z0-9_-]*=/u.test(t))) {
        const params = new URLSearchParams();
        for (const token of tokens) {
            const eqIdx = token.indexOf("=");
            params.set(token.slice(0, eqIdx), token.slice(eqIdx + 1));
        }
        const qs = params.toString();
        return { target: qs.length > 0 ? `${baseTarget}?${qs}` : baseTarget, text: "" };
    }
    return { target: baseTarget, text: trimmed };
};

export const resolvePromptCommand = async (
    seam: ApplicationPort,
    workspaceId: number,
    rawName: string,
    rawInput: unknown,
): Promise<ResolvedPromptCommand | null> => {
    const name = rawName.trim().replace(/^\/+/u, "");
    if (name.length === 0) return null;
    const inputText =
        typeof rawInput === "string"
            ? rawInput.trim()
            : isRecord(rawInput) && typeof rawInput.text === "string"
              ? rawInput.text.trim()
              : "";
    const lower = name.toLowerCase();
    if (AVAILABLE_COMMANDS.some((c) => c.name === lower)) {
        return { kind: "builtin", cmd: lower, rest: inputText };
    }
    const commands = await buildAvailableCommands(seam, workspaceId);
    const matched = commands.find(
        (c) =>
            c.name === name ||
            (name.startsWith("skill:") &&
                isRecord(c._meta) &&
                isRecord(c._meta.plurnk) &&
                c._meta.plurnk.kind === "skill" &&
                c._meta.plurnk.alias === name.slice("skill:".length)),
    );
    if (matched === undefined || !isRecord(matched._meta) || !isRecord(matched._meta.plurnk)) {
        return null;
    }
    const meta = matched._meta.plurnk;
    if (meta.kind === "skill" && typeof meta.alias === "string") {
        return {
            kind: "open_path",
            target: `skill://${meta.alias}/SKILL.md`,
            text: inputText,
        };
    }
    if (meta.kind === "mcp_prompt" && typeof meta.server === "string" && typeof meta.prompt === "string") {
        const formatted = formatMcpPromptTarget(meta.server, meta.prompt, inputText);
        return {
            kind: "open_path",
            target: formatted.target,
            text: formatted.text,
        };
    }
    return null;
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
        case "persona": {
            if (value === "none") {
                await clearSystemPrompt(seam, bound.workspaceId, bound.sessionId, bound.sessionName);
                break;
            }
            const personas = (await seam.listPersonas?.({ workspaceId: bound.workspaceId })) ?? [];
            const matched = personas.find((p) => p.name === value);
            if (matched === undefined) {
                throw RequestError.invalidParams({ detail: `Unknown persona '${value}'.` });
            }
            await applySystemPrompt(seam, bound.workspaceId, bound.sessionId, bound.sessionName, {
                mode: "append",
                content: [{ type: "text", text: matched.body }],
            });
            if (matched.model !== undefined || matched.effort !== undefined) {
                const { model } = await seam.readSessionModel({
                    workspaceId: bound.workspaceId,
                    sessionId: bound.sessionId,
                });
                if (model === null && matched.model !== undefined) {
                    await seam.setSessionModel({
                        workspaceId: bound.workspaceId,
                        sessionId: bound.sessionId,
                        selector: matched.model,
                        ...(matched.effort === undefined ? {} : { effort: matched.effort }),
                    });
                } else if (matched.effort !== undefined && model?.effortSource !== "explicit") {
                    const effortInfo = await seam.readSessionEffort({
                        workspaceId: bound.workspaceId,
                        sessionId: bound.sessionId,
                    }).catch(() => null);
                    if (
                        effortInfo !== null &&
                        effortInfo.source !== "explicit" &&
                        effortInfo.effort !== null &&
                        (effortInfo.supportedEfforts.length === 0 ||
                            effortInfo.supportedEfforts.includes(matched.effort))
                    ) {
                        await seam.setSessionEffort({
                            workspaceId: bound.workspaceId,
                            sessionId: bound.sessionId,
                            effort: matched.effort,
                        });
                    }
                }
            }
            break;
        }
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

export const applyAdditionalDirectories = async (
    seam: ApplicationPort,
    workspaceId: number,
    projectRoot: string | null,
    additionalDirectories: readonly string[] | null | undefined,
): Promise<void> => {
    if (!Array.isArray(additionalDirectories) || additionalDirectories.length === 0) return;
    const files: string[] = [];
    for (const rawDir of additionalDirectories) {
        if (typeof rawDir !== "string" || rawDir.trim().length === 0) continue;
        const normalized = rawDir.trim().replace(/\/+$/u, "");
        if (normalized.length === 0) continue;
        if (projectRoot !== null && projectRoot.length > 0 && isAbsolute(normalized)) {
            const rel = relative(projectRoot, resolve(normalized)).split(sep).join("/");
            files.push(rel.length === 0 ? "**" : `${rel}/**`);
        } else {
            files.push(`${normalized}/**`);
        }
    }
    if (files.length === 0) return;
    await seam.invokeModuleAction(
        "workspace.members.add",
        { files },
        { scope: "workspace", workspaceId },
    );
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

    const additionalDirsByWs = new Map<number, string[]>();
    const hasMembersList = (seam.listModuleActions?.() ?? []).some((a) => a.name === "workspace.members.list");
    if (hasMembersList) {
        await Promise.all(
            overview.workspaces.map(async (ws) => {
                const listed = await seam
                    .invokeModuleAction("workspace.members.list", {}, { scope: "workspace", workspaceId: ws.id })
                    .catch(() => null);
                if (!isRecord(listed) || !Array.isArray(listed.definitions)) return;
                const dirs: string[] = [];
                for (const item of listed.definitions) {
                    if (!isRecord(item) || item.state === "disabled" || item.enabled === false) continue;
                    const glob =
                        typeof item.alias === "string"
                            ? item.alias
                            : isRecord(item.definition) && typeof item.definition.glob === "string"
                              ? item.definition.glob
                              : "";
                    if (glob.startsWith("!") || !glob.endsWith("/**") || glob === "**") continue;
                    const dirPart = glob.slice(0, -3);
                    if (dirPart.length === 0) continue;
                    const resolvedDir =
                        ws.projectRoot !== null && ws.projectRoot.length > 0 && !isAbsolute(dirPart)
                            ? resolve(ws.projectRoot, dirPart)
                            : dirPart;
                    dirs.push(resolvedDir);
                }
                if (dirs.length > 0) {
                    additionalDirsByWs.set(ws.id, dirs);
                }
            }),
        );
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
            const additionalDirectories = additionalDirsByWs.get(s.workspaceId);
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
                ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
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
