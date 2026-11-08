import TurnOps from "./TurnOps.ts";
import { isRecord } from "@plurnk/plurnk-contracts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import type PacketWire from "./packet-wire.ts";
import type { ReplayedOperation } from "./packet-wire.ts";

type Entry = ReturnType<typeof PacketWire.entryView>;
export interface EmissionProgram { id: number; content: string; executors: string; kills?: string }

// {§emission-history}: durable ordinals join requests to receipts; text is never an identity. A turn's
// surviving operations replay together, in program order, immediately after its emission row.
export default class OperationHistory {
    static project(entries: readonly Entry[], programs: readonly EmissionProgram[]): {
        operations: Map<string, string>;
        paired: Map<string, ReplayedOperation>;
        turns: Map<string, string>;
    } {
        const byId = new Map(programs.map((program) => [program.id, program]));
        const byTurn = new Map(entries.flatMap((entry) => {
            const program = typeof entry.id === "number" ? byId.get(entry.id) : undefined;
            return program === undefined ? [] : [[OperationHistory.#turn(entry), {
                coordinate: String(entry.coordinate),
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§db-migrations}: a frozen emission's executors are read back as the row stored them
                program: TurnOps.parseInternal(program.content, { executors: JSON.parse(program.executors) as string[] }),
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§emission-history}: active log-kill ordinals come from json_group_array
                kills: program.kills === undefined ? [] : JSON.parse(program.kills) as unknown[],
            }] as const];
        }));
        const operations = new Map<string, string>();
        const paired = new Map<string, ReplayedOperation>();
        const replayed = new Map<string, Array<{ ordinal: number; text: string }>>();
        const seen = new Set<string>();
        const resolveStatement = (program: ReturnType<typeof TurnOps.parseInternal>, ordinal: unknown) => {
            if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0 || program[ordinal] === undefined) {
                throw new Error("A receipt's content ordinal must address its frozen emission.");
            }
            const statement = program[ordinal];
            const replay = statement.op === "kill" && statement.target?.kind === "url" && statement.target.scheme === "log"
                ? { ...statement, body: null } : statement;
            return { ordinal, text: TurnOps.renderEmission([replay]) };
        };
        for (const entry of entries) {
            const turn = OperationHistory.#turn(entry);
            const emission = byTurn.get(turn);
            if (emission === undefined || (entry.origin !== "model" && entry.origin !== "_plurnk") || entry.source != null) continue;
            const rawOrdinal = isRecord(entry.attrs) ? entry.attrs.emissionIndex : undefined;
            if (rawOrdinal === undefined) continue;
            const { ordinal, text } = resolveStatement(emission.program, rawOrdinal);
            const body = LogBody.resolve({ op: typeof entry.op === "string" ? entry.op : null, attrs: entry.attrs, tx: entry.tx, rx: entry.rx });
            if (body.provenance === "authored" && LogVisibility.parse(entry.folded).length > 0) continue;
            const coordinate = String(entry.coordinate);
            paired.set(coordinate, { tokens: 0 });
            const key = `${turn}/${ordinal}`;
            if (seen.has(key)) continue;
            seen.add(key);
            operations.set(coordinate, text);
            if (!replayed.has(turn)) replayed.set(turn, []);
            replayed.get(turn)!.push({ ordinal, text });
        }
        for (const [turn, { program, kills }] of byTurn) {
            for (const rawOrdinal of kills) {
                const { ordinal, text } = resolveStatement(program, rawOrdinal);
                const key = `${turn}/${ordinal}`;
                if (seen.has(key)) continue;
                seen.add(key);
                if (!replayed.has(turn)) replayed.set(turn, []);
                replayed.get(turn)!.push({ ordinal, text });
            }
        }
        const turns = new Map([...replayed.entries()].map(([turn, turnOperations]) =>
            [byTurn.get(turn)!.coordinate, turnOperations.toSorted((left, right) => left.ordinal - right.ordinal).map(({ text }) => text).join("\n\n")]));
        return { operations, paired, turns };
    }

    static #turn(entry: Entry): string {
        return String(entry.coordinate).split("/").slice(0, 2).join("/");
    }
}
