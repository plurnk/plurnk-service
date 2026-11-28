// {§mcp-http-server} — Route-scoped MCP ServerEventBus, request context, and workspace mutation URI extraction.

import type { AsyncLocalStorage } from "node:async_hooks";
import type { ServerEvent, ServerEventBus } from "@modelcontextprotocol/server";
import { isRecord } from "@plurnk/plurnk-contracts";

export interface McpRouteTarget {
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly runtimeSessionId: number;
    readonly isModelSession: boolean;
}

export interface McpCallerClaims {
    readonly subject: string | null;
    readonly handle?: string;
    readonly name?: string;
    readonly canDelegateActor?: boolean;
}

export interface McpRequestContext extends McpCallerClaims {
    readonly target: McpRouteTarget;
}

export interface PublishScope {
    readonly workspaceId: number;
    readonly sessionId?: number | null;
    readonly allowRuntimeSession?: boolean;
}

export const MCP_SERVER_SUBSCRIBED_EVENTS = Object.freeze([
    "functionality/changed",
    "session/created",
    "session/archived",
    "session/deleted",
    "session/titled",
    "session/policy",
    "loop/started",
    "loop/parked",
    "loop/proposal",
    "loop/interaction",
    "loop/gate-settled",
    "loop/terminated",
    "stream/concluded",
] as const);

export const logCoordinateOf = (row: Readonly<Record<string, unknown>> | undefined): string | null => {
    if (
        row === undefined ||
        typeof row.loopSeq !== "number" ||
        typeof row.turnSeq !== "number" ||
        typeof row.sequence !== "number" ||
        typeof row.op !== "string" ||
        row.op.length === 0
    ) {
        return null;
    }
    return `log:///${row.loopSeq}/${row.turnSeq}/${row.sequence}/${row.op.toLowerCase()}`;
};

const MUTATING_WORKSPACE_OPS: ReadonlySet<string> = new Set(["edit", "copy", "move", "kill"]);

const toWorkspaceResourceUri = (scheme: unknown, rawCandidate: string): string | null => {
    const base = rawCandidate.split(/[?#]/u, 1)[0] ?? "";
    if (base.length === 0) return null;
    if (base.startsWith("workspace:///")) {
        const rel = base.slice("workspace:///".length).replace(/^\/+/u, "");
        return rel.length > 0 ? `workspace:///${rel}` : null;
    }
    if (base.includes("://")) return null;
    if (scheme === "workspace" || scheme === null || scheme === undefined) {
        const rel = base.replace(/^\/+/u, "");
        return rel.length > 0 ? `workspace:///${rel}` : null;
    }
    return null;
};

export const workspaceMutationUrisOf = (entry: Readonly<Record<string, unknown>>): readonly string[] => {
    const statusRx = typeof entry.statusRx === "number" ? entry.statusRx : 200;
    if (statusRx >= 400) return [];
    if (entry.state === "proposed" || entry.state === "failed" || entry.state === "cancelled") {
        return [];
    }
    const rawOp = typeof entry.op === "string" ? entry.op.toLowerCase() : null;
    const isMaterializedWorkspace =
        rawOp === null &&
        entry.scheme === "workspace" &&
        isRecord(entry.attrs) &&
        entry.attrs.kind === "entry_materialized";
    if (!isMaterializedWorkspace && (rawOp === null || !MUTATING_WORKSPACE_OPS.has(rawOp))) {
        return [];
    }

    const uris = new Set<string>();
    const addCandidate = (scheme: unknown, candidate: unknown): void => {
        if (typeof candidate !== "string" || candidate.length === 0) return;
        const resolved = toWorkspaceResourceUri(scheme, candidate);
        if (resolved !== null) uris.add(resolved);
    };

    if (typeof entry.pathname === "string" && entry.pathname.length > 0) {
        addCandidate(entry.scheme, entry.pathname);
    }
    if (typeof entry.tx === "string") {
        addCandidate(entry.scheme, entry.tx);
    } else if (isRecord(entry.tx)) {
        if (isRecord(entry.tx.target) && typeof entry.tx.target.raw === "string") {
            addCandidate(entry.scheme, entry.tx.target.raw);
        } else if (typeof entry.tx.path === "string") {
            addCandidate(entry.scheme, entry.tx.path);
        }
        if (isRecord(entry.tx.destination) && typeof entry.tx.destination.raw === "string") {
            addCandidate(undefined, entry.tx.destination.raw);
        }
    }
    return [...uris];
};

interface ScopedSubscription {
    readonly target: McpRouteTarget;
    readonly listener: (event: ServerEvent) => void;
}

export class RouteScopedEventBus implements ServerEventBus {
    readonly #requestContext: AsyncLocalStorage<McpRequestContext>;
    readonly #subscriptions = new Set<ScopedSubscription>();

    constructor(requestContext: AsyncLocalStorage<McpRequestContext>) {
        this.#requestContext = requestContext;
    }

    publish(event: ServerEvent): void {
        const target = this.#requestContext.getStore()?.target;
        if (target !== undefined) {
            this.publishScoped(event, { workspaceId: target.workspaceId, sessionId: target.sessionId });
            return;
        }
        for (const sub of this.#subscriptions) {
            try {
                sub.listener(event);
            } catch {
                // Isolate listener failures so peer streams continue receiving notifications.
            }
        }
    }

    publishScoped(event: ServerEvent, scope: PublishScope): void {
        for (const sub of this.#subscriptions) {
            if (sub.target.workspaceId !== scope.workspaceId) continue;
            if (scope.sessionId !== undefined && scope.sessionId !== null) {
                const matchesSession = sub.target.sessionId === scope.sessionId;
                const matchesRuntime =
                    scope.allowRuntimeSession === true && sub.target.runtimeSessionId === scope.sessionId;
                if (!matchesSession && !matchesRuntime) continue;
            }
            try {
                sub.listener(event);
            } catch {
                // Isolate listener failures so peer streams continue receiving notifications.
            }
        }
    }

    subscribe(listener: (event: ServerEvent) => void): () => void {
        const target = this.#requestContext.getStore()?.target;
        if (target === undefined) {
            return () => undefined;
        }
        const entry: ScopedSubscription = { target, listener };
        this.#subscriptions.add(entry);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.#subscriptions.delete(entry);
        };
    }

    clear(): void {
        this.#subscriptions.clear();
    }
}
