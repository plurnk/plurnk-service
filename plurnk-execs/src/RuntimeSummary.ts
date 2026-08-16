export default class RuntimeSummary {
    static assert(
        value: unknown,
        field: string,
        fail: (detail: string) => never,
    ): string {
        if (typeof value !== "string" || value.trim() === "" || /[\r\n]/u.test(value)) {
            fail(`${field} must be one non-empty line`);
        }
        return value.trim();
    }
}
