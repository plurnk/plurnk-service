// {§schedule-rule} — a rule is RFC 5545 text: an optional DTSTART line and one RRULE line (bare
// `FREQ=…` parts are the RRULE line), with EXDATE/RDATE lines admitted. The recurrence library
// owns the grammar and the expansion; this module owns what the library is lenient about — unknown
// RRULE parts, extra lines, a DTSTART the effective zone must stamp ({§schedule-zone}) — and the
// bound a workspace rule must carry ({§schedule-bound}).
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

export type ScheduleRuleCode = "rule-invalid" | "rule-unbounded" | "zone-unknown";

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
    readonly bounded: boolean;
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
        if (match === null) throw invalid(`the line '${line}' is neither DTSTART, RRULE, EXDATE nor RDATE`);
        if (rrule !== null) throw invalid("it carries more than one RRULE");
        const unknown = match[1]!.split(";").map((part) => part.split("=")[0]!).filter((name) => !RRULE_PARTS.has(name));
        if (unknown.length > 0) throw invalid(`RRULE has no part named ${unknown.join(", ")}`);
        rrule = match[1]!;
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
        bounded: options.count !== undefined || options.until !== undefined,
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
