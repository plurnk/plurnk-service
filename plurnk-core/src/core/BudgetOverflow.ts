import {
    Problems,
    Validator,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import type { PlurnkOp } from "@plurnk/plurnk-grammar";

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
                `Token Usage ${formatTokens(measurement.usage)} exceeds Token Ceiling ${formatTokens(measurement.ceiling)} by ${formatTokens(measurement.deficit)}. No working room remains.`,
                {
                    ...measurement,
                    retryable: false,
                    ...(recovery
                        ? {
                            allowedOperations: [...BudgetOverflow.recoveryOperations],
                            recovery: "FOLD or KILL irrelevant log items before continuing work.",
                        }
                        : {}),
                },
                { title: "Prompt budget exceeded" },
            ),
        });
    }
}
