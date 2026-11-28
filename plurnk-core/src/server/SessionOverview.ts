// {§methods-workspace-create} {§application-session-observation} The places in scope with what waits there: their lifecycle, the
// gates they wait on and their latest finished replies ({§message-completion}), most recently finished first.
import {
    excerptOf,
    type ApplicationOverviewSession,
    type ApplicationSessionOrigin,
    type ApplicationSessionOverview,
    type ClientInteractionProjection,
    type ProposalProjection,
} from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import { sessionLifecycle } from "./envelope.ts";

export interface OverviewPlace {
    readonly id: number;
    readonly replyId: number | null;
}

export interface OverviewPendingGates {
    readonly proposals: readonly ProposalProjection[];
    readonly interactions: readonly ClientInteractionProjection[];
}

export default class SessionOverview {
    // Most recently finished first, by reply row; the places with no reply follow, newest first. The overview holds every
    // place waiting on a gate and the first `limit` in that order. Pagination stays in TypeScript rather than SQL LIMIT:
    // in-memory pending gates (`scope.pending`) retain gated places past `limit`, and `omitted` counts `ranked.length - held.length`
    // across the full in-scope set.
    static hold<T extends OverviewPlace>(places: readonly T[], gates: ReadonlyMap<number, number>, limit: number): { held: T[]; omitted: number } {
        const ranked = places.toSorted((a, b) => a.replyId !== null && b.replyId !== null ? b.replyId - a.replyId
            : a.replyId !== null ? -1 : b.replyId !== null ? 1 : b.id - a.id);
        const held = ranked.filter((place, index) => index < limit || (gates.get(place.id) ?? 0) > 0);
        return { held, omitted: ranked.length - held.length };
    }

    static async read(db: Db, scope: {
        readonly workspaceId: number | null;
        readonly sessionId?: number | null;
        readonly limit: number;
        readonly excerptChars: number;
        // The open review proposals and client interactions of one workspace.
        readonly pending: (workspaceId: number) => Promise<OverviewPendingGates>;
        readonly projectLabel: (projectRoot: string | null) => string | null;
    }): Promise<ApplicationSessionOverview> {
        const rows = await db.overview_places.all<{
            id: number;
            workspaceId: number;
            name: string;
            parentSessionId: number | null;
            parentName: string | null;
            parentOrigin: ApplicationSessionOrigin | null;
            title: string | null;
            persona: string | null;
            kind: ApplicationOverviewSession["kind"];
            loopObservations: string;
            replyId: number | null;
            replyAt: string | null;
            replyCompletion: 200 | 499 | null;
            replyCoordinate: string | null;
        }>({ workspace_id: scope.workspaceId, session_id: scope.sessionId ?? null });
        const inScopeSessionIds = new Set(rows.map((row) => row.id));
        const proposals: ProposalProjection[] = [];
        const interactions: ClientInteractionProjection[] = [];
        const gates = new Map<number, number>();
        // `scope.pending` reads in-memory gate state per workspace; resolve all distinct workspaces concurrently.
        const pendingByWorkspace = await Promise.all(
            [...new Set(rows.map((row) => row.workspaceId))].map((workspaceId) => scope.pending(workspaceId)),
        );
        for (const pending of pendingByWorkspace) {
            for (const proposal of pending.proposals) {
                if (proposal.disposition.decision !== "review" || !inScopeSessionIds.has(proposal.sessionId)) continue;
                proposals.push(proposal);
                gates.set(proposal.sessionId, (gates.get(proposal.sessionId) ?? 0) + 1);
            }
            for (const interaction of pending.interactions) {
                if (!inScopeSessionIds.has(interaction.sessionId)) continue;
                interactions.push(interaction);
                gates.set(interaction.sessionId, (gates.get(interaction.sessionId) ?? 0) + 1);
            }
        }
        const projected = rows.map(({ loopObservations, title, persona, ...row }) => ({
            ...row,
            ...(typeof title === "string" ? { title } : {}),
            ...(typeof persona === "string" ? { persona } : {}),
            lifecycle: sessionLifecycle(loopObservations),
        }));
        const { held, omitted } = SessionOverview.hold(projected, gates, scope.limit);
        const heldIds = held.map(({ id }) => id);
        const replies = held.flatMap(({ replyId }) => replyId === null ? [] : [replyId]);
        const [replyRows, openingRows, workspaces] = await Promise.all([
            db.overview_reply_words.all<{ id: number; words: string | null }>({ ids: JSON.stringify(replies) }),
            db.overview_opening_words.all<{ sessionId: number; words: string | null }>({ ids: JSON.stringify(heldIds) }),
            scope.workspaceId !== null
                ? db.envelope_get_workspace
                      .get<{ id: number; name: string; project_root: string | null }>({ id: scope.workspaceId })
                      .then((ws) => (ws === undefined ? [] : [{ id: ws.id, name: ws.name, projectRoot: ws.project_root }]))
                : db.envelope_list_workspaces
                      .all<{ id: number; name: string; project_root: string | null }>({ archived: 0 })
                      .then((list) =>
                          list
                              .toSorted((a, b) => a.id - b.id)
                              .map(({ id, name, project_root }) => ({ id, name, projectRoot: project_root })),
                      ),
        ]);
        const words = new Map(replyRows.map(({ id, words: text }) => [id, text ?? ""]));
        const openings = new Map(openingRows.map(({ sessionId, words: text }) => [sessionId, text ?? ""]));
        return {
            sessions: held.map((place) => {
                const opening = openings.has(place.id)
                    ? excerptOf(openings.get(place.id) ?? "", scope.excerptChars).excerpt
                    : "";
                return {
                    workspaceId: place.workspaceId,
                    id: place.id,
                    name: place.name,
                    parentSessionId: place.parentSessionId,
                    parentName: place.parentSessionId === null ? null : place.parentName,
                    parentOrigin: place.parentSessionId === null ? null : place.parentOrigin,
                    kind: place.kind,
                    lifecycle: place.lifecycle,
                    gates: gates.get(place.id) ?? 0,
                    ...(opening.length > 0 ? { opening } : {}),
                    ...(typeof place.title === "string" ? { title: place.title } : {}),
                    ...(typeof place.persona === "string" ? { persona: place.persona } : {}),
                    reply: place.replyId === null || place.replyAt === null || place.replyCompletion === null || place.replyCoordinate === null ? null : {
                        id: place.replyId,
                        coordinate: place.replyCoordinate,
                        completion: place.replyCompletion,
                        at: Date.parse(place.replyAt),
                        ...excerptOf(words.get(place.replyId) ?? "", scope.excerptChars),
                    },
                };
            }),
            workspaces: workspaces.map(({ id, name, projectRoot }) => ({ id, name, projectRoot, projectLabel: scope.projectLabel(projectRoot) })),
            proposals,
            interactions,
            omitted,
        };
    }
}
