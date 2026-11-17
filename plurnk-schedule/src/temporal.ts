// {§schedule-rule} — the runtime's Temporal object (Node 26 ships it globally). TypeScript's
// libraries do not declare it yet, so the package types it through the recurrence library's own
// Temporal surface and refuses to load on a runtime without it.
import type { TemporalImplementation, TemporalZonedDateTime } from "rrule-temporal";

interface TemporalDuration {
    readonly sign: number;
}

interface TemporalInstant {
    readonly epochMilliseconds: number;
    toZonedDateTimeISO(timeZone: string): TemporalZonedDateTime;
}

interface TemporalPlainDateTime {
    toZonedDateTime(timeZone: string): TemporalZonedDateTime;
}

interface TemporalRuntime extends TemporalImplementation {
    readonly Instant: {
        from(item: string): TemporalInstant;
        fromEpochMilliseconds(epochMilliseconds: number): TemporalInstant;
    };
    readonly Duration: {
        from(item: string | Readonly<Record<string, number>>): TemporalDuration;
    };
    readonly ZonedDateTime: {
        from(item: string): TemporalZonedDateTime;
    };
    readonly PlainDateTime: {
        from(item: string): TemporalPlainDateTime;
    };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime's Temporal is the TC39 object; its shape is the proposal's, which Node's typings do not yet declare
const runtime = (globalThis as unknown as { Temporal?: TemporalRuntime }).Temporal;
if (runtime === undefined) throw new Error("@plurnk/plurnk-schedule requires a runtime with Temporal (Node 26 or later).");

// One instant read in one IANA zone; an unknown zone is the runtime's RangeError.
export const zoned = (epochMilliseconds: number, zone: string): TemporalZonedDateTime =>
    runtime.Instant.fromEpochMilliseconds(epochMilliseconds).toZonedDateTimeISO(zone);

// The wire form of an occurrence: RFC 9557 with the zone name, to the second.
export const isoString = (moment: TemporalZonedDateTime): string => moment.toString({ smallestUnit: "second" });

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

export const formatIcalLocal = (moment: TemporalZonedDateTime): string =>
    `${pad(moment.year, 4)}${pad(moment.month)}${pad(moment.day)}T${pad(moment.hour)}${pad(moment.minute)}${pad(moment.second)}`;

const SHORTHAND_DURATION = /^\+(\d+)\s*([smhdw])$/iu;
const ISO_DURATION = /^[+-]?P(?=\d|T\d)/iu;
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?(?:\[([^\]]+)\])?$/u;

export const parseDurationTarget = (
    raw: string,
    zone: string,
    nowMs: number,
): TemporalZonedDateTime | null => {
    const shorthand = SHORTHAND_DURATION.exec(raw);
    if (shorthand !== null) {
        const count = Number(shorthand[1]);
        if (!Number.isSafeInteger(count) || count <= 0) {
            throw new RangeError(`Duration '${raw}' must be a positive integer offset.`);
        }
        const unit = shorthand[2].toLowerCase();
        const delta =
            unit === "s" ? { seconds: count }
            : unit === "m" ? { minutes: count }
            : unit === "h" ? { hours: count }
            : unit === "d" ? { days: count }
            : { weeks: count };
        const base = zoned(nowMs, zone).round({ smallestUnit: "second", roundingMode: "floor" });
        return base.add(delta);
    }
    if (ISO_DURATION.test(raw)) {
        const duration = runtime.Duration.from(raw);
        if (duration.sign <= 0) {
            throw new RangeError(`Duration '${raw}' must be strictly positive.`);
        }
        const base = zoned(nowMs, zone).round({ smallestUnit: "second", roundingMode: "floor" });
        return base.add(raw);
    }
    return null;
};

export const parseInstantTarget = (
    raw: string,
    zone: string,
): { readonly kind: "matched"; readonly moment: TemporalZonedDateTime } | { readonly kind: "unmatched" } => {
    const match = ISO_DATETIME.exec(raw);
    if (match === null) return { kind: "unmatched" };
    const datePart = match[1];
    const rawTime = match[2];
    const timePart = rawTime.split(":").length === 2 ? `${rawTime}:00` : rawTime;
    const offsetPart = match[3] ?? "";
    const bracketZone = match[4];
    if (bracketZone !== undefined) {
        zoned(0, bracketZone);
        const full = `${datePart}T${timePart}${offsetPart}[${bracketZone}]`;
        return {
            kind: "matched",
            moment: runtime.ZonedDateTime.from(full).round({ smallestUnit: "second", roundingMode: "floor" }),
        };
    }
    if (offsetPart !== "") {
        const targetZone = offsetPart === "Z" ? "UTC" : zone;
        const instant = runtime.Instant.from(`${datePart}T${timePart}${offsetPart}`);
        return {
            kind: "matched",
            moment: instant.toZonedDateTimeISO(targetZone).round({ smallestUnit: "second", roundingMode: "floor" }),
        };
    }
    return {
        kind: "matched",
        moment: runtime.PlainDateTime.from(`${datePart}T${timePart}`)
            .toZonedDateTime(zone)
            .round({ smallestUnit: "second", roundingMode: "floor" }),
    };
};
