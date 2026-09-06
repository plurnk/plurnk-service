import type { RuntimeSummaryDecl } from "./types.ts";

export default class RuntimeSummary {
    static assertLine(
        value: unknown,
        field: string,
        fail: (detail: string) => never,
    ): string {
        if (typeof value !== "string" || value.trim() === "" || /[\r\n]/u.test(value)) {
            fail(`${field} must be one non-empty line`);
        }
        return value.trim();
    }

    static assert(
        value: unknown,
        field: string,
        fail: (detail: string) => never,
    ): RuntimeSummaryDecl {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const record = value as Record<string, unknown>;
            if (record.from === "tools" && Object.keys(record).every((key) => key === "from" || key === "description")) {
                return {
                    from: "tools",
                    ...(record.description === undefined ? {} : {
                        description: RuntimeSummary.assertLine(record.description, `${field}.description`, fail),
                    }),
                };
            }
            fail(`${field} must be one non-empty line or { from: "tools" }`);
        }
        if (typeof value !== "string") {
            fail(`${field} must be one non-empty line or { from: "tools" }`);
        }
        return RuntimeSummary.assertLine(value, field, (detail) => {
            fail(`${detail} or { from: "tools" }`);
        });
    }
}
