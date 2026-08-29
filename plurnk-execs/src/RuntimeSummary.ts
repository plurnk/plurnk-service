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
            if (Object.keys(record).length === 1 && record.from === "tools") {
                return { from: "tools" };
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

    static resolve(
        summary: RuntimeSummaryDecl,
        tools: readonly { readonly target: string }[] | null,
    ): string {
        if (typeof summary === "string") return summary;
        if (tools === null) {
            throw new Error("runtime summary derives from tools but the runtime has no exact tool registry");
        }
        if (tools.length === 0) {
            throw new Error("runtime summary derives from tools but the effective tool registry is empty");
        }
        return `Tools: ${tools.map(({ target }) => target).join(", ")}.`;
    }
}
