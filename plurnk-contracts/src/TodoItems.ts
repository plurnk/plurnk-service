import { isRecord } from "./guards.ts";

const COMPLETED_LINE_PREFIX =
    /^(?:(?:[-*+•]|(?:\d+|[A-Za-z])[.)])\s+)?\[(?:[xX]|done|DONE|completed|COMPLETED)\](?:\s+|$)/u;
const LIST_PREFIX = /^(?:(?:[-*+•]|(?:\d+|[A-Za-z])[.)])\s+(?:\[\s*\]\s+)?|\[\s*\]\s+|[-*+•]\s*$)/u;
const ITEM_KEYS = ["content", "text", "title", "item", "todo", "description", "name"] as const;
const CONTAINER_KEYS = ["todo", "todos", "items", "steps", "tasks"] as const;
const OPEN_WORK_KEYS: ReadonlySet<string> = new Set(["sessions", "streams", "messages", "todo"]);

function extractCleanItem(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || COMPLETED_LINE_PREFIX.test(trimmed)) return null;
    const cleaned = trimmed.replace(LIST_PREFIX, "").trim();
    return cleaned.length > 0 && !COMPLETED_LINE_PREFIX.test(cleaned) ? cleaned : null;
}

function isCompletedRecord(record: Record<string, unknown>): boolean {
    if (record.done === true || record.completed === true) return true;
    if (typeof record.status === "string") {
        const lower = record.status.toLowerCase();
        if (lower === "completed" || lower === "done") return true;
    }
    return false;
}

function tryParseJson(raw: string): unknown {
    const trimmed = raw.trim().replace(/,\s*$/u, "");
    if (trimmed.length === 0) return undefined;
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return undefined;
        }
    }
    if (/^(?:"(?:todo|todos|items|steps|tasks)"|todo|todos|items|steps|tasks)\s*:/iu.test(trimmed)) {
        const normalized = trimmed.replace(/^([A-Za-z]+)\s*:/u, '"$1":');
        try {
            return JSON.parse(`{${normalized}}`);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function extractFromJsonValue(value: unknown): string[] {
    if (typeof value === "string") {
        return parseLines(value);
    }
    if (Array.isArray(value)) {
        const out: string[] = [];
        for (const element of value) {
            if (typeof element === "string") {
                const cleaned = extractCleanItem(element);
                if (cleaned !== null) out.push(cleaned);
            } else if (isRecord(element)) {
                if (isCompletedRecord(element)) continue;
                let matched = false;
                for (const key of ITEM_KEYS) {
                    const candidate = element[key];
                    if (typeof candidate === "string") {
                        const cleaned = extractCleanItem(candidate);
                        if (cleaned !== null) out.push(cleaned);
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    out.push(...extractFromJsonValue(element));
                }
            }
        }
        return out;
    }
    if (isRecord(value)) {
        for (const key of CONTAINER_KEYS) {
            if (key in value) {
                return extractFromJsonValue(value[key]);
            }
        }
        const entries = Object.entries(value).filter(([k]) => !OPEN_WORK_KEYS.has(k));
        if (entries.length === 0) return [];
        const out: string[] = [];
        for (const [key, entryValue] of entries) {
            if (typeof entryValue === "string") {
                const cleaned = extractCleanItem(entryValue);
                if (cleaned !== null) out.push(cleaned);
            } else if (typeof entryValue === "boolean" || entryValue === null) {
                if (entryValue !== false) {
                    const cleaned = extractCleanItem(key);
                    if (cleaned !== null) out.push(cleaned);
                }
            } else if (Array.isArray(entryValue) || isRecord(entryValue)) {
                out.push(...extractFromJsonValue(entryValue));
            }
        }
        return out;
    }
    return [];
}

function parseLines(text: string): string[] {
    const out: string[] = [];
    for (const rawLine of text.split(/\r?\n/u)) {
        const trimmed = rawLine.trim();
        if (trimmed.length === 0) continue;
        const parsedLine = tryParseJson(trimmed);
        if (parsedLine !== undefined) {
            out.push(...extractFromJsonValue(parsedLine));
            continue;
        }
        const cleaned = extractCleanItem(trimmed);
        if (cleaned !== null) {
            out.push(cleaned);
        }
    }
    return out;
}

/**
 * {§op-shapes} Extracts ordered step items from a `TODO` operation body, tolerating markdown bullets,
 * numbered/lettered lists, checkboxes, JSON arrays/objects (including copied `## Open Work` JSON), and free text.
 */
export function parseTodoItems(body: string | null | undefined): string[] {
    if (typeof body !== "string") return [];
    const trimmed = body.trim();
    if (trimmed.length === 0) return [];
    const parsedWhole = tryParseJson(trimmed);
    if (parsedWhole !== undefined) {
        return extractFromJsonValue(parsedWhole);
    }
    return parseLines(trimmed);
}
