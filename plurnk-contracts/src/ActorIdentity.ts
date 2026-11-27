// {§contract-representations} {§client-session-status} Runtime-neutral exterior actor parsing, normalization, and attribution extraction.

export type ExteriorActorScheme = "acp" | "mcp";

export interface ExteriorActorProfile {
    readonly id: string;
    readonly handle: string;
    readonly name?: string;
}

export interface ExteriorActorObject {
    readonly id: string;
    readonly handle?: string | null;
    readonly name?: string | null;
}

export type ExteriorActorInput = string | ExteriorActorObject;

export interface ExteriorActor {
    readonly id: string;
    readonly handle: string;
    readonly name?: string;
    readonly scheme: ExteriorActorScheme;
    readonly uri: string;
}

const UNNAMED_EXTERIOR_ACTORS: ReadonlySet<string> = new Set([
    "",
    "operator",
    "anonymous",
    "client",
    "owner",
]);

const RESERVED_ACTOR_NAMES: ReadonlySet<string> = new Set([
    "_plurnk",
    ".",
    "..",
]);

const EXTERIOR_ACTOR_SCHEMES: ReadonlySet<string> = new Set(["acp", "mcp"]);
const ALLOWED_ACTOR_OBJECT_KEYS: ReadonlySet<string> = new Set(["id", "handle", "name"]);

// Bare exterior actor identifiers forbid whitespace, ASCII control chars, and URI structural delimiters.
const isValidActorId = (value: string): boolean => {
    if (value.length === 0 || value.length > 256) return false;
    if (value === "_plurnk" || value === "." || value === "..") return false;
    if (!value.isWellFormed()) return false;
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) return false;
    }
    return !/[/?#\\]/u.test(value);
};

const isValidDisplayName = (value: string): boolean => {
    if (value.length === 0 || value.length > 256) return false;
    if (!value.isWellFormed()) return false;
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
};

export const isDefaultExteriorActor = (id: string | null | undefined): boolean => {
    if (typeof id !== "string") return true;
    return UNNAMED_EXTERIOR_ACTORS.has(id.trim());
};

export const formatExteriorActorInput = (raw: unknown): string =>
    typeof raw === "string" ? raw : JSON.stringify(raw);

const replaceAsciiControls = (raw: string): string => {
    let out = "";
    for (let i = 0; i < raw.length; i += 1) {
        const code = raw.charCodeAt(i);
        out += code <= 0x1f || code === 0x7f ? " " : raw[i];
    }
    return out;
};

const sliceCodePoints = (value: string, maxCodePoints: number): string => {
    let count = 0;
    let index = 0;
    while (index < value.length && count < maxCodePoints) {
        const cp = value.codePointAt(index);
        index += cp !== undefined && cp > 0xffff ? 2 : 1;
        count += 1;
    }
    return value.slice(0, index);
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Derive a clean human handle suitable for `message://<session>/<handle>_<seq>` keys from
 * OIDC profile claims (`preferred_username`, `nickname`, `name`, or verified `email` local-part).
 */
export const sanitizeActorHandle = (
    raw: string | null | undefined,
    options?: { readonly lowercase?: boolean },
): string | undefined => {
    if (typeof raw !== "string") return undefined;
    const withoutControls = replaceAsciiControls(raw).trim().replace(/^@+/u, "");
    if (withoutControls.length === 0) return undefined;
    const collapsed = withoutControls
        .replace(/[\s/?#\\@:]+/gu, "_")
        .replace(/_+/gu, "_")
        .replace(/^_+|_+$/gu, "");
    const cased = options?.lowercase === true ? collapsed.toLowerCase() : collapsed;
    const bounded = sliceCodePoints(cased, 64);
    if (
        bounded.length === 0 ||
        !bounded.isWellFormed() ||
        UNNAMED_EXTERIOR_ACTORS.has(bounded) ||
        RESERVED_ACTOR_NAMES.has(bounded) ||
        !isValidActorId(bounded)
    ) {
        return undefined;
    }
    return bounded;
};

/**
 * Normalize an optional human display name (such as OIDC `name`), stripping ASCII control characters.
 */
export const sanitizeActorDisplayName = (raw: string | null | undefined): string | undefined => {
    if (typeof raw !== "string") return undefined;
    const cleaned = replaceAsciiControls(raw).replace(/\s+/gu, " ").trim();
    const bounded = sliceCodePoints(cleaned, 256);
    return isValidDisplayName(bounded) ? bounded : undefined;
};

const parseActorIdAndScheme = (
    raw: string,
    defaultScheme: ExteriorActorScheme,
): { readonly id: string; readonly scheme: ExteriorActorScheme } | null => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || RESERVED_ACTOR_NAMES.has(trimmed)) return null;

    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(trimmed);
    if (schemeMatch !== null) {
        const scheme = (schemeMatch[1] ?? "").toLowerCase();
        if (!EXTERIOR_ACTOR_SCHEMES.has(scheme)) return null;
        const rest = trimmed.slice(schemeMatch[0].length);
        const authority = rest.endsWith("/") ? rest.slice(0, -1) : rest;
        if (
            authority.length === 0 ||
            authority.includes("/") ||
            authority.includes("?") ||
            authority.includes("#") ||
            authority.includes("@") ||
            authority.includes(":")
        ) {
            return null;
        }
        let decoded: string;
        try {
            decoded = decodeURIComponent(authority);
        } catch {
            return null;
        }
        if (!isValidActorId(decoded)) return null;
        return {
            id: decoded,
            scheme: scheme === "mcp" ? "mcp" : "acp",
        };
    }

    if (trimmed.includes("://")) return null;
    if (!isValidActorId(trimmed)) return null;
    return {
        id: trimmed,
        scheme: defaultScheme,
    };
};

/**
 * Parse and normalize an exterior actor input: either a bare ID / authority-only exterior URI
 * (`"hazool17"`, `"acp://hazool17"`, `"mcp://bridge"`) or a structured `{ id, handle?, name? }` object.
 * Rejects internal schemes (`session://`, `message://`, `log://`, etc.), `_plurnk`, unknown fields,
 * path/query/fragment/userinfo/port components, whitespace in IDs/handles, and malformed encodings.
 */
export const parseExteriorActor = (
    raw: unknown,
    defaultScheme: ExteriorActorScheme = "acp",
): ExteriorActor | null => {
    if (typeof raw === "string") {
        const parsed = parseActorIdAndScheme(raw, defaultScheme);
        if (parsed === null) return null;
        return {
            id: parsed.id,
            handle: parsed.id,
            scheme: parsed.scheme,
            uri: `${parsed.scheme}://${encodeURIComponent(parsed.id)}`,
        };
    }

    if (!isPlainRecord(raw)) return null;
    const obj = raw;
    for (const key of Object.keys(obj)) {
        if (!ALLOWED_ACTOR_OBJECT_KEYS.has(key)) return null;
    }
    if (typeof obj.id !== "string") return null;
    const parsed = parseActorIdAndScheme(obj.id, defaultScheme);
    if (parsed === null) return null;

    let explicitHandle: string | undefined;
    if (obj.handle !== undefined && obj.handle !== null) {
        if (typeof obj.handle !== "string") return null;
        const trimmedHandle = obj.handle.trim();
        if (!isValidActorId(trimmedHandle) || isDefaultExteriorActor(trimmedHandle)) return null;
        explicitHandle = trimmedHandle;
    }

    let explicitName: string | undefined;
    if (obj.name !== undefined && obj.name !== null) {
        if (typeof obj.name !== "string") return null;
        const trimmedName = obj.name.trim();
        if (!isValidDisplayName(trimmedName)) return null;
        explicitName = trimmedName;
    }

    const handle =
        explicitHandle ??
        (explicitName !== undefined ? sanitizeActorHandle(explicitName, { lowercase: true }) : undefined) ??
        parsed.id;

    return {
        id: parsed.id,
        handle,
        ...(explicitName !== undefined ? { name: explicitName } : {}),
        scheme: parsed.scheme,
        uri: `${parsed.scheme}://${encodeURIComponent(parsed.id)}`,
    };
};

/**
 * Compare a caller-requested actor (bare string, exterior URI, or `{ id, handle?, name? }`)
 * against an authenticated credential subject (`admission.subject`).
 */
export const actorsMatch = (requested: unknown, authenticatedSubject: string): boolean => {
    if (typeof authenticatedSubject !== "string") return false;
    const subTrimmed = authenticatedSubject.trim();
    if (subTrimmed.length === 0) return false;
    const reqParsed = parseExteriorActor(requested);
    if (reqParsed === null) return false;
    const subParsed = parseExteriorActor(subTrimmed);
    const subId = subParsed?.id ?? subTrimmed;
    return reqParsed.id === subId;
};

/**
 * Extract the non-default causal actor handle/name from structured actor metadata or a Plurnk message
 * source/address URI (`acp://<actor>[/...]`, `mcp://<actor>[/...]`, `session://<worker>[/...]`,
 * `message://<session>/<actor>_<seq>`, or `schedule:///[rules/]<alias>`).
 * Returns `undefined` for unnamed default exterior actors (`operator`, `anonymous`, `client`, `owner`) or `_plurnk`.
 */
export const extractActor = (
    sourceOrAddress: string | null | undefined,
    actorProfile?: { readonly id?: string | null; readonly handle?: string | null } | null,
): string | undefined => {
    if (actorProfile !== null && actorProfile !== undefined && typeof actorProfile === "object") {
        const id = typeof actorProfile.id === "string" ? actorProfile.id.trim() : "";
        const handle = typeof actorProfile.handle === "string" ? actorProfile.handle.trim() : "";
        if (id.length > 0 && !UNNAMED_EXTERIOR_ACTORS.has(id) && id !== "_plurnk") {
            return handle.length > 0 && !UNNAMED_EXTERIOR_ACTORS.has(handle) && handle !== "_plurnk"
                ? handle
                : id;
        }
    }
    if (typeof sourceOrAddress !== "string" || sourceOrAddress.length === 0) return undefined;

    const acpMatch = /^acp:\/\/([^/?#]+)/u.exec(sourceOrAddress);
    if (acpMatch !== null) {
        try {
            const principal = decodeURIComponent(acpMatch[1] ?? "");
            if (principal.length > 0 && !UNNAMED_EXTERIOR_ACTORS.has(principal) && principal !== "_plurnk") {
                return principal;
            }
        } catch {
            // fall through
        }
        return undefined;
    }

    const mcpMatch = /^mcp:\/\/([^/?#]+)/u.exec(sourceOrAddress);
    if (mcpMatch !== null) {
        try {
            const principal = decodeURIComponent(mcpMatch[1] ?? "");
            if (principal.length > 0 && !UNNAMED_EXTERIOR_ACTORS.has(principal) && principal !== "_plurnk") {
                return principal;
            }
        } catch {
            // fall through
        }
        return undefined;
    }

    const sessionMatch = /^session:\/\/([^/?#]+)/u.exec(sourceOrAddress);
    if (sessionMatch !== null) {
        try {
            const worker = decodeURIComponent(sessionMatch[1] ?? "");
            if (worker.length > 0 && worker !== "_plurnk") return worker;
        } catch {
            // fall through
        }
        return undefined;
    }

    const messageMatch = /^message:\/\/[^/?#]+\/([^/?#]+)_([0-9a-zA-Z]{2,5})$/u.exec(sourceOrAddress);
    if (messageMatch !== null) {
        try {
            const principal = decodeURIComponent(messageMatch[1] ?? "");
            if (principal.length > 0 && !UNNAMED_EXTERIOR_ACTORS.has(principal) && principal !== "_plurnk") {
                return principal;
            }
        } catch {
            // fall through
        }
        return undefined;
    }

    const schedulePathMatch = /^schedule:\/\/\/([^?#]+)$/u.exec(sourceOrAddress.split(/[?#]/u, 1)[0] ?? "");
    if (schedulePathMatch !== null) {
        const segments = (schedulePathMatch[1] ?? "").split("/").filter((s) => s.length > 0);
        const rawAlias = segments[0] === "rules" ? segments[1] : segments[0];
        if (rawAlias !== undefined && rawAlias.length > 0) {
            try {
                const alias = decodeURIComponent(rawAlias);
                if (alias.length > 0 && !UNNAMED_EXTERIOR_ACTORS.has(alias) && alias !== "_plurnk") {
                    return alias;
                }
            } catch {
                // fall through
            }
        }
    }

    return undefined;
};
