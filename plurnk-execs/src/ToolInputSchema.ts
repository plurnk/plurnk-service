import { PlurnkParser } from "@plurnk/plurnk-parser";
import { PathSyntax, Validator, isRecord, type JsonSchema } from "@plurnk/plurnk-contracts";
import type { RuntimeInvocation as RuntimeInvocationDecl } from "./types.ts";

const objectOf = (value: unknown): JsonSchema => isRecord(value) ? value : {};

const defaultValue = (property: JsonSchema): unknown => {
    if (typeof property.const === "string") return property.const;
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

const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];

const isStringEnum = (choices: unknown): choices is readonly string[] =>
    Array.isArray(choices) && choices.length > 0 && choices.length <= 12
    && choices.every((choice): choice is string => typeof choice === "string");

const resolveLocalDef = (root: JsonSchema, fragment: string): JsonSchema | undefined => {
    if (!fragment.startsWith("/$defs/")) return undefined;
    const key = fragment.slice("/$defs/".length);
    const defs = isRecord(root.$defs) ? root.$defs : undefined;
    const candidate = defs?.[key];
    return isRecord(candidate) ? candidate : undefined;
};

const dereference = (prop: JsonSchema, root?: JsonSchema): JsonSchema => {
    if (typeof prop.$ref === "string") {
        const [baseUri, fragment] = prop.$ref.split("#", 2);
        const targetRoot = baseUri.length > 0 ? Validator.schemaByRef(baseUri) : root;
        if (isRecord(targetRoot)) {
            if (fragment !== undefined && fragment.length > 0) {
                const resolved = resolveLocalDef(targetRoot, fragment);
                if (resolved !== undefined) {
                    return isRecord(targetRoot.$defs) ? { ...resolved, $defs: targetRoot.$defs } : resolved;
                }
            } else {
                return targetRoot;
            }
        }
    }
    return root !== undefined && prop.$defs === undefined && isRecord(root.$defs)
        ? { ...prop, $defs: root.$defs }
        : prop;
};

const structuredUnionBranches = (prop: JsonSchema): JsonSchema[] => {
    const rawBranches = Array.isArray(prop.oneOf) ? prop.oneOf : Array.isArray(prop.anyOf) ? prop.anyOf : [];
    if (rawBranches.length === 0 || rawBranches.length > 4) return [];
    const resolved = rawBranches.map((branch) => dereference(objectOf(branch), prop));
    return resolved.every((branch) => isRecord(branch.properties) && Object.keys(branch.properties).length > 0)
        ? resolved
        : [];
};

const hasStructuredDetail = (raw: JsonSchema): boolean => {
    const prop = dereference(raw);
    if (isRecord(prop.properties) && Object.keys(prop.properties).length > 0) return true;
    if (structuredUnionBranches(prop).length > 0) return true;
    const items = dereference(objectOf(prop.items), prop);
    return (isRecord(items.properties) && Object.keys(items.properties).length > 0)
        || (isStringEnum(items.enum) && items.enum.length > 1);
};

const propertySignature = (raw: JsonSchema, depth = 0, root?: JsonSchema): string => {
    const prop = dereference(raw, root);
    if (isStringEnum(prop.enum)) {
        return prop.enum.map((choice) => JSON.stringify(choice)).join("|");
    }
    if (typeof prop.const === "string") {
        return JSON.stringify(prop.const);
    }
    const type = prop.type;
    const declared = (Array.isArray(type) ? type : [type]).filter((entry): entry is string => typeof entry === "string");
    if (declared.includes("array") || isRecord(prop.items)) {
        const items = objectOf(prop.items);
        if (Object.keys(items).length > 0) {
            const itemSig = propertySignature(items, depth, prop);
            const wrap = itemSig.includes("|") && !itemSig.startsWith("{");
            return `${wrap ? `(${itemSig})` : itemSig}[]`;
        }
        return "array";
    }
    const nestedProps = isRecord(prop.properties) ? prop.properties : undefined;
    if (depth === 0 && nestedProps !== undefined && Object.keys(nestedProps).length > 0) {
        const nestedReq = ToolInputSchema.requiredFields(prop).filter((key) => Object.hasOwn(nestedProps, key));
        const nestedReqSet = new Set(nestedReq);
        const optionalKeys = Object.keys(nestedProps).filter((key) => !nestedReqSet.has(key));
        const ordered = [...nestedReq, ...optionalKeys];
        const parts = ordered.slice(0, 6).map((key) =>
            `${key}${nestedReqSet.has(key) ? "" : "?"}: ${propertySignature(objectOf(nestedProps[key]), 1, prop)}`);
        if (ordered.length > 6) parts.push(`… +${ordered.length - 6} opt`);
        return `{${parts.join(", ")}}`;
    }
    if (depth === 0) {
        const branches = structuredUnionBranches(prop);
        if (branches.length > 0) {
            return branches.map((branch) => propertySignature(branch, 0, prop)).join("|");
        }
    }
    if (declared.length > 0) return declared.join("|");
    const union = Array.isArray(prop.oneOf)
        ? prop.oneOf
        : Array.isArray(prop.anyOf)
            ? prop.anyOf
            : null;
    if (union !== null) {
        const leafTypes = union.map((branch) => propertySignature(objectOf(branch), 1, prop));
        if (leafTypes.length > 0 && leafTypes.length <= 4 && leafTypes.every((t) => t !== "any" && t !== "object")) {
            return [...new Set(leafTypes)].join("|");
        }
        return "object";
    }
    return "any";
};

export default class ToolInputSchema {
    // {§executor-discovery} — the top-level required fields, with the first `anyOf` or `oneOf`
    // branch's when the schema requires one of several alternatives.
    static requiredFields(schema: JsonSchema): string[] {
        const resolved = dereference(schema);
        const branches = Array.isArray(resolved.anyOf) ? resolved.anyOf : Array.isArray(resolved.oneOf) ? resolved.oneOf : [];
        const firstBranch = branches.length > 0 ? dereference(objectOf(branches[0]), resolved) : {};
        return [...new Set([...names(resolved.required), ...names(firstBranch.required)])];
    }

    // {§executor-discovery} — a compact valid JSON skeleton of required fields.
    static preview(schema: JsonSchema): string {
        const resolved = dereference(schema);
        const branches = Array.isArray(resolved.anyOf) ? resolved.anyOf : Array.isArray(resolved.oneOf) ? resolved.oneOf : [];
        const firstBranch = branches.length > 0 ? dereference(objectOf(branches[0]), resolved) : {};
        const properties = isRecord(resolved.properties) ? resolved.properties : objectOf(firstBranch.properties);
        const entries = ToolInputSchema.requiredFields(resolved).map((name) => {
            const prop = dereference(objectOf(properties[name]), resolved);
            return `${JSON.stringify(name)}: ${JSON.stringify(defaultValue(prop))}`;
        });
        return `{${entries.join(", ")}}`;
    }

    // {§executor-discovery} — compact aside signature for required multi-value enums,
    // required one-level structured objects/arrays, and optional top-level properties (#1228).
    static asideNote(schema?: JsonSchema): string | undefined {
        if (!isRecord(schema)) return undefined;
        const resolved = dereference(schema);
        if (!isRecord(resolved.properties)) {
            const branches = structuredUnionBranches(resolved);
            if (branches.length === 0) return undefined;
            const unionNote = `(${branches.map((branch) => propertySignature(branch, 0, resolved)).join("|")})`;
            return unionNote.replaceAll(/\s+/gu, " ").trim().replaceAll("--", "—");
        }
        const properties = resolved.properties;
        const required = ToolInputSchema.requiredFields(resolved);
        const requiredSet = new Set(required);
        const requiredNotes: string[] = [];
        for (const name of required) {
            const prop = objectOf(properties[name]);
            if ((isStringEnum(prop.enum) && prop.enum.length > 1) || hasStructuredDetail(prop)) {
                requiredNotes.push(`${name}: ${propertySignature(prop, 0)}`);
            }
        }
        const optionalKeys = Object.keys(properties).filter((key) => !requiredSet.has(key));
        const optionalNotes = optionalKeys.slice(0, 12).map((name) =>
            `${name}?: ${propertySignature(objectOf(properties[name]), 0)}`);
        if (optionalKeys.length > 12) optionalNotes.push(`… +${optionalKeys.length - 12} opt`);
        if (requiredNotes.length === 0 && optionalNotes.length === 0) return undefined;
        const combined = requiredNotes.length > 0 && optionalNotes.length > 0
            ? `(${requiredNotes.join(", ")}; ${optionalNotes.join(", ")})`
            : `(${[...requiredNotes, ...optionalNotes].join(", ")})`;
        return combined.replaceAll(/\s+/gu, " ").trim().replaceAll("--", "—");
    }

    static asideText(value: string): string {
        const normalized = value.replaceAll(/\s+/gu, " ").trim().replaceAll("--", "—");
        const safeStart = /^(?:>|->)/u.test(normalized) ? `Description: ${normalized}` : normalized;
        return safeStart.endsWith("-") ? `${safeStart}.` : safeStart;
    }

    static targetSegment(target: string): string {
        return encodeURIComponent(target).replaceAll(/[!'()*]/gu, (character) =>
            `%${character.codePointAt(0)?.toString(16).toUpperCase()}`);
    }

    static input(invocation: RuntimeInvocationDecl): string | undefined {
        return invocation.example?.body ?? (invocation.inputSchema === undefined
            ? invocation.signature
            : ToolInputSchema.preview(invocation.inputSchema));
    }

    static header(
        runtime: string,
        invocation: RuntimeInvocationDecl,
        options: {
            readonly exactTarget?: string;
            readonly aside?: string;
            readonly schemaPath?: string;
            readonly includeSchemaNote?: boolean;
        } = {},
    ): string {
        const target = options.exactTarget ?? invocation.example?.target;
        const path = target === undefined ? "" : ` (${PathSyntax.escapeTarget(target)})`;
        const showSchemaNote = options.includeSchemaNote ?? options.schemaPath !== undefined;
        const schemaNote = showSchemaNote ? ToolInputSchema.asideNote(invocation.inputSchema) : undefined;
        const note = [
            ...(options.aside === undefined ? [] : [ToolInputSchema.asideText(options.aside)]),
            ...(schemaNote === undefined ? [] : [schemaNote]),
            ...(options.schemaPath === undefined ? [] : [`Schema: ${options.schemaPath.includes("://") ? options.schemaPath : `plurnk://${options.schemaPath}`}`]),
        ].join(" ");
        return `${runtime}${path}` + (note === "" ? "" : ` <!-- ${note} -->`);
    }

    // {§executor-discovery} — an invocation's copyable fence: its header, compact schema note, and input preview.
    static fence(
        runtime: string,
        invocation: RuntimeInvocationDecl,
        options: {
            readonly exactTarget?: string;
            readonly aside?: string;
            readonly schemaPath?: string;
            readonly includeSchemaNote?: boolean;
        } = {},
    ): string {
        return PlurnkParser.frame(
            ToolInputSchema.header(runtime, invocation, { includeSchemaNote: true, ...options }),
            ToolInputSchema.input(invocation) ?? null,
        );
    }

    // Include known referenced documents verbatim. Do not inline, rewrite, or fetch schemas.
    static references(schema: JsonSchema): object[] {
        const documents = new Map<string, object>();
        if (typeof schema.$id === "string") documents.set(schema.$id, schema);
        const visit = (value: unknown): void => {
            if (typeof value !== "object" || value === null) return;
            const ref = objectOf(value).$ref;
            if (typeof ref === "string") {
                const id = ref.split("#", 1)[0];
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
