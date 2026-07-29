export const ERROR_DETAIL_LIMIT = "PLURNK_SERVICE_ERROR_DETAIL_LIMIT";

export default class ErrorDetail {
    static configuredLimit(): number {
        const raw = process.env[ERROR_DETAIL_LIMIT];
        if (raw === undefined || raw === "") {
            throw new Error(`${ERROR_DETAIL_LIMIT} must be set.`);
        }
        const limit = Number(raw);
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new Error(`${ERROR_DETAIL_LIMIT} must be a non-negative integer.`);
        }
        return limit;
    }

    static preview(value: unknown): string {
        const text = value instanceof Error ? value.message : String(value);
        const limit = ErrorDetail.configuredLimit();
        return text.length > limit ? `${text.slice(0, limit)}...` : text;
    }
}
