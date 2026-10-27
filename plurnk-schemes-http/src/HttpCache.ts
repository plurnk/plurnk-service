import {
    MimetypeClassifier,
    type ChannelState,
    type ProjectionCaps,
    type StoredEntryData,
} from "@plurnk/plurnk-schemes";
import {
    BODY,
    CACHE_VARIANT_HEADER,
    FETCHED_AT,
    HEADER,
    MATERIALIZER_ID_HEADER,
    PROJECTION_ID_HEADER,
    REQUEST_METHOD,
    cacheVariantEvidence,
    classifyCacheVariant,
    requireNonNegativeIntegerEnv as requireNumEnv,
    responseMimetype,
} from "./HttpShared.ts";
import WebFetcher from "./WebFetcher.ts";

const DELTA_SECONDS_LIMIT = 2_147_483_648n;
const HEURISTIC_CACHE_STATUSES = new Set([200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);
const BODY_PROCESSING_FIELDS = new Set([
    "content-encoding",
    "content-length",
    "content-range",
    "content-type",
]);

interface HeaderField {
    readonly name: string;
    readonly value: string;
    readonly line: string;
}

interface EntityTag {
    readonly weak: boolean;
    readonly opaque: string;
}

interface StoredCachePolicy {
    readonly cacheable: boolean;
    readonly noCache: boolean;
    readonly freshnessLifetimeMs?: number;
}

const splitHttpList = (value: string): string[] => {
    const members: string[] = [];
    let start = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') quoted = false;
        } else if (character === '"') {
            quoted = true;
        } else if (character === ",") {
            members.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }
    members.push(value.slice(start).trim());
    return members.filter((member) => member.length > 0);
};

const cacheDirective = (member: string): { name: string; argument?: string } | null => {
    const equals = member.indexOf("=");
    const name = member.slice(0, equals < 0 ? undefined : equals).trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) return null;
    if (equals < 0) return { name };
    return { name, argument: member.slice(equals + 1).trim() };
};

const deltaMilliseconds = (argument: string | undefined): number | null => {
    if (argument === undefined) return null;
    const match = /^(?:([0-9]+)|"([0-9]+)")$/.exec(argument);
    const digits = match?.[1] ?? match?.[2];
    if (digits === undefined) return null;
    const seconds = BigInt(digits);
    return Number(seconds > DELTA_SECONDS_LIMIT ? DELTA_SECONDS_LIMIT : seconds) * 1000;
};

const lastHeaderValue = (header: string, name: string): string | undefined => {
    const lines = header.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        const colon = line.indexOf(":");
        if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== name) continue;
        return line.slice(colon + 1).trim();
    }
    return undefined;
};

const entityTag = (value: string): EntityTag | null => {
    const match = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(value);
    return match === null
        ? null
        : { weak: match[1] !== undefined, opaque: match[2] };
};

const MONTHS: readonly string[] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const IMF_FIXDATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const RFC850_DATE = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const ASCTIME_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: ([0-9])|([0-9]{2})) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;

const utcHttpDate = (
    weekday: string,
    day: string,
    month: string,
    year: number,
    hour: string,
    minute: string,
    second: string,
): number | null => {
    const monthIndex = MONTHS.indexOf(month);
    const weekdayIndex = WEEKDAYS.indexOf(weekday.slice(0, 3));
    const numericDay = Number(day);
    const numericHour = Number(hour);
    const numericMinute = Number(minute);
    const numericSecond = Number(second);
    if (monthIndex < 0 || weekdayIndex < 0) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, monthIndex, numericDay);
    date.setUTCHours(numericHour, numericMinute, numericSecond, 0);
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === monthIndex
        && date.getUTCDate() === numericDay
        && date.getUTCHours() === numericHour
        && date.getUTCMinutes() === numericMinute
        && date.getUTCSeconds() === numericSecond
        && date.getUTCDay() === weekdayIndex
        ? date.getTime()
        : null;
};

const httpDate = (value: string, now = Date.now()): number | null => {
    const preferred = IMF_FIXDATE.exec(value);
    if (preferred !== null) {
        return utcHttpDate(
            preferred[1],
            preferred[2],
            preferred[3],
            Number(preferred[4]),
            preferred[5],
            preferred[6],
            preferred[7],
        );
    }
    const rfc850 = RFC850_DATE.exec(value);
    if (rfc850 !== null) {
        let year = 2000 + Number(rfc850[4]);
        if (year > new Date(now).getUTCFullYear() + 50) year -= 100;
        return utcHttpDate(
            rfc850[1],
            rfc850[2],
            rfc850[3],
            year,
            rfc850[5],
            rfc850[6],
            rfc850[7],
        );
    }
    const asctime = ASCTIME_DATE.exec(value);
    return asctime === null
        ? null
        : utcHttpDate(
            asctime[1],
            asctime[3] ?? asctime[4],
            asctime[2],
            Number(asctime[8]),
            asctime[5],
            asctime[6],
            asctime[7],
        );
};

// {§revalidation} The body and header must have settled successfully. An
// auxiliary channel may have terminally failed without invalidating body.
const representationComplete = (entry: StoredEntryData): boolean => {
    const bodyState = entry.channels[BODY]?.state;
    const headerState = entry.channels[HEADER]?.state;
    const successful = (state: ChannelState | undefined): boolean => state === "static" || state === "closed";
    const terminal = (state: ChannelState): boolean => successful(state) || state === "errored";
    return successful(bodyState)
        && successful(headerState)
        && Object.values(entry.channels).every(({ state }) => terminal(state));
};

// Package metadata is appended after origin headers, so the last value wins.
const fetchedAt = (priorHeader: string): number | undefined => {
    const value = lastHeaderValue(priorHeader, FETCHED_AT);
    if (value === undefined) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
};

const headerField = (line: string): HeaderField | null => {
    const colon = line.indexOf(":");
    if (colon < 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name.length === 0) return null;
    return { name, value: line.slice(colon + 1).trim(), line };
};

const packageStart = (lines: readonly string[]): number => {
    let stampIndex = -1;
    for (const [index, line] of lines.entries()) {
        if (headerField(line)?.name === FETCHED_AT) stampIndex = index;
    }
    if (stampIndex < 0) return lines.length;
    return headerField(lines[stampIndex - 1] ?? "")?.name === REQUEST_METHOD
        ? stampIndex - 1
        : stampIndex;
};

const originFields = (header: string): HeaderField[] => {
    const lines = header.split(/\r?\n/);
    return lines.slice(1, packageStart(lines))
        .map((line) => headerField(line))
        .filter((field): field is HeaderField => field !== null);
};

const originValues = (fields: readonly HeaderField[], name: string): string[] =>
    fields.filter((field) => field.name === name).map(({ value }) => value);

const storedCachePolicy = (header: string): StoredCachePolicy => {
    const fields = originFields(header);
    const directives = originValues(fields, "cache-control")
        .flatMap((value) => splitHttpList(value))
        .map((member) => cacheDirective(member))
        .filter((directive): directive is NonNullable<typeof directive> => directive !== null);
    const sharedMaxAges = directives.filter(({ name }) => name === "s-maxage");
    const maxAges = sharedMaxAges.length > 0 ? sharedMaxAges
        : directives.filter(({ name }) => name === "max-age");
    let freshnessLifetimeMs: number | undefined;
    if (maxAges.length > 0) {
        freshnessLifetimeMs = maxAges.length === 1
            ? deltaMilliseconds(maxAges[0].argument) ?? 0
            : 0;
    } else {
        const expiresValues = originValues(fields, "expires");
        if (expiresValues.length > 0) {
            const expires = expiresValues.length === 1
                ? httpDate(expiresValues[0])
                : null;
            const fetched = fetchedAt(header);
            if (expires === null || fetched === undefined) {
                freshnessLifetimeMs = 0;
            } else {
                const dateValues = originValues(fields, "date");
                const parsedDate = dateValues.length === 1
                    ? httpDate(dateValues[0])
                    : null;
                const generatedAt = parsedDate ?? fetched;
                freshnessLifetimeMs = Math.max(0, expires - generatedAt);
            }
        }
    }
    const status = Number(/^HTTP ([0-9]{3})(?:\s|$)/.exec(header)?.[1]);
    const explicitPermission = freshnessLifetimeMs !== undefined
        || directives.some(({ name, argument }) => name === "public" && argument === undefined);
    return {
        cacheable: status >= 200 && status <= 599 && status !== 206
            && !directives.some(({ name }) => name === "no-store" || name === "private")
            && (HEURISTIC_CACHE_STATUSES.has(status) || explicitPermission),
        noCache: directives.some(({ name }) => name === "no-cache"),
        ...(freshnessLifetimeMs === undefined ? {} : { freshnessLifetimeMs }),
    };
};

const currentAge = (header: string, fetched: number, now: number): number => {
    const fields = originFields(header);
    const dateValues = originValues(fields, "date");
    const date = dateValues.length === 1 ? httpDate(dateValues[0]) : null;
    const apparentAge = date === null ? 0 : Math.max(0, fetched - date);
    const ageMember = originValues(fields, "age").flatMap(splitHttpList)[0];
    const ageValue = deltaMilliseconds(ageMember) ?? 0;
    return Math.max(apparentAge, ageValue) + Math.max(0, now - fetched);
};

// {§revalidation} Validation-free reuse requires both the operator's local
// ceiling and the origin's response policy to remain live.
export const fresh = (header: string, now = Date.now()): boolean => {
    const fetched = fetchedAt(header);
    const ttl = requireNumEnv("PLURNK_SCHEMES_HTTP_TTL_MS");
    if (fetched === undefined || ttl <= 0) return false;
    const residentTime = Math.max(0, now - fetched);
    if (residentTime >= ttl) return false;
    const policy = storedCachePolicy(header);
    if (!policy.cacheable || policy.noCache) return false;
    return policy.freshnessLifetimeMs === undefined
        || currentAge(header, fetched, now) < policy.freshnessLifetimeMs;
};

export const requestMethod = (priorHeader: string): string | undefined =>
    lastHeaderValue(priorHeader, REQUEST_METHOD)?.toUpperCase();

// Package evidence is authoritative only after the package acquisition
// stamp. An origin field with the same name remains inert.
const packageHeaderValue = (priorHeader: string, field: string): string | undefined => {
    const lines = priorHeader.split(/\r?\n/);
    let stampIndex = -1;
    for (const [index, line] of lines.entries()) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        if (name === FETCHED_AT) stampIndex = index;
    }
    if (stampIndex < 0) return undefined;
    let value: string | undefined;
    for (const line of lines.slice(stampIndex + 1)) {
        const colon = line.indexOf(":");
        if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== field) continue;
        value = line.slice(colon + 1).trim();
    }
    return value === "" ? undefined : value;
};

const projectionIdentity = (priorHeader: string): string | undefined =>
    packageHeaderValue(priorHeader, PROJECTION_ID_HEADER);

export const materializerIdentity = (priorHeader: string): string | undefined =>
    packageHeaderValue(priorHeader, MATERIALIZER_ID_HEADER);

export const sourceMimetype = (header: string): string =>
    responseMimetype(lastHeaderValue(header, "content-type") ?? null);

const projectionCurrent = async (header: string, projection: ProjectionCaps): Promise<boolean> => {
    const sourceMime = sourceMimetype(header);
    const isHtml = MimetypeClassifier.isHtml(sourceMime);
    const matIdentity = materializerIdentity(header);
    if (matIdentity !== undefined) {
        // {§http-lifecycle} — a stored body produced by the current
        // configured materializer (or the built-in producers) is current.
        return WebFetcher.materializerCurrent(matIdentity);
    }
    if (isHtml && matIdentity === undefined) return false;
    const storedIdentity = projectionIdentity(header);
    if (storedIdentity === undefined) return !isHtml;
    return await projection.identity(sourceMime) === storedIdentity;
};

// {§revalidation} Direct READ and exact FIND share the complete reusable
// representation predicate; freshness only decides how READ uses a match.
export const reusableGetRepresentation = async (
    entry: StoredEntryData,
    requestHeaders: ReadonlyArray<readonly [string, string]>,
    projection: ProjectionCaps,
): Promise<boolean> => {
    const body = entry.channels[BODY];
    const header = entry.channels[HEADER];
    if (body === undefined || header === undefined) return false;
    return representationComplete(entry)
        && requestMethod(header.content) === "GET"
        && requestHeaders.length === 0
        && packageHeaderValue(header.content, CACHE_VARIANT_HEADER) === "default"
        && storedCachePolicy(header.content).cacheable
        && await projectionCurrent(header.content, projection);
};

// RFC 9111 §3.2 permits a processed cache to retain the metadata that its
// stored body depends upon. Other 304 fields update by name; package-owned
// evidence is then rebuilt after the origin block. {§revalidation}
export const refreshAfter304 = (
    header: string,
    responseHeaders: ReadonlyArray<readonly [string, string]>,
    requestHeaders: ReadonlyArray<readonly [string, string]>,
): string => {
    const lines = header.split(/\r?\n/);
    const origin = originFields(header);
    const updates = responseHeaders.filter(
        ([name]) => !BODY_PROCESSING_FIELDS.has(name.toLowerCase()),
    );
    const updatedNames = new Set(updates.map(([name]) => name.toLowerCase()));
    const retained = origin.filter(({ name }) => !updatedNames.has(name));
    const merged: Array<readonly [string, string]> = [
        ...retained.map(({ name, value }) => [name, value] as const),
        ...updates,
    ];
    const rebuilt = [MATERIALIZER_ID_HEADER, PROJECTION_ID_HEADER].flatMap((field) => {
        const value = packageHeaderValue(header, field);
        return value === undefined ? [] : [`${field}: ${value}`];
    });
    const frameworkOwned = new Set([
        CACHE_VARIANT_HEADER.toLowerCase(),
        MATERIALIZER_ID_HEADER.toLowerCase(),
        PROJECTION_ID_HEADER.toLowerCase(),
        REQUEST_METHOD.toLowerCase(),
        FETCHED_AT.toLowerCase(),
    ]);
    const packageEvidence = [
        ...rebuilt,
        ...lines.slice(1).filter((line) => {
            const colon = line.indexOf(":");
            if (colon <= 0) return false;
            const name = line.slice(0, colon).toLowerCase();
            return name.startsWith("x-plurnk-")
                && !frameworkOwned.has(name)
                && !updatedNames.has(name);
        }),
    ];
    return [
        lines[0] ?? "HTTP 200 OK",
        ...retained.map(({ line }) => line),
        ...updates.map(([name, value]) => `${name}: ${value}`),
        `${REQUEST_METHOD}: GET`,
        `${FETCHED_AT}: ${new Date().toISOString()}`,
        cacheVariantEvidence(classifyCacheVariant(requestHeaders, merged)),
        ...packageEvidence,
    ].join("\n");
};

export const revalidationCorresponds = (priorHeader: string, responseHeaders: Headers): boolean => {
    const fields = originFields(priorHeader);
    const responseTagValue = responseHeaders.get("etag");
    if (responseTagValue !== null) {
        const storedTagValues = originValues(fields, "etag");
        const responseTag = entityTag(responseTagValue);
        const storedTag = storedTagValues.length === 1
            ? entityTag(storedTagValues[0])
            : null;
        if (responseTag === null || storedTag === null) return false;
        // {§revalidation}: RFC 9111 §4.3.4 identifies stored responses;
        // it is not the origin's If-None-Match precondition comparison.
        return responseTag.opaque === storedTag.opaque
            && (responseTag.weak || !storedTag.weak);
    }

    const responseModifiedValue = responseHeaders.get("last-modified");
    const storedModifiedValues = originValues(fields, "last-modified");
    const responseModified = responseModifiedValue === null
        ? null
        : httpDate(responseModifiedValue);
    const storedModified = storedModifiedValues.length === 1
        ? httpDate(storedModifiedValues[0])
        : null;
    return responseModified !== null
        && storedModified !== null
        && responseModified === storedModified;
};

export const validators = (priorHeader: string): Array<[string, string]> => {
    const fields = originFields(priorHeader);
    const out: Array<[string, string]> = [];
    const etags = originValues(fields, "etag");
    if (etags.length === 1 && entityTag(etags[0]) !== null) {
        out.push(["If-None-Match", etags[0]]);
    }
    const lastModified = originValues(fields, "last-modified");
    if (lastModified.length === 1 && httpDate(lastModified[0]) !== null) {
        out.push(["If-Modified-Since", lastModified[0]]);
    }
    return out;
};
