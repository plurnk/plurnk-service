// {§acp-session-owner} {§acp-proposal-resolve} {§acp-topology-scope}
// Per-connection ACP v2 AgentApp factory and JSON-RPC request/notification coordinator.

import { createRequire } from "node:module";
import { McpOverAcpHttpBridge } from "@agentclientprotocol/sdk/experimental/mcp-http";
import {
    McpOverAcpCaller,
    agent,
    methods,
    type AgentApp,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isRecord, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { registerConfigAndCancelHandlers } from "./agent/config-and-cancel.ts";
import type { AgentPeerRuntime, ConnectionAgentContext } from "./agent/context.ts";
import { registerSessionPromptHandler } from "./agent/prompt.ts";
import { registerSessionLifecycleHandlers } from "./agent/session-lifecycle.ts";
import { applyWorkspaceRenamed, broadcastWorkspaceCommandsUpdate } from "./events.ts";
import { buildAuthStatus, type AcpPeer } from "./sessions.ts";

export type { ConnectionAgentContext };

export const createConnectionAgent = (
    host: ConnectionAgentContext,
    connInfo: {
        readonly subject?: string | null;
        readonly handle?: string;
        readonly name?: string;
        readonly canDelegateActor?: boolean;
        readonly closeTransport?: () => void;
    },
): AgentApp => {
    const { seam, opts, peers, gates, optionSync, notifyPeerSession } = host;

    const notifyAuthStatusChanged = (): void => {
        const status = buildAuthStatus(seam);
        const json = JSON.stringify(status);
        for (const p of peers) {
            if (p.client === null || p.lastAuthStatusJson === json) continue;
            p.lastAuthStatusJson = json;
            void p.client.notify(methods.client.auth.statusUpdate, status).catch(() => undefined);
        }
    };

    const notifyWorkspaceCommandsChanged = async (workspaceId: number, excludePeer?: AcpPeer): Promise<void> => {
        await broadcastWorkspaceCommandsUpdate(seam, peers, notifyPeerSession, workspaceId, excludePeer);
    };

    const actionCallbacks = {
        excerptChars: opts.excerptChars,
        onWorkspaceRenamed: (workspaceId: number, name: string) =>
            applyWorkspaceRenamed(peers, notifyPeerSession, workspaceId, name),
        onAuthStatusChanged: notifyAuthStatusChanged,
        getCommandsGeneration: (workspaceId: number) => optionSync.commandsGeneration(workspaceId),
        onWorkspaceCommandsChanged: async (workspaceId: number, prevGeneration?: number) => {
            if (prevGeneration !== undefined && optionSync.commandsGeneration(workspaceId) > prevGeneration) {
                await optionSync.flush(workspaceId);
                return;
            }
            await notifyWorkspaceCommandsChanged(workspaceId);
        },
    };

    const peer: AcpPeer = {
        subject: connInfo.subject ?? null,
        ...(connInfo.handle !== undefined ? { handle: connInfo.handle } : {}),
        ...(connInfo.name !== undefined ? { name: connInfo.name } : {}),
        canDelegateActor: connInfo.canDelegateActor === true,
        sessions: new Map(),
        client: null,
        closeTransport: connInfo.closeTransport,
        closeWithProblem: async (problem: ProblemDetails) => {
            if (peer.client !== null) {
                const deliveries: Promise<unknown>[] = [];
                for (const session of new Set(peer.sessions.values())) {
                    deliveries.push(
                        peer.client
                            .notify(methods.client.session.update, {
                                sessionId: session.acpSessionId,
                                update: {
                                    sessionUpdate: "notice",
                                    severity: "error",
                                    title: problem.title,
                                    description: `problem:${problem.title} — ${problem.detail}`,
                                    _meta: { plurnk: { problem } },
                                },
                            })
                            .catch(() => undefined),
                    );
                }
                await Promise.allSettled(deliveries);
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            peer.closeTransport?.();
        },
    };

    const acpPkg: unknown = createRequire(import.meta.url)("../package.json");
    const acpPackageVersion =
        isRecord(acpPkg) && typeof acpPkg.version === "string" && acpPkg.version.length > 0
            ? acpPkg.version
            : "3.0.0";
    const serviceVersion =
        typeof seam.serviceVersion === "string" && seam.serviceVersion.length > 0
            ? seam.serviceVersion
            : acpPackageVersion;

    const mcpCaller = new McpOverAcpCaller({
        clientInfo: { name: "@plurnk/plurnk-service", version: serviceVersion },
    });
    const mcpBridge = new McpOverAcpHttpBridge(mcpCaller);

    const app = agent({ name: "@plurnk/plurnk-service" });

    app.onNotification(methods.agent.mcp.message, mcpCaller.handleNotification);

    app.onConnect((conn) => {
        peer.client = conn.client;
        peers.add(peer);
        void conn.closed.finally(() => {
            peers.delete(peer);
            gates.removePeer(peer);
            for (const bound of new Set(peer.sessions.values())) {
                bound.translator.clear();
            }
            peer.sessions.clear();
        });
    });

    const rt: AgentPeerRuntime = {
        host,
        peer,
        serviceVersion,
        mcpCaller,
        mcpBridge,
        actionCallbacks,
        notifyWorkspaceCommandsChanged,
    };

    registerConfigAndCancelHandlers(app, rt);
    registerSessionLifecycleHandlers(app, rt);
    registerSessionPromptHandler(app, rt);

    return app;
};
