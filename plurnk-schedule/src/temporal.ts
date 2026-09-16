// {§schedule-zone} — the runtime's Temporal object (Node 26 ships it globally). TypeScript's
// libraries do not declare it yet, so the package types it through the recurrence library's own
// Temporal surface and refuses to load on a runtime without it.
import type { TemporalImplementation, TemporalZonedDateTime } from "rrule-temporal";

export interface TemporalRuntime extends TemporalImplementation<TemporalZonedDateTime> {
    readonly Instant: {
        fromEpochMilliseconds(epochMilliseconds: number): {
            toZonedDateTimeISO(timeZone: string): TemporalZonedDateTime;
        };
    };
}

const runtime = (globalThis as unknown as { Temporal?: TemporalRuntime }).Temporal;
if (runtime === undefined) throw new Error("@plurnk/plurnk-schedule requires a runtime with Temporal (Node 26 or later).");

export default runtime;

// One instant read in one IANA zone; an unknown zone is the runtime's RangeError.
export const zoned = (epochMilliseconds: number, zone: string): TemporalZonedDateTime =>
    runtime.Instant.fromEpochMilliseconds(epochMilliseconds).toZonedDateTimeISO(zone);

// The wire form of an occurrence: RFC 9557 with the zone name, to the second.
export const isoString = (moment: TemporalZonedDateTime): string => moment.toString({ smallestUnit: "second" });
