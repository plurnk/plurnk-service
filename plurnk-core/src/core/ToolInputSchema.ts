import { Validator, type JsonSchema } from "@plurnk/plurnk-contracts";

const TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);
const objectOf = (value: unknown): JsonSchema =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonSchema : {};

export default class ToolInputSchema {
    // {§executor-input-schema-preview} — a shallow field list, not a schema compiler.
    static preview(schema: JsonSchema): string {
        const properties = objectOf(schema.properties);
        const required = Array.isArray(schema.required) ? schema.required : [];
        const fields = required.map((name: string) => {
            const type = objectOf(properties[name]).type;
            const declared = Array.isArray(type) ? type : [type];
            const broad = declared.filter((value): value is string => typeof value === "string" && TYPES.has(value));
            return `${JSON.stringify(name)}: ${broad.length === 0 ? "unknown" : broad.join(" | ")}`;
        });
        return `{${fields.join(", ")}}`;
    }

    // Include known referenced documents verbatim. Do not inline, rewrite, or fetch schemas.
    static references(schema: JsonSchema): object[] {
        const documents = new Map<string, object>();
        if (typeof schema.$id === "string") documents.set(schema.$id, schema);
        const visit = (value: unknown): void => {
            if (typeof value !== "object" || value === null) return;
            const ref = objectOf(value).$ref;
            if (typeof ref === "string") {
                const id = ref.split("#", 1)[0]!;
                if (!documents.has(id)) {
                    const document = Validator.schemaByRef(id);
                    if (document !== null) {
                        documents.set(id, document);
                        visit(document);
                    }
                }
            }
            for (const child of Object.values(value)) visit(child);
        };
        visit(schema);
        return [...documents.values()].filter((document) => document !== schema);
    }
}
