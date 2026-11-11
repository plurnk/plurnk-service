// {§acp-overview} Workspace and session overview projection for session/list.

import { isAbsolute, resolve } from "node:path";
import {
    RequestError,
    type ListSessionsResponse,
    type SessionInfo,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    isRecord,
    isSafeInteger,
    type ApplicationOverviewWorkspace,
    type ApplicationSessionOverview,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { ResolvedModuleOptions } from "./config.ts";
import { formatSessionId } from "./sessions.ts";

export interface OverviewRequestOptions {
    readonly cwd?: string | null;
    readonly archived?: "exclude" | "include" | "only";
    readonly workspaceId?: number;
    readonly workspaceName?: string;
    readonly limit?: number;
    readonly excerptChars?: number;
}

const throwOverviewInvalid = (detail: string): never => {
    const problem = Problems.create("acp", "overview-invalid", 400, detail);
    throw new RequestError(-32602, `${detail} (overview-invalid)`, { ...problem, problem });
};

export const parseOverviewRequest = (
    cwd: string | null | undefined,
    meta: unknown,
    archived?: string | null,
): OverviewRequestOptions => {
    let resolvedArchived: "exclude" | "include" | "only" | undefined;
    if (archived !== undefined && archived !== null) {
        if (archived !== "exclude" && archived !== "include" && archived !== "only") {
            return throwOverviewInvalid(
                `Invalid overview archived filter '${archived}'; expected 'exclude', 'include', or 'only'.`,
            );
        }
        resolvedArchived = archived;
    }
    const baseOpts: OverviewRequestOptions = {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(resolvedArchived !== undefined ? { archived: resolvedArchived } : {}),
    };
    if (meta === undefined || meta === null) {
        return baseOpts;
    }
    if (!isRecord(meta)) {
        return throwOverviewInvalid("Invalid overview _meta.");
    }
    const rawPlurnk = meta.plurnk;
    if (rawPlurnk === undefined || rawPlurnk === null) {
        return baseOpts;
    }
    if (!isRecord(rawPlurnk)) {
        return throwOverviewInvalid("Invalid overview _meta.plurnk.");
    }
    let workspaceId: number | undefined;
    if (rawPlurnk.workspaceId !== undefined && rawPlurnk.workspaceId !== null) {
        if (!isSafeInteger(rawPlurnk.workspaceId) || rawPlurnk.workspaceId < 1) {
            return throwOverviewInvalid(
                "Invalid overview workspaceId; expected a positive safe integer.",
            );
        }
        workspaceId = rawPlurnk.workspaceId;
    }
    let workspaceName: string | undefined;
    const rawWsName = rawPlurnk.workspaceName ?? rawPlurnk.workspace;
    if (rawWsName !== undefined && rawWsName !== null) {
        if (typeof rawWsName !== "string" || rawWsName.trim().length === 0) {
            return throwOverviewInvalid(
                "Invalid overview workspace name; expected a non-empty string.",
            );
        }
        workspaceName = rawWsName.trim();
    }
    let limit: number | undefined;
    if (rawPlurnk.limit !== undefined && rawPlurnk.limit !== null) {
        if (!isSafeInteger(rawPlurnk.limit) || rawPlurnk.limit < 1) {
            return throwOverviewInvalid(
                "Invalid overview limit; expected a positive safe integer.",
            );
        }
        limit = rawPlurnk.limit;
    }
    let excerptChars: number | undefined;
    if (rawPlurnk.excerptChars !== undefined && rawPlurnk.excerptChars !== null) {
        if (!isSafeInteger(rawPlurnk.excerptChars) || rawPlurnk.excerptChars < 1) {
            return throwOverviewInvalid(
                "Invalid overview excerptChars; expected a positive safe integer.",
            );
        }
        excerptChars = rawPlurnk.excerptChars;
    }
    return {
        ...baseOpts,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(excerptChars !== undefined ? { excerptChars } : {}),
    };
};

export const listSessionsOverview = async (
    seam: ApplicationPort,
    opts: ResolvedModuleOptions,
    origin: string,
    query: OverviewRequestOptions = {},
): Promise<ListSessionsResponse> => {
    const effectiveLimit = query.limit ?? opts.overviewSessions;
    const effectiveExcerptChars = query.excerptChars ?? opts.excerptChars;
    const archiveFilter = query.archived ?? "exclude";

    const rawWorkspaces = await seam.listWorkspaces({ archived: false });
    let resolvedWorkspaceId = query.workspaceId;
    if (resolvedWorkspaceId === undefined && query.workspaceName !== undefined) {
        const allWs = await seam.listWorkspaces();
        const foundWs = allWs.find((w) => w.name === query.workspaceName);
        if (foundWs === undefined) {
            const problem = Problems.create(
                "daemon:workspace",
                "workspace-not-found",
                404,
                `Workspace ${JSON.stringify(query.workspaceName)} does not exist.`,
                { name: query.workspaceName },
            );
            throw new RequestError(-32002, `${problem.detail} (workspace-not-found)`, { ...problem, problem });
        }
        resolvedWorkspaceId = foundWs.id;
    }

    const [overview, recentOverview] = await Promise.all([
        seam.readSessionOverview({
            ...(resolvedWorkspaceId !== undefined ? { workspaceId: resolvedWorkspaceId } : {}),
            limit: effectiveLimit,
            excerptChars: effectiveExcerptChars,
        }),
        resolvedWorkspaceId !== undefined
            ? seam.readSessionOverview({
                  limit: effectiveLimit,
                  excerptChars: effectiveExcerptChars,
              })
            : Promise.resolve(null),
    ]);

    const wsById = new Map<number, ApplicationOverviewWorkspace>();
    for (const w of rawWorkspaces) {
        wsById.set(w.id, {
            id: w.id,
            name: w.name,
            projectRoot: w.project_root,
            projectLabel: w.project_label,
        });
    }
    for (const ws of overview.workspaces) {
        wsById.set(ws.id, ws);
    }
    if (recentOverview !== null) {
        for (const ws of recentOverview.workspaces) {
            wsById.set(ws.id, ws);
        }
    }
    if (resolvedWorkspaceId !== undefined && !wsById.has(resolvedWorkspaceId)) {
        const allWs = await seam.listWorkspaces();
        const foundWs = allWs.find((w) => w.id === resolvedWorkspaceId);
        if (foundWs !== undefined) {
            wsById.set(foundWs.id, {
                id: foundWs.id,
                name: foundWs.name,
                projectRoot: foundWs.project_root,
                projectLabel: foundWs.project_label,
            });
        }
    }

    const additionalDirsByWs = new Map<number, string[]>();
    const hasMembersList = (seam.listModuleActions?.() ?? []).some((a) => a.name === "workspace.members.list");
    if (hasMembersList) {
        await Promise.all(
            [...wsById.values()].map(async (ws) => {
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

    const mapSession = (
        s: ApplicationSessionOverview["sessions"][number],
        archived = false,
    ): SessionInfo => {
        const ws = wsById.get(s.workspaceId);
        const wsName = ws?.name ?? String(s.workspaceId);
        const rawProjectRoot = ws?.projectRoot ?? null;
        const rawProjectLabel = ws?.projectLabel ?? null;
        const cwd = rawProjectRoot ?? "/";
        const additionalDirectories = additionalDirsByWs.get(s.workspaceId);
        const reply = s.reply;
        const replyAt = reply !== null ? new Date(reply.at).toISOString() : undefined;
        const replyMeta =
            reply !== null
                ? {
                      ...reply,
                      body: {
                          url: `${origin}/acp/${s.workspaceId}/${s.id}/entry?target=${encodeURIComponent(
                              `log:///${reply.coordinate}/${reply.completion === 499 ? "fail" : "done"}`,
                          )}`,
                          mimeType: "text/plain",
                      },
                  }
                : null;
        const displayTitle = typeof s.title === "string" && s.title.length > 0 ? s.title : `${wsName}#${s.name}`;
        return {
            sessionId: formatSessionId(s.workspaceId, s.name),
            cwd,
            ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
            title: displayTitle,
            updatedAt: replyAt,
            archived,
            _meta: {
                plurnk: {
                    workspaceId: s.workspaceId,
                    workspaceName: wsName,
                    id: s.id,
                    sessionId: s.id,
                    name: s.name,
                    sessionName: s.name,
                    parentSessionId: s.parentSessionId,
                    kind: s.kind,
                    lifecycle: s.lifecycle,
                    gates: s.gates,
                    archived,
                    ...(typeof s.title === "string" ? { title: s.title } : {}),
                    projectRoot: rawProjectRoot,
                    projectLabel: rawProjectLabel,
                    reply: replyMeta,
                },
            },
        };
    };

    const unarchivedSessions =
        archiveFilter === "only"
            ? []
            : overview.sessions
                  .filter((s) => {
                      if (!query.cwd) return true;
                      const ws = wsById.get(s.workspaceId);
                      return ws?.projectRoot === query.cwd;
                  })
                  .map((s) => mapSession(s, false));

    let archivedSessions: SessionInfo[] = [];
    if (archiveFilter === "include" || archiveFilter === "only") {
        const targetWsIds = resolvedWorkspaceId !== undefined ? [resolvedWorkspaceId] : [...wsById.keys()];
        const perWs = await Promise.all(
            targetWsIds.map(async (wsId) => {
                const ws = wsById.get(wsId);
                if (query.cwd && ws?.projectRoot !== query.cwd) return [];
                const rows = await seam.listSessions(wsId, { archived: true });
                return rows
                    .filter((r) => r.archived_at !== null)
                    .map((r) =>
                        mapSession(
                            {
                                workspaceId: wsId,
                                id: r.id,
                                name: r.name,
                                parentSessionId: r.parentSessionId,
                                kind: r.kind,
                                lifecycle: r.lifecycle,
                                gates: 0,
                                ...(typeof r.title === "string" ? { title: r.title } : {}),
                                reply: null,
                            },
                            true,
                        ),
                    );
            }),
        );
        archivedSessions = perWs.flat();
    }

    const sessions = [...unarchivedSessions, ...archivedSessions].slice(0, effectiveLimit);

    const recentSessions = recentOverview !== null ? recentOverview.sessions.map((s) => mapSession(s, false)) : undefined;

    return {
        sessions,
        _meta: {
            plurnk: {
                scope: resolvedWorkspaceId !== undefined ? { workspaceId: resolvedWorkspaceId } : null,
                workspaces: [...wsById.values()],
                omitted: overview.omitted,
                ...(recentSessions !== undefined && recentOverview !== null
                    ? {
                          recent: recentSessions,
                          recentOmitted: recentOverview.omitted,
                      }
                    : {}),
            },
        },
    };
};
