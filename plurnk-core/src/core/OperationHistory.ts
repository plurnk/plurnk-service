import TurnOps from "./TurnOps.ts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import type PacketWire from "./packet-wire.ts";
import type { ReplayedOperation } from "./packet-wire.ts";

type Entry = ReturnType<typeof PacketWire.entryView>;
export interface EmissionProgram { id: number; content: string; executors: string }

// {§emission-history}: durable ordinals join requests to receipts; text is never an identity.
export default class OperationHistory {
    static project(entries: readonly Entry[], programs: readonly EmissionProgram[]): {
        operations: Map<string, string>;
        paired: Map<string, ReplayedOperation>;
    } {
        const byId = new Map(programs.map((program) => [program.id, program]));
        const byTurn = new Map(entries.flatMap((entry) => {
            const program = typeof entry.id === "number" ? byId.get(entry.id) : undefined;
            return program === undefined ? [] : [[OperationHistory.#turn(entry),
                TurnOps.parseInternal(program.content, { executors: JSON.parse(program.executors) as string[] })] as const];
        }));
        const operations = new Map<string, string>();
        const paired = new Map<string, ReplayedOperation>();
        const seen = new Set<string>();
        for (const entry of entries) {
            const program = byTurn.get(OperationHistory.#turn(entry));
            if (program === undefined || entry.origin !== "model") continue;
            const attrs = entry.attrs as { emissionIndex?: unknown } | null;
            const ordinal = attrs?.emissionIndex;
            if (ordinal === undefined) continue;
            if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0 || program[ordinal] === undefined) {
                throw new Error("A receipt's content ordinal must address its frozen emission.");
            }
            const body = LogBody.resolve({ op: typeof entry.op === "string" ? entry.op : null, attrs: entry.attrs, tx: entry.tx, rx: entry.rx });
            if (body.provenance === "authored" && LogVisibility.parse(entry.folded).length > 0) continue;
            const coordinate = String(entry.coordinate);
            const statement = program[ordinal]!;
            paired.set(coordinate, { statement, tokens: 0 });
            const key = `${OperationHistory.#turn(entry)}/${ordinal}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const replay = statement.op === "KILL" && statement.target?.kind === "url" && statement.target.scheme === "log"
                ? { ...statement, body: null } : statement;
            operations.set(coordinate, TurnOps.renderEmission([replay]));
        }
        return { operations, paired };
    }

    static #turn(entry: Entry): string {
        return String(entry.coordinate).split("/").slice(0, 2).join("/");
    }
}
