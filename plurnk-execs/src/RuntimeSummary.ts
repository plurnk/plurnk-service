import { isRecord } from "@plurnk/plurnk-contracts";
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
        if (isRecord(value)) {
            const record = value;
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
