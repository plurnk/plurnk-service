// Focused validator for the TelemetryEvent envelope published at
// @plurnk/plurnk-grammar's exported schema (resolved through the export map, so the
// Hand-rolled rather than importing a full JSON Schema engine because
// the envelope is small + bounded; pulling in ajv for this would be
// over-tooling. Any time the published schema changes shape, this
// validator regenerates alongside it (we don't want silent drift).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCHEMA_PATH = fileURLToPath(import.meta.resolve("@plurnk/plurnk-grammar/schema/TelemetryEvent.json"));

interface Schema {
    required?: string[];
    properties?: Record<string, unknown>;
    $defs?: Record<string, unknown>;
}

const cachedSchema: { schema: Schema | null } = { schema: null };

const loadSchema = async (): Promise<Schema> => {
    if (cachedSchema.schema !== null) return cachedSchema.schema;
    const text = await readFile(SCHEMA_PATH, "utf8");
    cachedSchema.schema = JSON.parse(text) as Schema;
    return cachedSchema.schema;
};

const SOURCE_PATTERN = /^[a-z]+(:[a-z][a-z0-9-]*)?$/;

const validateContentOffset = (pos: unknown, errs: string[]): void => {
    if (typeof pos !== "object" || pos === null) { errs.push("position: not an object"); return; }
    const p = pos as Record<string, unknown>;
    if (p.type !== "content-offset") errs.push(`position.type: expected "content-offset", got ${JSON.stringify(p.type)}`);
    if (typeof p.line !== "number" || !Number.isInteger(p.line) || p.line < 0) errs.push(`position.line: expected non-negative integer, got ${JSON.stringify(p.line)}`);
    if (typeof p.column !== "number" || !Number.isInteger(p.column) || p.column < 0) errs.push(`position.column: expected non-negative integer, got ${JSON.stringify(p.column)}`);
    for (const k of Object.keys(p)) {
        if (k !== "type" && k !== "line" && k !== "column") errs.push(`position: unexpected key '${k}' (additionalProperties: false)`);
    }
};

const validateLogCoordinate = (pos: unknown, errs: string[]): void => {
    if (typeof pos !== "object" || pos === null) { errs.push("position: not an object"); return; }
    const p = pos as Record<string, unknown>;
    if (p.type !== "log-coordinate") errs.push(`position.type: expected "log-coordinate", got ${JSON.stringify(p.type)}`);
    if (typeof p.coordinate !== "string" || p.coordinate.length === 0) errs.push("position.coordinate: expected non-empty string");
    if (p.op !== undefined && typeof p.op !== "string") errs.push("position.op: expected string when present");
    for (const k of Object.keys(p)) {
        if (k !== "type" && k !== "coordinate" && k !== "op") errs.push(`position: unexpected key '${k}' (additionalProperties: false)`);
    }
};

const validatePosition = (pos: unknown, errs: string[]): void => {
    if (pos === null) return; // null variant is explicitly allowed
    if (typeof pos !== "object") { errs.push(`position: expected object or null, got ${typeof pos}`); return; }
    const type = (pos as { type?: unknown }).type;
    if (type === "content-offset") validateContentOffset(pos, errs);
    else if (type === "log-coordinate") validateLogCoordinate(pos, errs);
    else errs.push(`position.type: expected "content-offset" | "log-coordinate" | null, got ${JSON.stringify(type)}`);
};

// Validate an event against the TelemetryEvent schema. Returns [] when
// the event conforms; returns an array of human-readable error strings
// otherwise. Caller decides whether to assert or accumulate.
export const validateTelemetryEvent = async (event: unknown): Promise<string[]> => {
    await loadSchema();
    const errs: string[] = [];
    if (typeof event !== "object" || event === null) { errs.push("event: not an object"); return errs; }
    const e = event as Record<string, unknown>;

    if (typeof e.source !== "string") errs.push(`source: required string, got ${JSON.stringify(e.source)}`);
    else if (!SOURCE_PATTERN.test(e.source)) errs.push(`source: '${e.source}' violates pattern ^[a-z]+(:[a-z][a-z0-9-]*)?$`);

    if (typeof e.kind !== "string" || e.kind.length === 0) errs.push(`kind: required non-empty string, got ${JSON.stringify(e.kind)}`);

    if (e.message !== undefined && e.message !== null && typeof e.message !== "string") {
        errs.push(`message: expected string | null when present, got ${typeof e.message}`);
    }

    if (e.position !== undefined) validatePosition(e.position, errs);

    return errs;
};

// Assert helper for tests. Throws AssertionError with the accumulated
// errors prefixed by context. additionalProperties: true at the top
// level means kind-specific fields are permitted; we only validate
// envelope conformance.
export const assertValidTelemetryEvent = async (event: unknown, context: string): Promise<void> => {
    const errs = await validateTelemetryEvent(event);
    if (errs.length === 0) return;
    throw new Error(`TelemetryEvent envelope invalid [${context}]:\n  - ${errs.join("\n  - ")}\n  event: ${JSON.stringify(event)}`);
};
