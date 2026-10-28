import SearchIndex from "../schemes/_search-index.ts";
import GitMembership from "./git-membership.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";

export type WorkspaceDerivationStatus = {
    phase: "preparing" | "indexing" | "complete" | "failed";
    completed: number;
    total: number;
    percent: number;
    message: string;
    level: "info" | "warn" | "error";
};

// One coalesced warm per workspace. Explicit membership changes may start it as soon
// as content exists; the first model turn always joins it, so no operation observes
// partial graph/FTS coverage. A request arriving mid-pass marks the workspace
// dirty and guarantees one final exhaustive rescan.
export default class WorkspaceDerivations {
    readonly #workspaceWarms = new Map<number, {
        dirty: boolean;
        materialize: boolean;
        ctx: PlurnkSchemeContext;
        abort: AbortController;
        promise: Promise<void>;
    }>();
    readonly #workspaceWarmStatus = new Map<number, WorkspaceDerivationStatus>();

    queue(ctx: PlurnkSchemeContext, invalidate = true, materialize = true): Promise<void> {
        const workspaceId = ctx.workspaceId;
        const existing = this.#workspaceWarms.get(workspaceId);
        if (existing !== undefined) {
            if (invalidate) existing.dirty = true;
            if (materialize) existing.materialize = true;
            existing.ctx = ctx;
            return existing.promise;
        }
        if (!invalidate && this.#workspaceWarmStatus.get(workspaceId)?.phase === "complete") {
            return Promise.resolve();
        }

        const state = {
            dirty: false,
            materialize,
            ctx,
            abort: new AbortController(),
            promise: Promise.resolve(),
        };
        // Register before publishing the first synchronous Notice. A
        // listener may request another warm from that callback; it must join
        // this state rather than opening a second pump in the re-entrant gap.
        this.#workspaceWarms.set(workspaceId, state);
        const publish = (current: PlurnkSchemeContext, status: WorkspaceDerivationStatus): void => {
            this.#workspaceWarmStatus.set(workspaceId, status);
            current.pushNotice?.({
                source: "engine:derivation", kind: "search_progress", ...status,
            });
        };
        const promise = (async () => {
            do {
                state.dirty = false;
                const shouldMaterialize = state.materialize;
                state.materialize = false;
                const current = state.ctx;
                let terminalPublished = false;
                try {
                    const signal = current.signal === undefined
                        ? state.abort.signal
                        : AbortSignal.any([current.signal, state.abort.signal]);
                    const cancellable = { ...current, signal };
                    if (shouldMaterialize) await GitMembership.indexGitMembership(cancellable);
                    await SearchIndex.maintain({
                        ...cancellable,
                        pushNotice: (notice) => {
                            if (notice.kind === "search_progress"
                                && (notice.phase === "preparing"
                                    || notice.phase === "indexing"
                                    || notice.phase === "complete"
                                    || notice.phase === "failed")
                                && typeof notice.completed === "number"
                                && typeof notice.total === "number"
                                && typeof notice.percent === "number") {
                                this.#workspaceWarmStatus.set(workspaceId, {
                                    phase: notice.phase,
                                    completed: notice.completed,
                                    total: notice.total,
                                    percent: notice.percent,
                                    message: notice.message ?? "Indexing repository search",
                                    level: notice.level,
                                });
                                terminalPublished = notice.phase === "complete" || notice.phase === "failed";
                            }
                            current.pushNotice?.(notice);
                        },
                    });
                } catch (error) {
                    if (!terminalPublished) {
                        publish(current, {
                            phase: "failed",
                            message: `Search indexing failed: ${error instanceof Error ? error.message : String(error)}`,
                            completed: 0, total: 1, percent: 0, level: "error",
                        });
                    }
                    throw error;
                }
            } while (state.dirty);
        })().finally(() => {
            if (this.#workspaceWarms.get(workspaceId) === state) this.#workspaceWarms.delete(workspaceId);
        });
        state.promise = promise;
        return promise;
    }

    status(workspaceId: number): WorkspaceDerivationStatus | null {
        return this.#workspaceWarmStatus.get(workspaceId) ?? null;
    }

    evict(workspaceId: number): void {
        if (!this.#workspaceWarms.has(workspaceId)) {
            this.#workspaceWarmStatus.delete(workspaceId);
        }
    }

    cancel(reason: unknown = new DOMException("derivations cancelled", "AbortError")): void {
        for (const state of this.#workspaceWarms.values()) {
            if (!state.abort.signal.aborted) state.abort.abort(reason);
        }
    }

    // Awaited by Daemon.stop before the db closes. Shutdown supplies the exact
    // cancellation reason it owns; every unrelated failure remains visible.
    async drain(ignoredReason?: unknown): Promise<void> {
        const results = await Promise.allSettled(
            [...this.#workspaceWarms.values()].map((state) => state.promise),
        );
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason])
            .filter((error) => error !== ignoredReason);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "derivation drain failed");
    }

    async drainWorkspace(workspaceId: number): Promise<void> {
        await this.#workspaceWarms.get(workspaceId)?.promise;
    }
}
