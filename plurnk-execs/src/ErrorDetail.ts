import { Results } from "@plurnk/plurnk-schemes";
import type { ExecResult } from "./types.ts";

export const ERROR_DETAIL_LIMIT = "PLURNK_EXECS_ERROR_DETAIL_LIMIT";

export default class ErrorDetail {
    static configuredLimit(): number | null {
        const raw = process.env[ERROR_DETAIL_LIMIT];
        if (raw === undefined || raw === "") return null;
        const limit = Number(raw);
        return Number.isSafeInteger(limit) && limit >= 0 ? limit : null;
    }

    static preview(value: unknown, limit: number): string {
        const text = value instanceof Error ? value.message : String(value);
        return text.length > limit
            ? `${text.slice(0, limit)}...`
            : text;
    }

    static invalidConfiguration(owner: string): ExecResult {
        return Results.failure(
            owner,
            "invalid-configuration",
            500,
            `${ERROR_DETAIL_LIMIT} must be set to a non-negative integer.`,
            {},
            {
                configuration: ERROR_DETAIL_LIMIT,
                stage: "configuration",
                retryable: false,
            },
        );
    }
}
