import RuntimeInvocation from "./RuntimeInvocation.ts";
import RuntimeTag from "./RuntimeTag.ts";
import type { RuntimeDecl } from "./types.ts";

const FIELDS = new Set(["name", "glyph", "invocation", "documentation"]);

export default class RuntimeDeclaration {
    static assert(value: unknown, owner: string): RuntimeDecl {
        const fail = (detail: string): never => {
            throw new Error(`runtime declaration invalid: ${owner} ${detail}`);
        };
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            fail("declaration must be an object");
        }
        const declaration = value as Record<string, unknown>;
        const unknown = Object.keys(declaration).find((key) => !FIELDS.has(key));
        if (unknown !== undefined) fail(`declaration has unknown field '${unknown}'`);

        const name = RuntimeTag.assert(declaration.name, owner);
        const invocation = RuntimeInvocation.assert(declaration.invocation, owner, name);
        if ("glyph" in declaration && typeof declaration.glyph !== "string") {
            fail("glyph must be a string");
        }
        if ("documentation" in declaration && typeof declaration.documentation !== "string") {
            fail("documentation must be a string");
        }

        return {
            name,
            invocation,
            ...(declaration.glyph === undefined ? {} : { glyph: declaration.glyph as string }),
            ...(declaration.documentation === undefined
                ? {}
                : { documentation: declaration.documentation as string }),
        };
    }
}
