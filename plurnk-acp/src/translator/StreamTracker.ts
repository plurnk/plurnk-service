// {§acp-plurnk-metadata} Bounded stream-correlation, reasoning-turn, configuration-notice, and subagent caches.

export const terminalIdForEntry = (logEntryId: number): string => `term:${logEntryId}`;

export interface ActiveStreamCorrelation {
    readonly entryId: number;
    readonly target: string;
    readonly coordinate: string;
}

export interface ConcludedStreamTombstone {
    readonly entryId: number;
    readonly target: string | null;
    readonly status: number;
}

const addBoundedSetEntry = (set: Set<string>, value: string, max = 256): boolean => {
    if (set.has(value)) return false;
    set.add(value);
    if (set.size > max) {
        const oldest = set.values().next().value;
        if (oldest !== undefined) set.delete(oldest);
    }
    return true;
};

export class StreamCorrelationTracker {
    readonly #maxTombstones: number;
    readonly #streamedReasoningTurns = new Set<string>();
    readonly #activeByEntryId = new Map<number, ActiveStreamCorrelation>();
    readonly #activeByTarget = new Map<string, ActiveStreamCorrelation>();
    readonly #concludedByEntryId = new Map<number, ConcludedStreamTombstone>();
    readonly #concludedByTarget = new Map<string, ConcludedStreamTombstone>();
    readonly #emittedConfigurationNotices = new Set<string>();
    readonly #announcedSubagents = new Set<string>();

    constructor(maxTombstones = 256) {
        this.#maxTombstones =
            Number.isSafeInteger(maxTombstones) && maxTombstones >= 1 ? maxTombstones : 256;
    }

    clear(): void {
        this.#streamedReasoningTurns.clear();
        this.#activeByEntryId.clear();
        this.#activeByTarget.clear();
        this.#concludedByEntryId.clear();
        this.#concludedByTarget.clear();
        this.#emittedConfigurationNotices.clear();
        this.#announcedSubagents.clear();
    }

    resetForReplay(): void {
        this.#streamedReasoningTurns.clear();
        this.#activeByEntryId.clear();
        this.#activeByTarget.clear();
        this.#concludedByEntryId.clear();
        this.#concludedByTarget.clear();
        this.#announcedSubagents.clear();
    }

    hasStreamedReasoning(turnKey: string): boolean {
        return this.#streamedReasoningTurns.has(turnKey);
    }

    rememberReasoningTurn(turnKey: string): void {
        addBoundedSetEntry(this.#streamedReasoningTurns, turnKey);
    }

    clearReasoningTurns(): void {
        this.#streamedReasoningTurns.clear();
    }

    rememberConfigurationNotice(key: string): boolean {
        return addBoundedSetEntry(this.#emittedConfigurationNotices, key);
    }

    rememberSubagent(referencedSessionId: string): boolean {
        return addBoundedSetEntry(this.#announcedSubagents, referencedSessionId);
    }

    rememberActive(entryId: number, target: string, coordinate: string): void {
        const existingByEntry = this.#activeByEntryId.get(entryId);
        if (existingByEntry !== undefined) this.#evictActive(existingByEntry);
        const existingByTarget = this.#activeByTarget.get(target);
        if (existingByTarget !== undefined) this.#evictActive(existingByTarget);
        const record: ActiveStreamCorrelation = { entryId, target, coordinate };
        this.#activeByEntryId.set(entryId, record);
        this.#activeByTarget.set(target, record);
        while (this.#activeByEntryId.size > this.#maxTombstones) {
            const oldest = this.#activeByEntryId.values().next().value;
            if (oldest === undefined) break;
            this.#evictActive(oldest);
        }
    }

    consumeActive(entryId: number, target: string | null): ActiveStreamCorrelation | undefined {
        const matched =
            this.#activeByEntryId.get(entryId) ??
            (target !== null ? this.#activeByTarget.get(target) : undefined);
        if (matched !== undefined) this.#evictActive(matched);
        return matched;
    }

    rememberConcluded(entryId: number, target: string | null, status: number): void {
        const existingByEntry = this.#concludedByEntryId.get(entryId);
        if (existingByEntry !== undefined) this.#evictConcluded(existingByEntry);
        if (target !== null) {
            const existingByTarget = this.#concludedByTarget.get(target);
            if (existingByTarget !== undefined) this.#evictConcluded(existingByTarget);
        }
        const record: ConcludedStreamTombstone = { entryId, target, status };
        this.#concludedByEntryId.set(entryId, record);
        if (target !== null) this.#concludedByTarget.set(target, record);
        while (this.#concludedByEntryId.size > this.#maxTombstones) {
            const oldest = this.#concludedByEntryId.values().next().value;
            if (oldest === undefined) break;
            this.#evictConcluded(oldest);
        }
    }

    consumeConcluded(entryId: number, target: string | null): ConcludedStreamTombstone | undefined {
        const matched =
            (target !== null ? this.#concludedByTarget.get(target) : undefined) ??
            this.#concludedByEntryId.get(entryId);
        if (matched !== undefined) this.#evictConcluded(matched);
        return matched;
    }

    #evictActive(record: ActiveStreamCorrelation): void {
        if (this.#activeByEntryId.get(record.entryId) === record) {
            this.#activeByEntryId.delete(record.entryId);
        }
        if (this.#activeByTarget.get(record.target) === record) {
            this.#activeByTarget.delete(record.target);
        }
    }

    #evictConcluded(record: ConcludedStreamTombstone): void {
        if (this.#concludedByEntryId.get(record.entryId) === record) {
            this.#concludedByEntryId.delete(record.entryId);
        }
        if (record.target !== null && this.#concludedByTarget.get(record.target) === record) {
            this.#concludedByTarget.delete(record.target);
        }
    }
}
