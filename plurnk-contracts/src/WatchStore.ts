// {§application-session-observation} {§notifications} —
// Pure, runtime-neutral homomorphic Watch state and idempotent reducer over `DaemonNotificationStreamEnvelope`.

import type {
    ApplicationOverviewSession,
    ApplicationOverviewWorkspace,
    ApplicationSessionOrigin,
    ApplicationSessionOverview,
} from "./Application.ts";
import type {
    DaemonNotificationStreamEnvelope,
    NotificationsSnapshotPayload,
} from "./ApplicationNotifications.ts";
import { lifecycleOfLoopStatus } from "./LoopLifecycle.ts";
import type { ClientInteractionProjection, ProposalProjection } from "./types.ts";

export interface WatchWorkspace extends ApplicationOverviewWorkspace {
    readonly archived: boolean;
    readonly order: number;
}

export interface WatchSession extends ApplicationOverviewSession {
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly archived: boolean;
}

export type WatchProposal = ProposalProjection & { readonly workspaceId: number };
export type WatchInteraction = ClientInteractionProjection & { readonly workspaceId: number };

export interface WatchState {
    readonly epoch: string | null;
    readonly lastEventId: number;
    readonly hydrated: boolean;
    readonly omitted: number;
    readonly nextWorkspaceOrder: number;
    readonly workspaces: ReadonlyMap<number, WatchWorkspace>;
    readonly sessions: ReadonlyMap<string, WatchSession>;
    readonly proposals: ReadonlyMap<string, WatchProposal>;
    readonly interactions: ReadonlyMap<string, WatchInteraction>;
}

export interface WatchReduceOutcome {
    readonly state: WatchState;
    readonly changed: boolean;
    readonly resyncRequired: boolean;
}

export const watchSessionKey = (workspaceId: number, sessionId: number): string =>
    `${workspaceId}:${sessionId}`;

const gateKey = (workspaceId: number, itemId: number): string => `${workspaceId}:${itemId}`;

const countSessionGates = (
    workspaceId: number,
    sessionId: number,
    proposals: ReadonlyMap<string, WatchProposal>,
    interactions: ReadonlyMap<string, WatchInteraction>,
): number => {
    let count = 0;
    for (const proposal of proposals.values()) {
        if (proposal.workspaceId === workspaceId && proposal.sessionId === sessionId) {
            count += 1;
        }
    }
    for (const interaction of interactions.values()) {
        if (interaction.workspaceId === workspaceId && interaction.sessionId === sessionId) {
            count += 1;
        }
    }
    return count;
};

/** {§application-session-observation} Creates an empty unhydrated WatchState. */
export const createWatchState = (): WatchState => ({
    epoch: null,
    lastEventId: 0,
    hydrated: false,
    omitted: 0,
    nextWorkspaceOrder: 0,
    workspaces: new Map(),
    sessions: new Map(),
    proposals: new Map(),
    interactions: new Map(),
});

/** {§application-session-observation} Replaces WatchState from a `NotificationsSnapshotPayload` or `ApplicationSessionOverview`. */
export const hydrateWatchState = (
    snapshot: Pick<
        NotificationsSnapshotPayload,
        "workspaces" | "sessions" | "proposals" | "interactions" | "omitted"
    > & {
        readonly epoch?: string | null;
        readonly latestId?: number;
    },
    defaultWorkspaceId: number | null = null,
): WatchState => {
    const workspaces = new Map<number, WatchWorkspace>();
    let order = 0;
    for (const ws of snapshot.workspaces) {
        workspaces.set(ws.id, {
            id: ws.id,
            name: ws.name,
            projectRoot: ws.projectRoot,
            projectLabel: ws.projectLabel,
            archived: false,
            order: order++,
        });
    }

    const sessionWorkspaceById = new Map<number, number>();
    for (const s of snapshot.sessions) {
        sessionWorkspaceById.set(s.id, s.workspaceId);
    }

    const proposals = new Map<string, WatchProposal>();
    for (const proposal of snapshot.proposals) {
        if (proposal.disposition.decision !== "review") continue;
        const wsId = sessionWorkspaceById.get(proposal.sessionId) ?? defaultWorkspaceId;
        if (wsId === null) continue;
        proposals.set(gateKey(wsId, proposal.logEntryId), { ...proposal, workspaceId: wsId });
    }

    const interactions = new Map<string, WatchInteraction>();
    for (const interaction of snapshot.interactions) {
        const wsId = sessionWorkspaceById.get(interaction.sessionId) ?? defaultWorkspaceId;
        if (wsId === null) continue;
        interactions.set(gateKey(wsId, interaction.interactionId), { ...interaction, workspaceId: wsId });
    }

    const sessions = new Map<string, WatchSession>();
    for (const s of snapshot.sessions) {
        const ws = workspaces.get(s.workspaceId);
        const wsName = ws?.name ?? String(s.workspaceId);
        const projRoot = ws?.projectRoot ?? null;
        const projLabel = ws?.projectLabel ?? projRoot;
        const gates = countSessionGates(s.workspaceId, s.id, proposals, interactions);
        sessions.set(watchSessionKey(s.workspaceId, s.id), {
            ...s,
            gates: Math.max(s.gates, gates),
            workspaceName: wsName,
            projectRoot: projRoot,
            projectLabel: projLabel,
            archived: false,
        });
    }

    return {
        epoch: snapshot.epoch ?? null,
        lastEventId: snapshot.latestId ?? 0,
        hydrated: true,
        omitted: snapshot.omitted,
        nextWorkspaceOrder: order,
        workspaces,
        sessions,
        proposals,
        interactions,
    };
};

/**
 * {§application-session-observation} Projects a `WatchState` into canonical `ApplicationSessionOverview` order
 * (most recently finished `reply.id` DESC, then newest unreplied `id` DESC, holding all gated sessions plus `limit`).
 */
export const projectWatchOverview = (
    state: WatchState,
    options?: { readonly limit?: number },
): ApplicationSessionOverview => {
    const activeWorkspaces = [...state.workspaces.values()]
        .filter((ws) => !ws.archived)
        .toSorted((a, b) => a.id - b.id)
        .map(({ id, name, projectRoot, projectLabel }) => ({
            id,
            name,
            projectRoot,
            projectLabel,
        }));
    const activeWorkspaceIds = new Set(activeWorkspaces.map((ws) => ws.id));

    const ranked = [...state.sessions.values()]
        .filter((s) => !s.archived && activeWorkspaceIds.has(s.workspaceId))
        .toSorted((a, b) =>
            a.reply !== null && b.reply !== null
                ? b.reply.id - a.reply.id
                : a.reply !== null
                  ? -1
                  : b.reply !== null
                    ? 1
                    : b.id - a.id,
        );

    const limit = options?.limit;
    const held =
        limit === undefined
            ? ranked
            : ranked.filter((s, index) => index < limit || s.gates > 0);
    const extraOmitted = ranked.length - held.length;

    const sessions: ApplicationOverviewSession[] = held.map((s) => ({
        workspaceId: s.workspaceId,
        id: s.id,
        name: s.name,
        parentSessionId: s.parentSessionId,
        parentName: s.parentName,
        parentOrigin: s.parentOrigin,
        kind: s.kind,
        lifecycle: s.lifecycle,
        gates: s.gates,
        ...(s.opening !== undefined ? { opening: s.opening } : {}),
        reply: s.reply,
        ...(typeof s.title === "string" ? { title: s.title } : {}),
        ...(typeof s.persona === "string" ? { persona: s.persona } : {}),
    }));

    const activeSessionKeys = new Set(ranked.map((s) => watchSessionKey(s.workspaceId, s.id)));
    const proposals: ProposalProjection[] = [];
    for (const { workspaceId, ...proposal } of state.proposals.values()) {
        if (activeSessionKeys.has(watchSessionKey(workspaceId, proposal.sessionId))) {
            proposals.push(proposal);
        }
    }
    const interactions: ClientInteractionProjection[] = [];
    for (const { workspaceId, ...interaction } of state.interactions.values()) {
        if (activeSessionKeys.has(watchSessionKey(workspaceId, interaction.sessionId))) {
            interactions.push(interaction);
        }
    }

    return {
        sessions,
        workspaces: activeWorkspaces,
        proposals,
        interactions,
        omitted: state.omitted + extraOmitted,
    };
};

const removeSessionGates = (
    workspaceId: number,
    sessionIds: ReadonlySet<number>,
    proposals: ReadonlyMap<string, WatchProposal>,
    interactions: ReadonlyMap<string, WatchInteraction>,
): {
    nextProposals: Map<string, WatchProposal>;
    nextInteractions: Map<string, WatchInteraction>;
    removedAny: boolean;
} => {
    let removedAny = false;
    const nextProposals = new Map(proposals);
    for (const [key, item] of proposals) {
        if (item.workspaceId === workspaceId && sessionIds.has(item.sessionId)) {
            nextProposals.delete(key);
            removedAny = true;
        }
    }
    const nextInteractions = new Map(interactions);
    for (const [key, item] of interactions) {
        if (item.workspaceId === workspaceId && sessionIds.has(item.sessionId)) {
            nextInteractions.delete(key);
            removedAny = true;
        }
    }
    return { nextProposals, nextInteractions, removedAny };
};

/**
 * {§application-session-observation} {§notifications} Pure, idempotent Watch state transition reducer.
 */
export const reduceWatchNotification = (
    state: WatchState,
    envelope: DaemonNotificationStreamEnvelope,
): WatchReduceOutcome => {
    if (envelope.event === "notifications/snapshot") {
        return {
            state: hydrateWatchState(envelope.data, envelope.workspaceId),
            changed: true,
            resyncRequired: false,
        };
    }
    if (envelope.event === "notifications/resync") {
        return {
            state: {
                ...state,
                epoch: envelope.data.epoch,
                lastEventId: envelope.data.latestId,
            },
            changed: false,
            resyncRequired: true,
        };
    }

    const nextLastId = Math.max(state.lastEventId, envelope.id);
    const wsId = envelope.workspaceId;

    switch (envelope.event) {
        case "workspace/created": {
            const { id, name, projectRoot, projectLabel } = envelope.data;
            const prev = state.workspaces.get(id);
            const workspaces = new Map(state.workspaces);
            const nextOrder = prev?.order ?? state.nextWorkspaceOrder;
            workspaces.set(id, {
                id,
                name,
                projectRoot,
                projectLabel: projectLabel ?? projectRoot,
                archived: false,
                order: nextOrder,
            });
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    nextWorkspaceOrder: prev ? state.nextWorkspaceOrder : state.nextWorkspaceOrder + 1,
                    workspaces,
                },
                changed: true,
                resyncRequired: false,
            };
        }
        case "workspace/renamed": {
            const { id, name } = envelope.data;
            const prev = state.workspaces.get(id);
            const workspaces = new Map(state.workspaces);
            workspaces.set(id, {
                id,
                name,
                projectRoot: prev?.projectRoot ?? null,
                projectLabel: prev?.projectLabel ?? null,
                archived: prev?.archived ?? false,
                order: prev?.order ?? state.nextWorkspaceOrder,
            });
            const sessions = new Map(state.sessions);
            for (const [key, sess] of sessions) {
                if (sess.workspaceId === id && sess.workspaceName !== name) {
                    sessions.set(key, { ...sess, workspaceName: name });
                }
            }
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    nextWorkspaceOrder: prev ? state.nextWorkspaceOrder : state.nextWorkspaceOrder + 1,
                    workspaces,
                    sessions,
                },
                changed: true,
                resyncRequired: false,
            };
        }
        case "workspace/archived": {
            const { id, archivedAt } = envelope.data;
            const isArchived = archivedAt !== null;
            const prev = state.workspaces.get(id);
            const workspaces = new Map(state.workspaces);
            if (prev) {
                workspaces.set(id, { ...prev, archived: isArchived });
            }
            let sessions = state.sessions;
            let proposals = state.proposals;
            let interactions = state.interactions;
            if (isArchived) {
                const nextSessions = new Map(state.sessions);
                const removedIds = new Set<number>();
                for (const [key, sess] of state.sessions) {
                    if (sess.workspaceId === id) {
                        nextSessions.delete(key);
                        removedIds.add(sess.id);
                    }
                }
                sessions = nextSessions;
                if (removedIds.size > 0) {
                    const cleaned = removeSessionGates(id, removedIds, proposals, interactions);
                    proposals = cleaned.nextProposals;
                    interactions = cleaned.nextInteractions;
                }
            }
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    workspaces,
                    sessions,
                    proposals,
                    interactions,
                },
                changed: Boolean(prev) || sessions !== state.sessions,
                resyncRequired: false,
            };
        }
        case "session/created": {
            const data = envelope.data;
            const targetWsId = data.workspaceId;
            const prevWs = state.workspaces.get(targetWsId);
            const workspaces = new Map(state.workspaces);
            workspaces.set(targetWsId, {
                id: targetWsId,
                name: data.workspaceName,
                projectRoot: data.projectRoot,
                projectLabel: data.projectLabel ?? data.projectRoot,
                archived: false,
                order: prevWs?.order ?? state.nextWorkspaceOrder,
            });
            const nextOrder = prevWs ? state.nextWorkspaceOrder : state.nextWorkspaceOrder + 1;
            if (data.origin !== "model") {
                return {
                    state: {
                        ...state,
                        lastEventId: nextLastId,
                        nextWorkspaceOrder: nextOrder,
                        workspaces,
                    },
                    changed: !prevWs,
                    resyncRequired: false,
                };
            }
            const key = watchSessionKey(targetWsId, data.id);
            const prevSess = state.sessions.get(key);
            const parentEntry =
                data.parentSessionId !== null
                    ? state.sessions.get(watchSessionKey(targetWsId, data.parentSessionId))
                    : undefined;
            const parentName: string | null =
                data.parentSessionId === null
                    ? null
                    : (parentEntry?.name ?? prevSess?.parentName ?? "_plurnk");
            const parentOrigin: ApplicationSessionOrigin | null =
                data.parentSessionId === null
                    ? null
                    : (parentEntry !== undefined ? "model" : (prevSess?.parentOrigin ?? "_plurnk"));
            const gates = countSessionGates(targetWsId, data.id, state.proposals, state.interactions);
            const inheritedOpening =
                prevSess?.opening ?? (data.kind === "fork" ? parentEntry?.opening : undefined);
            const sessions = new Map(state.sessions);
            sessions.set(key, {
                workspaceId: targetWsId,
                workspaceName: data.workspaceName,
                projectRoot: data.projectRoot,
                projectLabel: data.projectLabel ?? data.projectRoot,
                id: data.id,
                name: data.name,
                parentSessionId: data.parentSessionId,
                parentName,
                parentOrigin,
                kind: data.kind,
                lifecycle: prevSess?.lifecycle && prevSess.lifecycle !== "idle" ? prevSess.lifecycle : data.lifecycle,
                gates,
                ...(inheritedOpening !== undefined ? { opening: inheritedOpening } : {}),
                reply: prevSess?.reply ?? null,
                ...(prevSess?.title !== undefined ? { title: prevSess.title } : {}),
                ...(typeof data.persona === "string"
                    ? { persona: data.persona }
                    : prevSess?.persona !== undefined
                      ? { persona: prevSess.persona }
                      : {}),
                archived: false,
            });
            // Also refresh any child sessions already holding this session as `parentSessionId`.
            for (const [childKey, child] of sessions) {
                if (child.workspaceId === targetWsId && child.parentSessionId === data.id) {
                    if (child.parentName !== data.name || child.parentOrigin !== "model") {
                        sessions.set(childKey, { ...child, parentName: data.name, parentOrigin: "model" });
                    }
                }
            }
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    nextWorkspaceOrder: nextOrder,
                    workspaces,
                    sessions,
                },
                changed: true,
                resyncRequired: false,
            };
        }
        case "session/archived":
        case "session/deleted": {
            if (wsId === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            if (envelope.event === "session/archived" && envelope.data.archivedAt === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const removedSet = new Set(envelope.data.sessionIds);
            const sessions = new Map(state.sessions);
            let changed = false;
            for (const sid of removedSet) {
                if (sessions.delete(watchSessionKey(wsId, sid))) {
                    changed = true;
                }
            }
            const cleaned = removeSessionGates(wsId, removedSet, state.proposals, state.interactions);
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    sessions,
                    proposals: cleaned.nextProposals,
                    interactions: cleaned.nextInteractions,
                },
                changed: changed || cleaned.removedAny,
                resyncRequired: false,
            };
        }
        case "session/titled": {
            if (wsId === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const key = watchSessionKey(wsId, envelope.data.id);
            const cur = state.sessions.get(key);
            if (!cur) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const nextTitle = envelope.data.title.trim();
            if ((cur.title ?? "") === nextTitle) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const sessions = new Map(state.sessions);
            const updated: WatchSession = { ...cur, title: nextTitle };
            sessions.set(key, updated);
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
            };
        }
        case "session/policy": {
            if (wsId === null || !("persona" in envelope.data)) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const key = watchSessionKey(wsId, envelope.data.sessionId);
            const cur = state.sessions.get(key);
            if (!cur) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const nextPersona = typeof envelope.data.persona === "string" ? envelope.data.persona : undefined;
            if ((cur.persona ?? undefined) === nextPersona) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const sessions = new Map(state.sessions);
            const { persona: _prev, ...rest } = cur;
            sessions.set(key, nextPersona !== undefined ? { ...rest, persona: nextPersona } : rest);
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
            };
        }
        case "session/replied": {
            if (wsId === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const key = watchSessionKey(wsId, envelope.data.sessionId);
            const cur = state.sessions.get(key);
            if (!cur) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            if (cur.reply !== null && cur.reply.id > envelope.data.reply.id) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const sessions = new Map(state.sessions);
            sessions.set(key, { ...cur, reply: envelope.data.reply });
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
            };
        }
        case "loop/started":
        case "loop/parked": {
            if (wsId === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const key = watchSessionKey(wsId, envelope.data.sessionId);
            const cur = state.sessions.get(key);
            if (!cur) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const lifecycle = envelope.event === "loop/parked" ? "parked" : "running";
            const incomingOpening =
                envelope.event === "loop/started" &&
                typeof envelope.data.opening === "string" &&
                envelope.data.opening.length > 0
                    ? envelope.data.opening
                    : undefined;
            const nextOpening = cur.opening ?? incomingOpening;
            if (cur.lifecycle === lifecycle && cur.opening === nextOpening) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const sessions = new Map(state.sessions);
            sessions.set(key, {
                ...cur,
                lifecycle,
                ...(nextOpening !== undefined ? { opening: nextOpening } : {}),
            });
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
            };
        }
        case "loop/proposal": {
            if (wsId === null || envelope.data.disposition.decision !== "review") {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const proposals = new Map(state.proposals);
            proposals.set(gateKey(wsId, envelope.data.logEntryId), {
                ...envelope.data,
                workspaceId: wsId,
            });
            const sKey = watchSessionKey(wsId, envelope.data.sessionId);
            const cur = state.sessions.get(sKey);
            const sessions = new Map(state.sessions);
            if (cur) {
                const gates = countSessionGates(wsId, cur.id, proposals, state.interactions);
                sessions.set(sKey, { ...cur, lifecycle: "running", gates });
            }
            return {
                state: { ...state, lastEventId: nextLastId, proposals, sessions },
                changed: true,
                resyncRequired: false,
            };
        }
        case "loop/interaction": {
            if (wsId === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const interactions = new Map(state.interactions);
            interactions.set(gateKey(wsId, envelope.data.interactionId), {
                ...envelope.data,
                workspaceId: wsId,
            });
            const sKey = watchSessionKey(wsId, envelope.data.sessionId);
            const cur = state.sessions.get(sKey);
            const sessions = new Map(state.sessions);
            if (cur) {
                const gates = countSessionGates(wsId, cur.id, state.proposals, interactions);
                sessions.set(sKey, { ...cur, lifecycle: "running", gates });
            }
            return {
                state: { ...state, lastEventId: nextLastId, interactions, sessions },
                changed: true,
                resyncRequired: false,
            };
        }
        case "loop/gate-settled": {
            if (wsId === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            let proposals = state.proposals;
            let interactions = state.interactions;
            let changed = false;
            if (envelope.data.kind === "proposal") {
                const pKey = gateKey(wsId, envelope.data.logEntryId);
                if (proposals.has(pKey)) {
                    const next = new Map(proposals);
                    next.delete(pKey);
                    proposals = next;
                    changed = true;
                }
            } else {
                const iKey = gateKey(wsId, envelope.data.interactionId);
                if (interactions.has(iKey)) {
                    const next = new Map(interactions);
                    next.delete(iKey);
                    interactions = next;
                    changed = true;
                }
            }
            const sKey = watchSessionKey(wsId, envelope.data.sessionId);
            const cur = state.sessions.get(sKey);
            let sessions = state.sessions;
            if (cur) {
                const gates = countSessionGates(wsId, cur.id, proposals, interactions);
                if (cur.gates !== gates) {
                    const nextSessions = new Map(state.sessions);
                    nextSessions.set(sKey, { ...cur, gates });
                    sessions = nextSessions;
                    changed = true;
                }
            }
            return {
                state: { ...state, lastEventId: nextLastId, proposals, interactions, sessions },
                changed,
                resyncRequired: false,
            };
        }
        case "loop/terminated": {
            if (wsId === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false };
            }
            const sid = envelope.data.sessionId;
            const cleaned = removeSessionGates(wsId, new Set([sid]), state.proposals, state.interactions);
            const sKey = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(sKey);
            let sessions = state.sessions;
            let changed = cleaned.removedAny;
            if (cur) {
                const lifecycle = lifecycleOfLoopStatus(envelope.data.result.status);
                if (cur.lifecycle !== lifecycle || cur.gates !== 0) {
                    const nextSessions = new Map(state.sessions);
                    nextSessions.set(sKey, { ...cur, lifecycle, gates: 0 });
                    sessions = nextSessions;
                    changed = true;
                }
            }
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    proposals: cleaned.nextProposals,
                    interactions: cleaned.nextInteractions,
                    sessions,
                },
                changed,
                resyncRequired: false,
            };
        }
        case "config/changed":
        case "functionality/changed":
        case "stream/concluded":
        case "notice/event":
            return {
                state: { ...state, lastEventId: nextLastId },
                changed: false,
                resyncRequired: false,
            };
    }
};
