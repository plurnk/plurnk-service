// {§provider-request-authority} {§provider-configuration} — opt-in outbound HTTP call-attribution
// headers (`X-Plurnk-*`) and sanitized DaemonModule metadata (`X-Plurnk-Meta-*`) projection (#1573).

import { providerSetting } from "./provider-env.ts";
import {
    ATTRIBUTION_HEADER_FIELDS,
    type AttributionHeaderField,
    type ProviderCallAttribution,
    type ProviderCallKind,
} from "./types.ts";

// Wire protocol safety bounds registered in scripts/env-surface-mechanism.json.
export const ATTRIBUTION_VALUE_MAX_LENGTH = 256;
export const MODULE_METADATA_MAX_KEYS = 16;

const ATTRIBUTION_HEADERS_KNOB = "PLURNK_PROVIDERS_ATTRIBUTION_HEADERS";
const PROVIDER_ATTRIBUTION_PATTERN = /^PLURNK_PROVIDERS_PROVIDER_[A-Z0-9_]+_ATTRIBUTION_HEADERS$/u;
const MODULE_METADATA_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const EMPTY_FIELDS: ReadonlySet<AttributionHeaderField> = new Set();

export const isValidModuleMetadataKey = (key: string): boolean => MODULE_METADATA_KEY_PATTERN.test(key);

// {§provider-configuration} Strict parser for comma-separated opt-in field tokens.
// Empty/unset or bare "off" selects zero headers; unknown tokens, empty segments, or
// mixing "off" with field names fail fast.
export const parseAttributionHeaderFields = (
    raw: string | undefined,
    keyName: string,
): ReadonlySet<AttributionHeaderField> => {
    if (raw === undefined) return EMPTY_FIELDS;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === "off") return EMPTY_FIELDS;
    const selected = new Set<AttributionHeaderField>();
    const validList = ATTRIBUTION_HEADER_FIELDS.join(", ");
    for (const part of trimmed.split(",")) {
        const token = part.trim();
        if (token.length === 0) {
            throw new TypeError(
                `${keyName} contains an empty field entry; use "off" or comma-separated fields from: ${validList}`,
            );
        }
        if (token === "off") {
            throw new TypeError(
                `${keyName} cannot combine "off" with attribution fields; use "off" alone or fields from: ${validList}`,
            );
        }
        const matched = ATTRIBUTION_HEADER_FIELDS.find((candidate) => candidate === token);
        if (matched === undefined) {
            throw new TypeError(
                `${keyName} has invalid field ${JSON.stringify(token)}; valid fields: ${validList} (or "off")`,
            );
        }
        selected.add(matched);
    }
    return selected;
};

export const attributionHeadersFromEnv = (
    provider: string,
    env: NodeJS.ProcessEnv,
): ReadonlySet<AttributionHeaderField> => {
    const [key, raw] = providerSetting(provider, env, "ATTRIBUTION_HEADERS");
    return parseAttributionHeaderFields(raw, key);
};

// {§provider-configuration} Validate every global, alias-scoped, and provider-scoped attribution
// header declaration in `env` so typos fail `config check` and startup offline.
export const validateAttributionHeadersFromEnv = (env: NodeJS.ProcessEnv): void => {
    for (const [key, value] of Object.entries(env)) {
        if (
            key === ATTRIBUTION_HEADERS_KNOB
            || key.startsWith(`${ATTRIBUTION_HEADERS_KNOB}_`)
            || PROVIDER_ATTRIBUTION_PATTERN.test(key)
        ) {
            parseAttributionHeaderFields(value, key);
        }
    }
};

// {§provider-request-authority} Strip ASCII control characters (preventing CRLF/NUL header
// injection), percent-encode non-ASCII UTF-8 bytes so Fetch `Headers` ByteString conversion
// never throws on Unicode names, and bound length without splitting a `%XX` escape sequence.
export const sanitizeAttributionHeaderValue = (raw: string): string | undefined => {
    // oxlint-disable-next-line no-control-regex -- intentional stripping of RFC 9110 forbidden ASCII control octets
    const cleaned = raw.replaceAll(/[\x00-\x1f\x7f]+/gu, "").trim();
    if (cleaned.length === 0) return undefined;
    let encoded = "";
    for (const char of cleaned) {
        const code = char.codePointAt(0)!;
        const piece = code <= 0x7e ? char : encodeURIComponent(char);
        if (encoded.length + piece.length > ATTRIBUTION_VALUE_MAX_LENGTH) break;
        encoded += piece;
    }
    const final = encoded.trim();
    return final.length === 0 ? undefined : final;
};

const safeIntHeaderValue = (value: number | undefined): string | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;

// {§provider-request-authority} Project structured call attribution onto `X-Plurnk-*` HTTP headers
// strictly according to the route's opt-in allowlist. Zero fields enabled => empty object.
export const projectAttributionHeaders = (
    enabled: ReadonlySet<AttributionHeaderField>,
    attribution: ProviderCallAttribution | undefined,
    callKind: ProviderCallKind | undefined,
): Readonly<Record<string, string>> => {
    if (enabled.size === 0) return {};
    const out: Record<string, string> = {};
    const put = (headerName: string, raw: string | null | undefined): void => {
        if (typeof raw !== "string") return;
        const sanitized = sanitizeAttributionHeaderValue(raw);
        if (sanitized !== undefined) out[headerName] = sanitized;
    };

    if (enabled.has("workspace")) put("X-Plurnk-Workspace", attribution?.workspaceName);
    if (enabled.has("workspace-id")) put("X-Plurnk-Workspace-Id", safeIntHeaderValue(attribution?.workspaceId));
    if (enabled.has("session")) put("X-Plurnk-Session", attribution?.sessionName);
    if (enabled.has("session-id")) put("X-Plurnk-Session-Id", safeIntHeaderValue(attribution?.sessionId));
    if (enabled.has("actor")) put("X-Plurnk-Actor", attribution?.actor);
    if (enabled.has("loop")) put("X-Plurnk-Loop-Id", safeIntHeaderValue(attribution?.loopId));
    if (enabled.has("turn")) put("X-Plurnk-Turn-Id", safeIntHeaderValue(attribution?.turnId));
    if (enabled.has("call-kind") && (callKind === "emission" || callKind === "bare")) {
        put("X-Plurnk-Call-Kind", callKind);
    }

    if (enabled.has("module") && attribution?.moduleMetadata !== undefined) {
        const entries = Object.entries(attribution.moduleMetadata);
        if (entries.length > MODULE_METADATA_MAX_KEYS) {
            throw new RangeError(
                `moduleMetadata carries ${entries.length} entries, exceeding the maximum of ${MODULE_METADATA_MAX_KEYS}`,
            );
        }
        for (const [key, value] of entries) {
            if (!isValidModuleMetadataKey(key)) {
                throw new TypeError(
                    `invalid moduleMetadata key ${JSON.stringify(key)}; keys must match /^[a-z0-9][a-z0-9-]{0,63}$/`,
                );
            }
            if (typeof value !== "string") {
                throw new TypeError(`moduleMetadata[${JSON.stringify(key)}] must be a string`);
            }
            put(`X-Plurnk-Meta-${key}`, value);
        }
    }

    return out;
};
