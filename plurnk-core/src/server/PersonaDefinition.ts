// {§persona-discovery} — persona definition schema, environment parsing, and frontmatter validation.
import { basename, dirname } from "node:path";
import {
    EFFORTS,
    isRecord,
    SKILL_NAME,
    type ApplicationPersonaProjection,
    type Effort,
    type FunctionalityServiceDefinition,
    type JsonSchema,
} from "@plurnk/plurnk-contracts";
import { parseSkill, skillName } from "@plurnk/plurnk-agent-skills";
import { ConfigurationError, ResourceEnvironment } from "@plurnk/plurnk-meta";
import Results, { OperationFailureError } from "../core/results.ts";

export const PERSONAS_FAMILY = "personas";
export const PERSONAS_OWNER = "@plurnk/plurnk-service:personas";
export const PERSONAS_PREFIX = "PLURNK_PERSONAS_";

export interface PersonaSourceDefinition {
    readonly source: string;
    readonly model?: string;
    readonly effort?: Effort;
}

export interface PersonaInlineDefinition {
    readonly description: string;
    readonly body: string;
    readonly model?: string;
    readonly effort?: Effort;
}

export type PersonaDefinition = PersonaSourceDefinition | PersonaInlineDefinition;

const isEffort = (value: unknown): value is Effort =>
    typeof value === "string" && (EFFORTS as readonly string[]).includes(value);

export const isInlineDefinition = (value: PersonaDefinition): value is PersonaInlineDefinition =>
    "description" in value && "body" in value;

const PERSONA_INLINE_SCHEMA: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["description", "body"],
    properties: {
        description: { type: "string", minLength: 1, maxLength: 1024 },
        body: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        effort: { type: "string", enum: [...EFFORTS] },
    },
});

const PERSONA_SOURCE_SCHEMA: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["source"],
    properties: {
        source: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        effort: { type: "string", enum: [...EFFORTS] },
    },
});

export const PERSONA_DEFINITION_SCHEMA: JsonSchema = Object.freeze({
    anyOf: [PERSONA_INLINE_SCHEMA, PERSONA_SOURCE_SCHEMA],
});

export const refusePersona = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("personas:functionality", code, status, detail, {}, {
        family: PERSONAS_FAMILY,
        retryable: false,
        ...extensions,
    }),
);

export const formatPersonaMarkdown = (name: string, def: PersonaInlineDefinition): string => [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(def.description)}`,
    ...(def.model === undefined ? [] : [`model: ${JSON.stringify(def.model)}`]),
    ...(def.effort === undefined ? [] : [`effort: ${def.effort}`]),
    "---",
    "",
    def.body.trim(),
    "",
].join("\n");

export const parsePersonaDefinitionObject = (raw: unknown): PersonaDefinition => {
    if (!isRecord(raw)) {
        throw new Error("Persona definition must be a JSON object with either { description, body } or { source }.");
    }
    const allowedKeys = new Set(["source", "description", "body", "model", "effort"]);
    for (const key of Object.keys(raw)) {
        if (!allowedKeys.has(key)) {
            throw new Error(`Persona definition contains unsupported field '${key}'.`);
        }
    }
    let model: string | undefined;
    if (raw.model !== undefined) {
        if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
            throw new Error("Persona definition 'model' must be a non-empty string.");
        }
        model = raw.model.trim();
    }
    let effort: Effort | undefined;
    if (raw.effort !== undefined) {
        if (!isEffort(raw.effort)) {
            throw new Error(`Persona definition 'effort' must be one of ${EFFORTS.join(", ")}.`);
        }
        effort = raw.effort;
    }
    const hasSource = raw.source !== undefined;
    const hasInline = raw.description !== undefined || raw.body !== undefined;
    if (hasSource && hasInline) {
        throw new Error("Persona definition must specify either { source } or { description, body }, not both.");
    }
    if (hasSource) {
        if (typeof raw.source !== "string" || raw.source.trim().length === 0) {
            throw new Error("Persona definition 'source' must be a non-empty path.");
        }
        return {
            source: raw.source.trim(),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
        };
    }
    if (typeof raw.description !== "string" || raw.description.trim().length === 0) {
        throw new Error("Inline persona definition requires a non-empty 'description'.");
    }
    const description = raw.description.trim();
    if (Array.from(description).length > 1024) {
        throw new Error("Persona description exceeds 1024 characters.");
    }
    if (typeof raw.body !== "string" || raw.body.trim().length === 0) {
        throw new Error("Inline persona definition requires a non-empty 'body'.");
    }
    return {
        description,
        body: raw.body.trim(),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
    };
};

export const personasEnvironment = (environ: NodeJS.ProcessEnv = process.env): ResourceEnvironment =>
    new ResourceEnvironment(PERSONAS_PREFIX, { controls: [], settings: [], aliasPattern: SKILL_NAME }, environ);

export const servicePersonas = (environ: NodeJS.ProcessEnv = process.env): FunctionalityServiceDefinition<PersonaDefinition>[] => {
    const env = personasEnvironment(environ);
    const out: FunctionalityServiceDefinition<PersonaDefinition>[] = [];
    for (const [alias, { key, value }] of env.definitions) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(value);
        } catch (cause) {
            throw new ConfigurationError(key, `${key} must be valid JSON ({ "source": "..." } or { "description": "...", "body": "..." }).`, { cause });
        }
        let definition: PersonaDefinition;
        try {
            definition = parsePersonaDefinitionObject(parsed);
        } catch (cause) {
            throw new ConfigurationError(key, `${key}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
        out.push({
            alias,
            definition,
            enabled: env.enabled(alias),
            provenance: { kind: "environment", source: key },
        });
    }
    return out;
};

export const inferPersonaNameFromPath = (filePath: string, content: string): string => {
    try {
        return skillName(filePath, content);
    } catch {
        const base = basename(filePath);
        if (base === "PERSONA.md") return basename(dirname(filePath));
        if (base.endsWith(".md")) return base.slice(0, -".md".length);
        return base;
    }
};

export const injectPersonaNameIfMissing = (alias: string, source: string): string => {
    const match = /^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/mu.exec(source);
    if (match === null) return source;
    if (/^\s*name\s*:/mu.test(match[2])) return source;
    return `${match[1]}name: ${alias}\n${match[2]}${match[3]}${source.slice(match[0].length)}`;
};

export const parsePersonaDocument = (
    file: string,
    expectedName: string,
    source: string,
    overrides: { readonly model?: string; readonly effort?: Effort } = {},
): { readonly projection: ApplicationPersonaProjection; readonly document: ReturnType<typeof parseSkill> } => {
    const document = parseSkill(file, expectedName, source);
    const body = document.body.trim();
    if (body.length === 0) {
        throw new Error(`${file}: Persona '${expectedName}' requires non-empty instruction body.`);
    }
    const rawModel = overrides.model ?? document.metadata.model;
    let model: string | undefined;
    if (rawModel !== undefined) {
        if (typeof rawModel !== "string" || rawModel.trim().length === 0) {
            throw new Error(`${file}: Persona '${expectedName}' frontmatter 'model' must be a non-empty string.`);
        }
        model = rawModel.trim();
    }
    const rawEffort = overrides.effort ?? document.metadata.effort;
    let effort: Effort | undefined;
    if (rawEffort !== undefined) {
        if (!isEffort(rawEffort)) {
            throw new Error(
                `${file}: Persona '${expectedName}' frontmatter 'effort' must be one of ${EFFORTS.join(", ")}.`,
            );
        }
        effort = rawEffort;
    }
    return {
        document,
        projection: {
            name: document.name,
            description: document.description,
            body,
            source: document.source,
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
        },
    };
};

export const parsePersonaEditBody = (alias: string, rawBody: string): PersonaDefinition => {
    const trimmed = rawBody.trim();
    if (trimmed.length === 0) {
        throw new Error(`Persona '${alias}' requires either a Markdown document with YAML frontmatter or a JSON definition object.`);
    }
    if (trimmed.startsWith("{")) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch (cause) {
            throw new Error(`Persona '${alias}' JSON definition is invalid: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
        return parsePersonaDefinitionObject(parsed);
    }
    const withName = injectPersonaNameIfMissing(alias, rawBody);
    const parsed = parsePersonaDocument(
        `persona://${alias}/PERSONA.md`,
        alias,
        withName,
    );
    return {
        description: parsed.projection.description,
        body: parsed.projection.body,
        ...(parsed.projection.model === undefined ? {} : { model: parsed.projection.model }),
        ...(parsed.projection.effort === undefined ? {} : { effort: parsed.projection.effort }),
    };
};
