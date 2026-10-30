import RuntimeInvocation, { RuntimeSummary } from "./RuntimeInvocation.ts";
import RuntimeTag from "./RuntimeTag.ts";
import { isRecord } from "@plurnk/plurnk-contracts";
import type { RuntimeDecl } from "./types.ts";

const FIELDS = new Set(["name", "glyph", "summary", "invocation", "details", "resourcesPath"]);

export default class RuntimeDeclaration {
    static assert(value: unknown, owner: string): RuntimeDecl {
        const fail: (detail: string) => never = (detail) => {
            throw new Error(`runtime declaration invalid: ${owner} ${detail}`);
        };
        if (!isRecord(value)) fail("declaration must be an object");
        const declaration = value;
        // An optional field is read when the declaration carries it and admitted by its own check.
        const optional = <T>(key: string, admits: (field: unknown) => field is T, detail: string): T | undefined => {
            if (!(key in declaration)) return undefined;
            const field = declaration[key];
            if (!admits(field)) fail(detail);
            return field;
        };
        const unknown = Object.keys(declaration).find((key) => !FIELDS.has(key));
        if (unknown !== undefined) fail(`declaration has unknown field '${unknown}'`);

        const name = RuntimeTag.assert(declaration.name, owner);
        const summary = RuntimeSummary.assert(declaration.summary, "summary", fail);
        const invocation = RuntimeInvocation.assert(declaration.invocation, owner, name);
        const glyph = optional("glyph", (field): field is string => typeof field === "string", "glyph must be a string");
        const details = optional("details", (field): field is string => typeof field === "string", "details must be a string");
        const resourcesPath = optional(
            "resourcesPath",
            (field): field is string => typeof field === "string" && field.length > 0 && field.startsWith("/"),
            "resourcesPath must be a non-empty absolute pathname like /tools",
        );

        return {
            name,
            summary,
            invocation,
            ...(glyph === undefined ? {} : { glyph }),
            ...(details === undefined ? {} : { details }),
            ...(resourcesPath === undefined ? {} : { resourcesPath }),
        };
    }
}
