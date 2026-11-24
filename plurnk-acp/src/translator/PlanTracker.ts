// {§acp-plurnk-metadata} Loop-scoped `plan_update` / `plan_removed` state tracker for operation asides.

import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isSafeInteger } from "@plurnk/plurnk-contracts";

export interface TrackedSessionUpdate {
    readonly sessionId: string;
    readonly update: SessionUpdate;
}

export class PlanTracker {
    readonly #acpSessionId: string;
    readonly #entries = new Map<
        string,
        {
            readonly content: string;
            readonly status: "in_progress" | "completed" | "cancelled";
            readonly turnSeq: number;
        }
    >();
    #loopSeq: number | null = null;
    #turnSeq: number | null = null;

    constructor(acpSessionId: string) {
        this.#acpSessionId = acpSessionId;
    }

    clear(): void {
        this.#entries.clear();
        this.#loopSeq = null;
        this.#turnSeq = null;
    }

    advanceTurn(entry: {
        readonly sessionId: number;
        readonly loopId: number;
        readonly loopSeq: number;
        readonly turnId: number;
        readonly turnSeq: number;
    }): TrackedSessionUpdate | null {
        if (isSafeInteger(entry.loopSeq) && this.#loopSeq !== entry.loopSeq) {
            this.#loopSeq = entry.loopSeq;
            this.#turnSeq = isSafeInteger(entry.turnSeq) ? entry.turnSeq : null;
            this.#entries.clear();
            return null;
        }
        if (!isSafeInteger(entry.turnSeq)) return null;
        if (this.#turnSeq !== null && entry.turnSeq > this.#turnSeq) {
            const pruned = this.#pruneInProgress(entry.turnSeq, {
                sessionId: entry.sessionId,
                loopId: entry.loopId,
                loopSeq: entry.loopSeq,
                turnId: entry.turnId,
                turnSeq: entry.turnSeq,
            });
            this.#turnSeq = entry.turnSeq;
            return pruned;
        }
        if (this.#turnSeq === null) {
            this.#turnSeq = entry.turnSeq;
        }
        return null;
    }

    settleEntry(
        coordinate: string,
        nextStatus: "in_progress" | "completed" | "cancelled",
        meta?: Record<string, unknown>,
    ): TrackedSessionUpdate | null {
        const existing = this.#entries.get(coordinate);
        if (existing === undefined || existing.status === nextStatus) return null;
        this.#entries.set(coordinate, { ...existing, status: nextStatus });
        return {
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "plan_update",
                plan: { type: "items", planId: "plan", entries: this.#buildEntries() },
                ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
            },
        };
    }

    recordAside(
        coordinate: string,
        trimmedAside: string,
        status: "in_progress" | "completed" | "cancelled",
        turnSeq: number,
        meta: Record<string, unknown>,
    ): TrackedSessionUpdate {
        this.#entries.set(coordinate, {
            content: trimmedAside,
            status,
            turnSeq: isSafeInteger(turnSeq) ? turnSeq : 0,
        });
        return {
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "plan_update",
                plan: { type: "items", planId: "plan", entries: this.#buildEntries() },
                _meta: { plurnk: meta },
            },
        };
    }

    pruneForLoop(loopSeq: number, meta: Record<string, unknown>): TrackedSessionUpdate | null {
        if (this.#loopSeq !== null && this.#loopSeq !== loopSeq) return null;
        return this.#pruneInProgress(undefined, meta);
    }

    #buildEntries(): PlanEntry[] {
        return [...this.#entries.values()].map(({ content, status }) => ({
            content,
            priority: "medium",
            status,
        }));
    }

    #pruneInProgress(beforeTurnSeq?: number, meta?: Record<string, unknown>): TrackedSessionUpdate | null {
        let removed = false;
        for (const [coord, item] of [...this.#entries.entries()]) {
            if (item.status === "in_progress" && (beforeTurnSeq === undefined || item.turnSeq < beforeTurnSeq)) {
                this.#entries.delete(coord);
                removed = true;
            }
        }
        if (!removed) return null;
        if (this.#entries.size === 0) {
            return {
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "plan_removed",
                    planId: "plan",
                    ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
                },
            };
        }
        return {
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "plan_update",
                plan: { type: "items", planId: "plan", entries: this.#buildEntries() },
                ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
            },
        };
    }
}
