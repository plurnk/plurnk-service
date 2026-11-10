// {§schedule-rule} — a rule is RFC 5545 text or a 5-field cron expression: an optional DTSTART line
// and one RRULE or 5-field cron line (bare `FREQ=…` parts are the RRULE line), with EXDATE/RDATE
// lines admitted. The recurrence library owns the grammar and the expansion; this module normalizes
// 5-field cron to RRULE and refuses what the library is lenient about — unknown RRULE parts, extra
// lines, and a DTSTART the effective zone must stamp ({§schedule-rule}).
import { RRuleTemporal, type TemporalZonedDateTime } from "rrule-temporal";
import { toText } from "rrule-temporal/totext";
import { zoned } from "./temporal.ts";

const RRULE_PARTS = new Set([
    "FREQ", "UNTIL", "COUNT", "INTERVAL", "BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY",
    "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST",
]);
const DTSTART = /^DTSTART(?:;TZID=([^:]+))?:(\d{8}T\d{6})(Z?)$/u;
const RRULE = /^(?:RRULE:)?([A-Z]+=[^;=]+(?:;[A-Z]+=[^;=]+)*)$/u;
const DATE_LIST = /^(?:EXDATE|RDATE)(?:;[^:]+)?:.+$/u;

const MONTH_NAMES: Readonly<Record<string, number>> = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const DOW_NAMES: Readonly<Record<string, number>> = {
    SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
    SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};
const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

export type ScheduleRuleCode = "rule-invalid" | "zone-unknown";

export class ScheduleRuleError extends Error {
    readonly code: ScheduleRuleCode;

    constructor(code: ScheduleRuleCode, detail: string, cause?: unknown) {
        super(detail, cause === undefined ? undefined : { cause });
        this.name = "ScheduleRuleError";
        this.code = code;
    }
}

export interface ParsedRule {
    // The canonical text as stored: `DTSTART;TZID=<zone>:<local>`, `RRULE:<parts>`, any date lists.
    readonly text: string;
    readonly zone: string;
    readonly rule: RRuleTemporal;
}

interface RuleLines {
    readonly dtstart: RegExpExecArray | null;
    readonly rrule: string;
    readonly dateLists: readonly string[];
}

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const invalid = (detail: string, cause?: unknown): ScheduleRuleError =>
    new ScheduleRuleError("rule-invalid", `The rule is not a readable RFC 5545 recurrence: ${detail}.`, cause);

const parseCronAtom = (
    raw: string,
    min: number,
    max: number,
    names?: Readonly<Record<string, number>>,
): number => {
    const upper = raw.toUpperCase();
    if (names !== undefined && Object.hasOwn(names, upper)) return names[upper];
    if (!/^\d+$/u.test(raw)) throw invalid(`invalid cron field value '${raw}'`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
        throw invalid(`cron field value '${raw}' is outside ${min}..${max}`);
    }
    return n;
};

const parseCronField = (
    field: string,
    min: number,
    max: number,
    names?: Readonly<Record<string, number>>,
    wrapSevenToZero = false,
): number[] | null => {
    if (field === "*") return null;
    const values = new Set<number>();
    for (const part of field.split(",")) {
        if (part.length === 0) throw invalid(`empty item in cron field '${field}'`);
        const slashParts = part.split("/");
        if (slashParts.length > 2) throw invalid(`malformed step in cron field '${field}'`);
        const rangePart = slashParts[0];
        const stepPart = slashParts.length === 2 ? slashParts[1] : undefined;
        let step = 1;
        if (stepPart !== undefined) {
            if (!/^[1-9]\d*$/u.test(stepPart)) throw invalid(`invalid step '${stepPart}' in cron field '${field}'`);
            step = Number(stepPart);
        }
        let start: number;
        let end: number;
        if (rangePart === "*") {
            start = min;
            end = wrapSevenToZero ? 6 : max;
        } else if (rangePart.includes("-")) {
            const bounds = rangePart.split("-");
            if (bounds.length !== 2 || bounds[0].length === 0 || bounds[1].length === 0) {
                throw invalid(`malformed range '${rangePart}' in cron field '${field}'`);
            }
            start = parseCronAtom(bounds[0], min, max, names);
            end = parseCronAtom(bounds[1], min, max, names);
            if (start > end) throw invalid(`cron range '${rangePart}' has start > end`);
        } else {
            const atom = parseCronAtom(rangePart, min, max, names);
            start = atom;
            end = stepPart !== undefined ? (wrapSevenToZero ? 6 : max) : atom;
        }
        for (let v = start; v <= end; v += step) {
            values.add(wrapSevenToZero && v === 7 ? 0 : v);
        }
    }
    const distinctMax = wrapSevenToZero ? 7 : max - min + 1;
    if (values.size === distinctMax) return null;
    return [...values].toSorted((a, b) => a - b);
};

const cronToRrule = (line: string): string | null => {
    const fields = line.split(/\s+/u);
    if (fields.length !== 5) return null;
    const minField = fields[0];
    const hourField = fields[1];
    const domField = fields[2];
    const monthField = fields[3];
    const dowField = fields[4];
    const minutes = parseCronField(minField, 0, 59);
    const hours = parseCronField(hourField, 0, 23);
    const doms = parseCronField(domField, 1, 31);
    const months = parseCronField(monthField, 1, 12, MONTH_NAMES);
    const dows = parseCronField(dowField, 0, 7, DOW_NAMES, true);

    const freq =
        minutes === null
            ? "MINUTELY"
            : hours === null
              ? "HOURLY"
              : doms === null && dows === null && months === null
                ? "DAILY"
                : dows !== null && doms === null && months === null
                  ? "WEEKLY"
                  : doms !== null && dows === null && months === null
                    ? "MONTHLY"
                    : months !== null && doms !== null && dows === null
                      ? "YEARLY"
                      : "DAILY";

    const parts: string[] = [`FREQ=${freq}`];
    if (months !== null) parts.push(`BYMONTH=${months.join(",")}`);
    if (doms !== null) parts.push(`BYMONTHDAY=${doms.join(",")}`);
    if (dows !== null) parts.push(`BYDAY=${dows.map((d) => ICAL_DAYS[d]).join(",")}`);
    if (hours !== null) parts.push(`BYHOUR=${hours.join(",")}`);
    if (minutes !== null) parts.push(`BYMINUTE=${minutes.join(",")}`);
    parts.push("BYSECOND=0");
    return parts.join(";");
};

// The rule's lines, checked by name: the library drops unknown RRULE parts and extra RRULE lines
// silently, and the DTSTART form decides how the zone applies.
const readLines = (text: string): RuleLines => {
    let dtstart: RegExpExecArray | null = null;
    let rrule: string | null = null;
    const dateLists: string[] = [];
    for (const line of text.split(/\r?\n/u).map((raw) => raw.trim()).filter((raw) => raw.length > 0)) {
        const start = DTSTART.exec(line);
        if (start !== null) {
            if (dtstart !== null) throw invalid("it carries more than one DTSTART");
            dtstart = start;
            continue;
        }
        if (DATE_LIST.test(line)) {
            dateLists.push(line);
            continue;
        }
        const match = RRULE.exec(line);
        if (match !== null) {
            if (rrule !== null) throw invalid("it carries more than one RRULE");
            const unknown = match[1].split(";").map((part) => part.split("=")[0]).filter((name) => !RRULE_PARTS.has(name));
            if (unknown.length > 0) throw invalid(`RRULE has no part named ${unknown.join(", ")}`);
            rrule = match[1]!;
            continue;
        }
        const cronRrule = cronToRrule(line);
        if (cronRrule === null) {
            throw invalid(`the line '${line}' is neither DTSTART, RRULE, a 5-field cron expression, EXDATE nor RDATE`);
        }
        if (rrule !== null) throw invalid("it carries more than one RRULE");
        rrule = cronRrule;
    }
    if (rrule === null) throw invalid("it has no RRULE line");
    return { dtstart, rrule, dateLists };
};

export const assertZone = (zone: string): void => {
    try {
        zoned(0, zone);
    } catch (cause) {
        throw new ScheduleRuleError("zone-unknown", `'${zone}' is not a time zone the runtime knows; use an IANA name.`, cause);
    }
};

const fromRule = (rule: RRuleTemporal): ParsedRule => {
    const options = rule.options();
    if (options.tzid === undefined) throw new Error("the recurrence library resolved a rule without a zone");
    return {
        text: rule.toString(),
        zone: options.tzid,
        rule,
    };
};

// Canonical text back into a rule; the text is the family's own, so a failure is a defect.
export const parseRule = (text: string): ParsedRule => {
    try {
        return fromRule(new RRuleTemporal({ rruleString: text, strict: true }));
    } catch (cause) {
        throw invalid(messageOf(cause), cause);
    }
};

// Authored text into a canonical rule. Without a DTSTART the rule starts at the next whole second
// in the effective zone, so its first occurrence is still ahead; a floating DTSTART is read in that
// zone; a zoned or UTC DTSTART keeps its own.
export const normalizeRule = (text: string, zone: string, nowMs: number): ParsedRule => {
    assertZone(zone);
    const { dtstart, rrule, dateLists } = readLines(text);
    if (dtstart?.[1] !== undefined) assertZone(dtstart[1]);
    let rule: RRuleTemporal;
    try {
        if (dtstart === null) {
            const start = zoned(nowMs, zone).round({ smallestUnit: "second", roundingMode: "floor" }).add({ seconds: 1 });
            rule = new RRuleTemporal({ rruleString: [`RRULE:${rrule}`, ...dateLists].join("\n"), dtstart: start, strict: true });
        } else {
            const floating = dtstart[1] === undefined && dtstart[3] === "";
            rule = new RRuleTemporal({
                rruleString: [dtstart[0], `RRULE:${rrule}`, ...dateLists].join("\n"),
                ...(floating ? { tzid: zone } : {}),
                strict: true,
            });
        }
    } catch (cause) {
        throw invalid(messageOf(cause), cause);
    }
    return parseRule(rule.toString());
};

// The first occurrence strictly after an instant; null once the rule is exhausted.
export const nextOccurrence = (parsed: ParsedRule, afterMs: number): TemporalZonedDateTime | null =>
    parsed.rule.next(zoned(afterMs, parsed.zone)) ?? null;

export const upcoming = (parsed: ParsedRule, afterMs: number, limit: number): TemporalZonedDateTime[] => {
    const occurrences: TemporalZonedDateTime[] = [];
    let cursor: TemporalZonedDateTime = zoned(afterMs, parsed.zone);
    while (occurrences.length < limit) {
        const next = parsed.rule.next(cursor);
        if (next === null || next === undefined) break;
        occurrences.push(next);
        cursor = next;
    }
    return occurrences;
};

// The rule in words; the zone abbreviation is left out because the zone is named beside it.
export const describeRule = (parsed: ParsedRule): string => toText(parsed.rule, undefined, { excludeTzAbbreviation: true });
