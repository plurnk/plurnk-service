import { Results as _Results } from "@plurnk/plurnk-schemes";
import type {
    EntryResult, ProblemDetails, ProposalResult, PassthroughResult, SchemeResult, SchemeResultBase,
} from "@plurnk/plurnk-schemes";

export type { EntryResult, ProblemDetails, ProposalResult, PassthroughResult, SchemeResult, SchemeResultBase };

export default class Results {
    static isEntryResult(r: SchemeResult): r is EntryResult { return _Results.isEntry(r); }
    static isProposalResult(r: SchemeResult): r is ProposalResult { return _Results.isProposal(r); }
    static isPassthroughResult(r: SchemeResult): r is PassthroughResult { return _Results.isPassthrough(r); }

    static isErrorStatus(status: number): boolean { return _Results.isErrorStatus(status); }

    static problem(
        owner: string,
        code: string,
        status: number,
        detail: string,
        extensions: Readonly<Record<string, unknown>> = {},
    ): ProblemDetails {
        return _Results.problem(owner, code, status, detail, extensions);
    }

    static failure(
        owner: string,
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): SchemeResult {
        return _Results.failure(owner, code, status, detail, fields, extensions);
    }

    static assert<T extends SchemeResult>(result: T): T { return _Results.assert(result); }

    static attachInstance<T extends SchemeResult>(result: T, instance: string): T {
        return _Results.attachInstance(result, instance);
    }
}
