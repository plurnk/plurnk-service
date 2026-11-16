import { PlurnkParser } from "@plurnk/plurnk-parser";
import { isRecord } from "@plurnk/plurnk-contracts";
import type { WireToolCall } from "@plurnk/plurnk-providers";
import TurnOps from "./TurnOps.ts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import type PacketWire from "./packet-wire.ts";
import type { ReplayedOperation } from "./packet-wire.ts";

type Entry = ReturnType<typeof PacketWire.entryView>;
export interface EmissionProgram { id: number; content: string; executors: string; kills?: string }

export interface ReplayedToolCall {
    readonly ordinal: number;
    readonly wire: WireToolCall;
    readonly serialized: string;
    readonly receiptCoordinates: readonly string[];
    readonly isError: boolean;
}

// {§emission-history}: durable ordinals join requests to receipts; text is never an identity. A turn's
// surviving operations replay together as structured `mcp` tool calls, in program order, immediately
// after its emission row, paired with their `tool` receipt messages.
export default class OperationHistory {
    static project(entries: readonly Entry[], programs: readonly EmissionProgram[]): {
        operations: Map<string, string>;
        paired: Map<string, ReplayedOperation>;
        turns: Map<string, readonly ReplayedToolCall[]>;
    } {
        const byId = new Map(programs.map((program) => [program.id, program]));
        const byTurn = new Map(entries.flatMap((entry) => {
            const program = typeof entry.id === "number" ? byId.get(entry.id) : undefined;
            if (program === undefined) return [];
            let parsedProgram: ReturnType<typeof TurnOps.parseInternal>;
            try {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§db-migrations}: a frozen emission's executors are read back as the row stored them
                parsedProgram = TurnOps.parseInternal(program.content, { executors: JSON.parse(program.executors) as string[] });
            } catch (err) {
                if (err instanceof SyntaxError) return [];
                throw err;
            }
            return [[OperationHistory.#turn(entry), {
                coordinate: String(entry.coordinate),
                program: parsedProgram,
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§emission-history}: active log-kill ordinals come from json_group_array
                kills: program.kills === undefined ? [] : JSON.parse(program.kills) as unknown[],
            }] as const];
        }));
        const operations = new Map<string, string>();
        const paired = new Map<string, ReplayedOperation>();
        const replayed = new Map<string, Map<number, {
            ordinal: number;
            wire: WireToolCall;
            serialized: string;
            receiptCoordinates: string[];
            isError: boolean;
        }>>();
        const resolveCall = (turn: string, program: ReturnType<typeof TurnOps.parseInternal>, rawOrdinal: unknown) => {
            if (typeof rawOrdinal !== "number" || !Number.isSafeInteger(rawOrdinal) || rawOrdinal < 0 || program[rawOrdinal] === undefined) {
                throw new Error("A receipt's content ordinal must address its frozen emission.");
            }
            const statement = program[rawOrdinal];
            const replay = statement.op === "kill" && statement.target?.kind === "url" && statement.target.scheme === "log"
                ? { ...statement, body: null } : statement;
            const payload = PlurnkParser.toMcpCall(replay);
            const wire: WireToolCall = {
                id: `call_${turn.replaceAll("/", "_")}_${rawOrdinal}`,
                name: "mcp",
                arguments: {
                    server: payload.server,
                    tool: payload.tool,
                    arguments: payload.arguments,
                    ...(payload.aside === undefined ? {} : { aside: payload.aside }),
                },
            };
            return { ordinal: rawOrdinal, wire, serialized: JSON.stringify(wire) };
        };
        for (const entry of entries) {
            const turn = OperationHistory.#turn(entry);
            const emission = byTurn.get(turn);
            if (emission === undefined || (entry.origin !== "model" && entry.origin !== "_plurnk") || entry.source != null) continue;
            const rawOrdinal = isRecord(entry.attrs) ? entry.attrs.emissionIndex : undefined;
            if (rawOrdinal === undefined) continue;
            const { ordinal, wire, serialized } = resolveCall(turn, emission.program, rawOrdinal);
            const body = LogBody.resolve({ op: typeof entry.op === "string" ? entry.op : null, attrs: entry.attrs, tx: entry.tx, rx: entry.rx });
            if (body.provenance === "authored" && LogVisibility.parse(entry.folded).length > 0) continue;
            const coordinate = String(entry.coordinate);
            paired.set(coordinate, { tokens: 0 });
            let turnCalls = replayed.get(turn);
            if (turnCalls === undefined) {
                turnCalls = new Map();
                replayed.set(turn, turnCalls);
            }
            const isRowError = typeof entry.status === "number" && entry.status >= 400;
            const existing = turnCalls.get(ordinal);
            if (existing === undefined) {
                operations.set(coordinate, serialized);
                turnCalls.set(ordinal, {
                    ordinal,
                    wire,
                    serialized,
                    receiptCoordinates: [coordinate],
                    isError: isRowError,
                });
            } else {
                existing.receiptCoordinates.push(coordinate);
                existing.isError ||= isRowError;
            }
        }
        for (const [turn, { program, kills }] of byTurn) {
            for (const rawOrdinal of kills) {
                const { ordinal, wire, serialized } = resolveCall(turn, program, rawOrdinal);
                let turnCalls = replayed.get(turn);
                if (turnCalls === undefined) {
                    turnCalls = new Map();
                    replayed.set(turn, turnCalls);
                }
                if (turnCalls.has(ordinal)) continue;
                turnCalls.set(ordinal, {
                    ordinal,
                    wire,
                    serialized,
                    receiptCoordinates: [],
                    isError: false,
                });
            }
        }
        const turns = new Map([...replayed.entries()].map(([turn, turnCalls]) => [
            byTurn.get(turn)!.coordinate,
            [...turnCalls.values()].toSorted((left, right) => left.ordinal - right.ordinal),
        ]));
        return { operations, paired, turns };
    }

    static #turn(entry: Entry): string {
        return String(entry.coordinate).split("/").slice(0, 2).join("/");
    }
}
