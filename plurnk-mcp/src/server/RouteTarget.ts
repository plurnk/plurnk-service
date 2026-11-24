// {§mcp-http-server} — Workspace and session resolution for `/mcp[/<workspace>[/<session>]]`.

import { Problems } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { McpRouteTarget } from "./EventBus.ts";
import { mcpHttpProblem } from "./HttpExchange.ts";

export const resolveMcpRouteTarget = async (
    seam: ApplicationPort,
    workspaceSegment?: string,
    sessionSegment?: string,
    allowAutoCreate = true,
): Promise<McpRouteTarget> => {
    let workspaceId: number;
    if (workspaceSegment !== undefined) {
        if (/^[1-9]\d*$/u.test(workspaceSegment)) {
            const attached = await seam.attachWorkspace({ workspaceId: Number(workspaceSegment) });
            workspaceId = attached.workspaceId;
        } else {
            try {
                const attached = await seam.attachWorkspace({ name: workspaceSegment });
                workspaceId = attached.workspaceId;
            } catch (cause) {
                const problem = Problems.fromError(cause);
                if (allowAutoCreate && problem !== null && problem.status === 404) {
                    const created = await seam.createWorkspace({ name: workspaceSegment, projectRoot: null });
                    workspaceId = created.workspaceId;
                } else {
                    throw cause;
                }
            }
        }
    } else {
        try {
            const attached = await seam.attachWorkspace({ name: "default" });
            workspaceId = attached.workspaceId;
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem !== null && problem.status === 404) {
                const existing = await seam.listWorkspaces({ archived: false });
                if (existing.length > 0) {
                    workspaceId = existing[0].id;
                } else if (allowAutoCreate) {
                    const created = await seam.createWorkspace({ name: "default", projectRoot: null });
                    workspaceId = created.workspaceId;
                } else {
                    throw cause;
                }
            } else {
                throw cause;
            }
        }
    }

    await seam.activateWorkspace({ workspaceId });
    const runtimeSessionId = await seam.ensureRuntimeSession(workspaceId);

    if (sessionSegment !== undefined) {
        if (/^[1-9]\d*$/u.test(sessionSegment)) {
            const requestedId = Number(sessionSegment);
            const existing = await seam.readSession({ workspaceId, identity: { id: requestedId } });
            if (existing === null) {
                const err = new Error(`Session ${requestedId} does not exist in workspace ${workspaceId}.`);
                Object.assign(err, {
                    problem: mcpHttpProblem(
                        "session-not-found",
                        404,
                        `Session ${requestedId} does not exist in workspace ${workspaceId}.`,
                        { workspaceId, sessionId: requestedId, stage: "routing", retryable: false },
                    ),
                });
                throw err;
            }
            return {
                workspaceId,
                sessionId: existing.id,
                runtimeSessionId,
                isModelSession: existing.origin === "model",
            };
        }
        if (sessionSegment === "_plurnk") {
            return {
                workspaceId,
                sessionId: runtimeSessionId,
                runtimeSessionId,
                isModelSession: false,
            };
        }
        const existing = await seam.readSession({ workspaceId, identity: { name: sessionSegment } });
        if (existing !== null) {
            return {
                workspaceId,
                sessionId: existing.id,
                runtimeSessionId,
                isModelSession: existing.origin === "model",
            };
        }
        if (!allowAutoCreate) {
            const err = new Error(`Session '${sessionSegment}' does not exist in workspace ${workspaceId}.`);
            Object.assign(err, {
                problem: mcpHttpProblem(
                    "session-not-found",
                    404,
                    `Session '${sessionSegment}' does not exist in workspace ${workspaceId}.`,
                    { workspaceId, session: sessionSegment, stage: "routing", retryable: false },
                ),
            });
            throw err;
        }
        const created = await seam.createSession({ workspaceId, name: sessionSegment });
        return {
            workspaceId,
            sessionId: created.sessionId,
            runtimeSessionId,
            isModelSession: true,
        };
    }

    const userSession = await seam.readSession({ workspaceId, identity: { name: "user" } });
    if (userSession !== null) {
        return {
            workspaceId,
            sessionId: userSession.id,
            runtimeSessionId,
            isModelSession: userSession.origin === "model",
        };
    }
    const sessions = await seam.listSessions(workspaceId, { archived: false });
    const firstModelSession = sessions.find((s) => s.origin === "model");
    if (firstModelSession !== undefined) {
        return {
            workspaceId,
            sessionId: firstModelSession.id,
            runtimeSessionId,
            isModelSession: true,
        };
    }
    if (!allowAutoCreate) {
        return {
            workspaceId,
            sessionId: runtimeSessionId,
            runtimeSessionId,
            isModelSession: false,
        };
    }
    const created = await seam.createSession({ workspaceId, name: "user" });
    return {
        workspaceId,
        sessionId: created.sessionId,
        runtimeSessionId,
        isModelSession: true,
    };
};
