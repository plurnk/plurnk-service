// {§contract-representations} {§client-session-status} Runtime-neutral exterior actor parsing, normalization, and attribution extraction.

export type ExteriorActorScheme = "acp" | "mcp";

export interface ExteriorActor {
    readonly name: string;
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

// Bare exterior actor names forbid whitespace, ASCII control chars, and URI structural delimiters.
const isValidActorName = (value: string): boolean => {
    if (value.length === 0 || value.length > 256) return false;
    if (value === "_plurnk" || value === "." || value === "..") return false;
    if (!value.isWellFormed()) return false;
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) return false;
    }
    return !/[/?#\\]/u.test(value);
};

export const isDefaultExteriorActor = (name: string | null | undefined): boolean => {
    if (typeof name !== "string") return true;
    return UNNAMED_EXTERIOR_ACTORS.has(name.trim());
};

/**
 * Parse and normalize an exterior actor identifier (bare name like `"hazool17"` or
 * authority-only exterior URI like `"acp://hazool17"` / `"mcp://bridge"`).
 * Rejects internal schemes (`session://`, `message://`, `log://`, etc.), `_plurnk`,
 * path/query/fragment/userinfo/port components, whitespace, and malformed encodings.
 */
export const parseExteriorActor = (
    raw: string,
    defaultScheme: ExteriorActorScheme = "acp",
): ExteriorActor | null => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || RESERVED_ACTOR_NAMES.has(trimmed)) return null;

    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(trimmed);
    if (schemeMatch !== null) {
        const scheme = (schemeMatch[1] ?? "").toLowerCase();
        if (!EXTERIOR_ACTOR_SCHEMES.has(scheme)) return null;
        const rest = trimmed.slice(schemeMatch[0].length);
        // Authority-only: reject pathname (except optional trailing slash), query, fragment, userinfo, or port.
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
        if (!isValidActorName(decoded)) return null;
        const typedScheme: ExteriorActorScheme = scheme === "mcp" ? "mcp" : "acp";
        return {
            name: decoded,
            scheme: typedScheme,
            uri: `${typedScheme}://${encodeURIComponent(decoded)}`,
        };
    }

    if (trimmed.includes("://")) return null;
    if (!isValidActorName(trimmed)) return null;
    return {
        name: trimmed,
        scheme: defaultScheme,
        uri: `${defaultScheme}://${encodeURIComponent(trimmed)}`,
    };
};

/**
 * Compare a caller-requested actor (bare name or exterior URI) against an
 * authenticated credential subject (`admission.subject`).
 */
export const actorsMatch = (requested: string, authenticatedSubject: string): boolean => {
    const reqTrimmed = requested.trim();
    const subTrimmed = authenticatedSubject.trim();
    if (reqTrimmed.length === 0 || subTrimmed.length === 0) return false;
    const reqParsed = parseExteriorActor(reqTrimmed);
    const subParsed = parseExteriorActor(subTrimmed);
    const reqName = reqParsed?.name ?? reqTrimmed;
    const subName = subParsed?.name ?? subTrimmed;
    return reqName === subName;
};

/**
 * Extract the non-default causal actor name from a Plurnk message source or address URI
 * (`acp://<actor>[/...]`, `mcp://<actor>[/...]`, `session://<worker>[/...]`, or `message://<session>/<actor>_<seq>`).
 * Returns `undefined` for unnamed default exterior actors (`operator`, `anonymous`, `client`, `owner`) or `_plurnk`.
 */
export const extractActor = (sourceOrAddress: string | null | undefined): string | undefined => {
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
