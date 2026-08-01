import {
    Problems,
    Validator,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import type { PlurnkOp } from "@plurnk/plurnk-contracts";

export interface BudgetOverflowMeasurement {
    readonly usage: number;
    readonly ceiling: number;
    readonly deficit: number;
}

const formatTokens = (tokens: number): string => tokens.toLocaleString("en-US");

export default class BudgetOverflow {
    static readonly recoveryOperations = Object.freeze([
        "PLAN",
        "FOLD",
        "KILL",
        "SEND",
    ] as const satisfies readonly PlurnkOp[]);

    static permits(operation: PlurnkOp): boolean {
        return BudgetOverflow.recoveryOperations.some((allowed) => allowed === operation);
    }

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
    ): OperationResult {
        const measurement = BudgetOverflow.measure(usage, ceiling);
        return Validator.assertOperationResult({
            status: 413,
            problem: Problems.create(
                "engine:grinder",
                "budget-overflow",
                413,
                `At overflow detection, Token Usage ${formatTokens(measurement.usage)} exceeds Token Ceiling ${formatTokens(measurement.ceiling)} by ${formatTokens(measurement.deficit)}. No working room remains.`,
                {
                    ...measurement,
                    stage: "overflow-detection",
                    retryable: false,
                    ...(recovery
                        ? {
                            allowedOperations: [...BudgetOverflow.recoveryOperations],
                            recovery: "Curate context by FOLDing or KILLing irrelevant log items to restore working room.",
                        }
                        : {}),
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
