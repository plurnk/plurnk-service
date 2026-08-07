import {
    Problems,
    Validator,
    type OperationResult,
} from "@plurnk/plurnk-contracts";

export interface BudgetOverflowMeasurement {
    readonly usage: number;
    readonly ceiling: number;
    readonly deficit: number;
}

export interface BudgetOverflowPhysicalFailure {
    readonly reason: string;
    readonly detail: string;
    readonly capacity: number | null;
    readonly tokens?: number;
    readonly tokenKind?: string;
    readonly tokenSource?: string;
}

const formatTokens = (tokens: number): string => tokens.toLocaleString("en-US");

export default class BudgetOverflow {
    static measure(usage: number, ceiling: number): BudgetOverflowMeasurement {
        return {
            usage,
            ceiling,
            deficit: Math.max(0, usage - ceiling),
        };
    }

    static result(
        usage: number,
        ceiling: number,
        recovery: boolean,
        physical?: BudgetOverflowPhysicalFailure,
    ): OperationResult {
        const measurement = BudgetOverflow.measure(usage, ceiling);
        const physicalDetail = physical === undefined
            ? ""
            : ` Physical recovery was not admitted: ${physical.detail}.`;
        return Validator.assertOperationResult({
            status: 413,
            problem: Problems.create(
                "engine:grinder",
                "budget-overflow",
                413,
                `At overflow detection, Token Usage ${formatTokens(measurement.usage)} exceeds Token Ceiling ${formatTokens(measurement.ceiling)} by ${formatTokens(measurement.deficit)}. No working room remains.${physicalDetail}`,
                {
                    ...measurement,
                    stage: "overflow-detection",
                    retryable: false,
                    ...(physical === undefined ? {} : {
                        physicalAdmission: physical.reason,
                        physicalCapacity: physical.capacity,
                        ...(physical.tokens === undefined ? {} : { physicalTokens: physical.tokens }),
                        ...(physical.tokenKind === undefined ? {} : { physicalTokenKind: physical.tokenKind }),
                        ...(physical.tokenSource === undefined ? {} : { physicalTokenSource: physical.tokenSource }),
                    }),
                    ...(recovery ? {
                        recovery: "Restore working room before the next turn: FOLD or KILL irrelevant log items, use smaller retrieval ranges, or conclude if the work is complete.",
                    } : {}),
                },
                { title: "Prompt budget exceeded" },
            ),
        });
    }

    static foldedResult(
        usage: number,
        ceiling: number,
    ): OperationResult {
        const measurement = BudgetOverflow.measure(usage, ceiling);
        return Validator.assertOperationResult({
            status: 413,
            problem: Problems.create(
                "engine:grinder",
                "budget-overflow",
                413,
                `At overflow detection, Token Usage ${formatTokens(measurement.usage)} exceeded Token Ceiling ${formatTokens(measurement.ceiling)} by ${formatTokens(measurement.deficit)}. The newest open log items were FOLDed, and the rebuilt packet now fits.`,
                {
                    ...measurement,
                    stage: "overflow-detection",
                    resolution: "newest-log-items-folded",
                    recovery: "Keep irrelevant log items FOLDed or KILL them, and use smaller retrieval ranges.",
                    retryable: false,
                },
                { title: "Prompt budget exceeded" },
            ),
        });
    }
}
