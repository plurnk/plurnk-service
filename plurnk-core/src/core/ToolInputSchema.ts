import { Validator, type JsonSchema } from "@plurnk/plurnk-contracts";

const objectOf = (value: unknown): JsonSchema =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonSchema : {};

const defaultValue = (property: JsonSchema): unknown => {
    const choices = property.enum;
    if (Array.isArray(choices) && choices.length > 0) {
        return choices[0];
    }
    const type = property.type;
    const declared = Array.isArray(type) ? type : [type];
    if (declared.includes("string")) return "";
    if (declared.includes("number") || declared.includes("integer")) return 0;
    if (declared.includes("boolean")) return false;
    if (declared.includes("array")) return [];
    if (declared.includes("object")) return {};
    return null;
};

export default class ToolInputSchema {
    // {§executor-input-schema-preview} — a compact valid JSON skeleton of required fields.
    static preview(schema: JsonSchema): string {
        const properties = objectOf(schema.properties);
        const required = Array.isArray(schema.required) ? schema.required : [];
        const entries = required.map((name: string) => {
            const prop = objectOf(properties[name]);
            return `${JSON.stringify(name)}: ${JSON.stringify(defaultValue(prop))}`;
        });
        return `{${entries.join(", ")}}`;
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
