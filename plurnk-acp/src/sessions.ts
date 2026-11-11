// {§acp-daemon-client} {§acp-session-owner} {§acp-action-binding} Session and workspace binding, ownership, and single-port admission.

import type { McpOverAcpHttpBridge } from "@agentclientprotocol/sdk/experimental/mcp-http";
import {
    RequestError,
    isMcpServerAcp,
    type AgentContext,
    type AuthAccount,
    type AuthStatusResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    isRecord,
    isSafeInteger,
    type ApplicationSessionProjection,
    type ClientInteractionProjection,
    type ProblemDetails,
    type ProposalProjection,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { AcpDescendantState } from "./client.ts";
import SessionTranslator from "./SessionTranslator.ts";

export const OWNER_ADDRESS = "acp://operator";

export interface BoundSession {
    readonly acpSessionId: string;
    readonly workspaceId: number;
    workspaceName: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly sessionId: number;
    readonly sessionName: string;
    readonly translator: SessionTranslator;
    principalRunning?: boolean;
}

export interface AcpPeer {
    readonly family: string | null;
    readonly subject?: string | null;
    readonly sessions: Map<string, BoundSession>;
    client: AgentContext | null;
    lastAuthStatusJson?: string;
    closeTransport?: () => void;
    closeWithProblem(problem: ProblemDetails): Promise<void>;
}

export const formatSessionId = (workspaceId: number, sessionName: string): string => `${workspaceId}#${sessionName}`;

export const parseSessionId = (
    raw: string,
): { readonly workspaceId?: number; readonly workspaceName?: string; readonly sessionName: string } | null => {
    const idx = raw.indexOf("#");
    if (idx <= 0 || idx === raw.length - 1) return null;
    const prefix = raw.slice(0, idx);
    const sessionName = raw.slice(idx + 1);
    if (sessionName.length === 0) return null;
    if (/^\d+$/u.test(prefix)) {
        if (!/^[1-9]\d*$/u.test(prefix)) return null;
        const wsId = Number(prefix);
        if (!isSafeInteger(wsId) || wsId <= 0) return null;
        return { workspaceId: wsId, sessionName };
    }
    if (
        prefix.trim() !== prefix ||
        !prefix.isWellFormed() ||
        prefix.split("/").some((segment) => segment === "." || segment === "..")
    ) {
        return null;
    }
    return { workspaceName: prefix, sessionName };
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

export const buildSessionDescendants = (
    sessions: readonly ApplicationSessionProjection[],
    proposals: readonly ProposalProjection[],
    interactions: readonly ClientInteractionProjection[],
    ancestorSessionId: number,
): readonly AcpDescendantState[] =>
    sessions
        .filter((s) => s.archived_at === null && isDescendantSession(sessions, s.id, ancestorSessionId))
        .map((s) => ({
            id: s.id,
            name: s.name,
            parentSessionId: s.parentSessionId,
            kind: s.kind,
            lifecycle: s.lifecycle,
            gates: [
                ...proposals.filter((p) => p.sessionId === s.id && p.disposition.decision === "review"),
                ...interactions.filter((i) => i.sessionId === s.id),
            ],
        }));

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

const validateInitialConfigOptions = (raw: unknown): void => {
    if (raw === undefined || raw === null) return;
    if (!Array.isArray(raw)) {
        throw RequestError.invalidParams({
            detail: "Initial 'configOptions' must be an array.",
        });
    }
    const seenIds = new Set<string>();
    for (const entry of raw) {
        if (!isRecord(entry) || typeof entry.configId !== "string" || entry.configId.length === 0) {
            throw RequestError.invalidParams({
                detail: "Initial 'configOptions' entry requires a non-empty string 'configId'.",
            });
        }
        if (seenIds.has(entry.configId)) {
            throw RequestError.invalidParams({
                detail: `Duplicate 'configId' '${entry.configId}' in initial 'configOptions'.`,
            });
        }
        seenIds.add(entry.configId);
        if (typeof entry.type !== "string" || entry.type.length === 0) {
            throw RequestError.invalidParams({
                detail: `Initial 'configOptions' entry '${entry.configId}' requires a string 'type'.`,
            });
        }
        if (entry.type === "id" && typeof entry.value !== "string") {
            throw RequestError.invalidParams({
                detail: `Initial 'configOptions' entry '${entry.configId}' of type 'id' requires a string 'value'.`,
            });
        }
        if (entry.type === "boolean" && typeof entry.value !== "boolean") {
            throw RequestError.invalidParams({
                detail: `Initial 'configOptions' entry '${entry.configId}' of type 'boolean' requires a boolean 'value'.`,
            });
        }
    }
};

export const assertSinglePortSecurity = (params: unknown): void => {
    if (!isRecord(params)) return;
    validateInitialConfigOptions(params.configOptions);
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
                op: "edit",
                aside: null,
                headers: null,
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

export const clearSystemPrompt = async (
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
                op: "kill",
                aside: null,
                headers: null,
                remote: null,
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
                .replace(/[^a-z0-9_-]+/gu, "-")
                .replace(/^[-_]+|[-_]+$/gu, "")
                .replace(/^([0-9])/u, "mcp-$1") || "acp-mcp";
        const headers: Record<string, string> = {};
        for (const h of httpDecl.headers) {
            headers[h.name] = h.value;
        }
        await seam.invokeModuleAction(
            actionName,
            {
                alias,
                type: "streamable-http",
                url: httpDecl.url,
                ...(Object.keys(headers).length > 0 ? { headers } : {}),
            },
            { scope: "workspace", workspaceId },
        );
    }
};

export const extractProblemFromError = (err: unknown): ProblemDetails | null =>
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
        const code = problem.status === 404 ? -32002 : -32000;
        return new RequestError(code, `${problem.detail} (${slug})`, { ...problem, problem });
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

export const buildAuthStatus = (seam: ApplicationPort): AuthStatusResponse => {
    const { aliases } = tryListProviders(seam);
    const aliasList = aliases ?? [];
    const accounts: AuthAccount[] = [];
    const seenLabels = new Set<string>();

    for (const a of aliasList) {
        if (seenLabels.has(a.alias)) continue;
        seenLabels.add(a.alias);
        accounts.push({
            label: a.alias,
            name: `${a.provider}/${a.model}`,
            active: a.active,
        });
    }

    const catalogItems = (() => {
        try {
            return seam.listModels?.({})?.items ?? [];
        } catch {
            return [];
        }
    })();

    for (const entry of catalogItems) {
        if (!entry.readiness?.ready) continue;
        if (seenLabels.has(entry.provider)) continue;
        seenLabels.add(entry.provider);
        accounts.push({
            label: entry.provider,
            name: entry.providerName || entry.provider,
            active: aliasList.some((a) => a.provider === entry.provider && a.active) || aliasList.length === 0,
        });
    }

    return {
        state: accounts.length > 0 ? "authenticated" : "unauthenticated",
        ...(accounts.length > 0 ? { accounts } : {}),
    };
};

export const extractPlurnkMeta = (meta: unknown): {
    readonly workspaceId?: number;
    readonly workspaceName?: string;
    readonly sessionName?: string;
    readonly reason?: string;
    readonly create?: boolean;
    readonly activate?: boolean;
    readonly control?: boolean;
    readonly interactive?: boolean;
    readonly tools?: readonly string[];
    readonly archived?: boolean;
    readonly window?: boolean;
    readonly historyLoops?: number;
    readonly historyPageChars?: number;
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
    const reason = typeof p.reason === "string" && p.reason.trim().length > 0 ? p.reason.trim() : undefined;
    const create = typeof p.create === "boolean" ? p.create : undefined;
    const activate = typeof p.activate === "boolean" ? p.activate : undefined;
    const control = typeof p.control === "boolean" ? p.control : undefined;
    const interactive = typeof p.interactive === "boolean" ? p.interactive : undefined;
    const tools = Array.isArray(p.tools)
        ? p.tools.filter((x): x is string => typeof x === "string")
        : undefined;
    const archived = typeof p.archived === "boolean" ? p.archived : undefined;
    const window = typeof p.window === "boolean" ? p.window : undefined;
    const historyLoops = typeof p.historyLoops === "number" && Number.isInteger(p.historyLoops) && p.historyLoops > 0
        ? p.historyLoops
        : undefined;
    const historyPageChars = typeof p.historyPageChars === "number" && Number.isInteger(p.historyPageChars) && p.historyPageChars > 0
        ? p.historyPageChars
        : undefined;
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
        ...(reason !== undefined ? { reason } : {}),
        ...(create !== undefined ? { create } : {}),
        ...(activate !== undefined ? { activate } : {}),
        ...(control !== undefined ? { control } : {}),
        ...(interactive !== undefined ? { interactive } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(archived !== undefined ? { archived } : {}),
        ...(window !== undefined ? { window } : {}),
        ...(historyLoops !== undefined ? { historyLoops } : {}),
        ...(historyPageChars !== undefined ? { historyPageChars } : {}),
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

const throwSessionNotFound = (sessionId: string): never => {
    const problem = Problems.create("acp", "session-not-found", 404, `Session '${sessionId}' does not exist.`);
    throw new RequestError(
        -32002,
        `Session '${sessionId}' does not exist. (session-not-found)`,
        { sessionId, ...problem, problem },
    );
};

export const lookupSessionTarget = async (
    seam: ApplicationPort,
    rawSessionId: string,
    cwd?: string,
    meta?: unknown,
): Promise<{
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly session: ApplicationSessionProjection;
    readonly canonicalSessionId: string;
}> => {
    const plurnkMeta = extractPlurnkMeta(meta);
    let workspaceId: number;
    let workspaceName: string;
    let projectRoot: string | null = null;
    let projectLabel: string | null = null;
    let requestedSessionName: string;

    if (rawSessionId.includes("#")) {
        const parsed = parseSessionId(rawSessionId);
        if (parsed === null) {
            throw new RequestError(
                -32602,
                `Invalid session address '${rawSessionId}'. (session-address-invalid)`,
                Problems.create("acp", "session-address-invalid", 400, `Invalid session address '${rawSessionId}'.`),
            );
        }
        try {
            const attached = await seam.attachWorkspace(
                parsed.workspaceId !== undefined
                    ? { workspaceId: parsed.workspaceId }
                    : { name: parsed.workspaceName! },
            );
            workspaceId = attached.workspaceId;
            workspaceName = attached.workspaceName;
            projectRoot = attached.projectRoot ?? null;
            projectLabel = attached.projectLabel ?? null;
        } catch (err) {
            const problem = extractProblemFromError(err);
            if (problem !== null && problem.status === 404) {
                return throwSessionNotFound(rawSessionId);
            }
            throw err;
        }
        requestedSessionName = parsed.sessionName;
    } else if (rawSessionId.length > 0) {
        const ref = await seam.readSessionReference({ namespace: "acp", reference: rawSessionId });
        if (ref !== null) {
            let attached: Awaited<ReturnType<ApplicationPort["attachWorkspace"]>>;
            try {
                attached = await seam.attachWorkspace({ workspaceId: ref.workspaceId });
            } catch (err) {
                const problem = extractProblemFromError(err);
                if (problem !== null && problem.status === 404) {
                    return throwSessionNotFound(rawSessionId);
                }
                throw err;
            }
            const session = await seam.readSession({
                workspaceId: ref.workspaceId,
                identity: { id: ref.sessionId },
            });
            if (session === null) {
                return throwSessionNotFound(rawSessionId);
            }
            return {
                workspaceId: attached.workspaceId,
                workspaceName: attached.workspaceName,
                projectRoot: attached.projectRoot ?? null,
                projectLabel: attached.projectLabel ?? null,
                session,
                canonicalSessionId: formatSessionId(attached.workspaceId, session.name),
            };
        }
        try {
            const resolved = await resolveWorkspace(
                seam,
                cwd,
                plurnkMeta.workspaceId,
                plurnkMeta.workspaceName,
                false,
                plurnkMeta.projectRoot,
                plurnkMeta.settings,
            );
            workspaceId = resolved.workspaceId;
            workspaceName = resolved.workspaceName;
            projectRoot = resolved.projectRoot;
            projectLabel = resolved.projectLabel;
        } catch (err) {
            const problem = extractProblemFromError(err);
            if (problem !== null && problem.status === 404) {
                return throwSessionNotFound(rawSessionId);
            }
            throw err;
        }
        requestedSessionName = rawSessionId;
    } else {
        return throwSessionNotFound(rawSessionId);
    }

    const session = await seam.readSession({ workspaceId, identity: { name: requestedSessionName } });
    if (session === null) {
        return throwSessionNotFound(rawSessionId);
    }
    return {
        workspaceId,
        workspaceName,
        projectRoot,
        projectLabel,
        session,
        canonicalSessionId: formatSessionId(workspaceId, session.name),
    };
};

export const registerAcpSessionOwner = async (
    seam: ApplicationPort,
    workspaceId: number,
    plurnkMeta: { readonly interactive?: boolean; readonly tools?: readonly string[] },
): Promise<void> => {
    const interactive = plurnkMeta.interactive ?? true;
    const clientTools = plurnkMeta.tools ?? (interactive ? ["question", "mcp_input_required"] : []);
    const tools = ["request_approval", ...clientTools.filter((t) => t !== "request_approval")];
    await seam.registerSessionOwner(workspaceId, {
        address: OWNER_ADDRESS,
        tools,
        interactive,
    });
};

export const resolveSessionBinding = async (
    seam: ApplicationPort,
    origin: string,
    peer: AcpPeer,
    rawSessionId: string | undefined,
    cwd: string | undefined,
    createIfMissing: boolean,
    meta?: unknown,
    historyPageChars?: number,
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
            const attached = await seam.attachWorkspace(
                parsed.workspaceId !== undefined
                    ? { workspaceId: parsed.workspaceId }
                    : { name: parsed.workspaceName! },
            );
            workspaceId = attached.workspaceId;
            workspaceName = attached.workspaceName;
            projectRoot = attached.projectRoot ?? null;
            projectLabel = attached.projectLabel ?? null;
        } catch (err) {
            const problem = extractProblemFromError(err);
            if (problem !== null && problem.status === 404) {
                return throwSessionNotFound(rawSessionId);
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
                return throwSessionNotFound(rawSessionId);
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
                    return throwSessionNotFound(rawSessionId);
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

    const takeControl = plurnkMeta.control !== false;
    if (takeControl) {
        if (plurnkMeta.activate === true) {
            await seam.activateWorkspace({ workspaceId });
        }
        await registerAcpSessionOwner(seam, workspaceId, plurnkMeta);
    }

    let session = requestedSessionName !== undefined
        ? await seam.readSession({ workspaceId, identity: { name: requestedSessionName } })
        : null;

    if (session === null) {
        if (!allowCreate) {
            const label = rawSessionId ?? requestedSessionName ?? "unknown";
            return throwSessionNotFound(label);
        }
        const created = await seam.createSession({
            workspaceId,
            ...(requestedSessionName !== undefined ? { name: requestedSessionName } : {}),
            ...(takeControl ? { owner: OWNER_ADDRESS } : {}),
        });
        session = await seam.readSession({
            workspaceId,
            identity: { id: created.sessionId },
        });
        if (session === null) throw new Error(`Failed to read newly created session ${created.sessionId}`);
    } else if (takeControl) {
        if (session.archived_at !== null) {
            await seam.setSessionArchived({
                workspaceId,
                sessionId: session.id,
                archived: false,
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
    const existingBound = peer.sessions.get(acpSessionId) ?? peer.sessions.get(canonicalSessionId);
    const translator =
        existingBound !== undefined &&
        existingBound.workspaceId === workspaceId &&
        existingBound.sessionId === session.id &&
        existingBound.acpSessionId === acpSessionId
            ? existingBound.translator
            : new SessionTranslator({
                  acpSessionId,
                  workspaceId,
                  sessionId: session.id,
                  sessionName: session.name,
                  origin,
                  ...(historyPageChars !== undefined ? { historyPageChars } : {}),
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
