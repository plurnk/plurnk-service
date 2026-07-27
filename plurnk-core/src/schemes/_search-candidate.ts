// An address attached to one immutable readable-content derivation. Search
// primitives consume this pair and never depend on the table that owns the
// address (entries, log_entries, or a future scheme-owned resource store).
export interface SearchCandidate {
    readonly key: string;
    readonly deepHash: string;
}

export interface SearchAttachment {
    readonly key: string;
    readonly deepHash: string | null;
}

export type SearchCandidateSet =
    | {
        readonly state: "ready";
        readonly candidates: readonly SearchCandidate[];
        readonly indexed: number;
        readonly total: number;
    }
    | {
        readonly state: "incomplete";
        readonly indexed: number;
        readonly total: number;
    };

export const resolveSearchCandidates = (
    attachments: readonly SearchAttachment[],
): SearchCandidateSet => {
    const candidates = attachments.flatMap(({ key, deepHash }) => deepHash === null
        ? []
        : [{ key, deepHash }]);
    if (candidates.length !== attachments.length) {
        return {
            state: "incomplete",
            indexed: candidates.length,
            total: attachments.length,
        };
    }
    return {
        state: "ready",
        candidates,
        indexed: candidates.length,
        total: attachments.length,
    };
};
