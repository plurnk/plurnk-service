// {§acp-session-owner} {§acp-topology-scope} {§acp-http-authorization}
// Shared per-connection agent context, subtree teardown helpers, and prompt segment utilities.

import type { McpOverAcpHttpBridge } from "@agentclientprotocol/sdk/experimental/mcp-http";
import type { McpOverAcpCaller, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { PlurnkActionCallbacks } from "../actions.ts";
import type { ResolvedModuleOptions } from "../config.ts";
import type { OptionSyncTracker } from "../events.ts";
import type { GateTracker } from "../gates.ts";
import { OWNER_ADDRESS, type AcpPeer, type BoundSession } from "../sessions.ts";

export interface ConnectionAgentContext {
    readonly seam: ApplicationPort;
    readonly opts: ResolvedModuleOptions;
    readonly peers: Set<AcpPeer>;
    readonly gates: GateTracker;
    readonly optionSync: OptionSyncTracker;
    readonly httpOrigin: () => string;
    readonly requestSubject?: () => string | null;
    readonly requestCanDelegateActor?: () => boolean | undefined;
    readonly notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void;
    readonly broadcastSessionUpdate: (
        workspaceId: number,
        sessionId: number,
        buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
    ) => void;
}

export interface AgentPeerRuntime {
    readonly host: ConnectionAgentContext;
    readonly peer: AcpPeer;
    readonly serviceVersion: string;
    readonly mcpCaller: McpOverAcpCaller;
    readonly mcpBridge: McpOverAcpHttpBridge;
    readonly actionCallbacks: PlurnkActionCallbacks;
    readonly notifyWorkspaceCommandsChanged: (workspaceId: number, excludePeer?: AcpPeer) => Promise<void>;
}

export const toEpochMs = (ts: string | number | null | undefined): number | null => {
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;
    if (typeof ts === "string") {
        const parsed = Date.parse(ts);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

/** {§acp-http-authorization} A prompt attachment is named by its URI's last path segment; the whole URI stays its target. */
export const uriLeaf = (uri: string): string | null => {
    let pathname: string;
    try {
        pathname = new URL(uri).pathname;
    } catch {
        pathname = uri.split(/[?#]/u)[0] ?? "";
    }
    const segment = pathname.slice(pathname.lastIndexOf("/") + 1);
    let leaf: string;
    try {
        leaf = decodeURIComponent(segment);
    } catch {
        leaf = segment;
    }
    return leaf.length > 0 && !leaf.includes("/") ? leaf : null;
};

export type PromptSegment = { readonly kind: "text" | "skill"; readonly value: string };

export const joinPromptSegments = (segments: readonly PromptSegment[]): string => {
    if (!segments.some((s) => s.kind === "text" && s.value.trim().length > 0)) {
        return "";
    }
    let out = "";
    let prevKind: "text" | "skill" | null = null;
    for (const seg of segments) {
        if (seg.value.length === 0) continue;
        if (out.length === 0) {
            out = seg.value;
            prevKind = seg.kind;
            continue;
        }
        if (seg.kind === "skill" || prevKind === "skill") {
            if (/[\s([{]$/u.test(out) || /^[\s.,;:!?)\]}]/u.test(seg.value)) {
                out += seg.value;
            } else {
                out += ` ${seg.value}`;
            }
        } else {
            out += `\n${seg.value}`;
        }
        prevKind = seg.kind;
    }
    return out;
};

export const cancelSubtreeWork = async (
    seam: ApplicationPort,
    gates: GateTracker,
    workspaceId: number,
    subtreeIds: ReadonlySet<number>,
    reason: string,
): Promise<void> => {
    const [proposals, interactions] = await Promise.all([
        seam.pendingProposals(workspaceId).catch(() => []),
        seam.pendingClientInteractions(workspaceId).catch(() => []),
    ]);
    for (const p of proposals) {
        if (subtreeIds.has(p.sessionId) && p.disposition.decision === "review") {
            await seam
                .resolveProposal(p.logEntryId, { decision: "cancel" }, { workspaceId, address: OWNER_ADDRESS })
                .catch(() => undefined);
        }
    }
    for (const i of interactions) {
        if (subtreeIds.has(i.sessionId)) {
            await seam
                .resolveClientInteraction(
                    i.interactionId,
                    { action: "cancel" },
                    { workspaceId, address: OWNER_ADDRESS },
                )
                .catch(() => undefined);
        }
    }
    for (const sId of subtreeIds) {
        const streams = await seam.readStreams({ workspaceId, sessionId: sId }).catch(() => []);
        for (const st of streams) {
            await seam.cancelStream({ workspaceId, sessionId: sId, entryId: st.entryId }).catch(() => undefined);
        }
        await seam.cancelSession({ workspaceId, sessionId: sId, reason }).catch(() => undefined);
        gates.cancelSessionGates(workspaceId, sId);
    }
};

export const removeBoundSubtree = (
    gates: GateTracker,
    workspaceId: number,
    subtreeIds: ReadonlySet<number>,
    targetPeers: Iterable<AcpPeer>,
): void => {
    for (const p of targetPeers) {
        gates.removePeerSession(p, workspaceId, subtreeIds);
        for (const [key, bound] of [...p.sessions.entries()]) {
            if (bound.workspaceId === workspaceId && subtreeIds.has(bound.sessionId)) {
                bound.translator.clear();
                p.sessions.delete(key);
            }
        }
    }
};
