// {§schedule-rule} — the runtime's Temporal object (Node 26 ships it globally). TypeScript's
// libraries do not declare it yet, so the package types it through the recurrence library's own
// Temporal surface and refuses to load on a runtime without it.
import type { TemporalImplementation, TemporalZonedDateTime } from "rrule-temporal";

interface TemporalRuntime extends TemporalImplementation {
    readonly Instant: {
        fromEpochMilliseconds(epochMilliseconds: number): {
            toZonedDateTimeISO(timeZone: string): TemporalZonedDateTime;
        };
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
