// {§packet-wire-envelope} — the worker's previous program as the grammar admitted it: the canonical
// rendering of every statement the parser read from the most recent program that admitted any.
// Free text and unadmitted forms are absent, and a recovered native call appears as the operation
// it was read as. Whatever sits under the assistant marker is what the model writes next (#903).
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";

export type PreviousEmissionView = { readonly content: string; readonly address: string };

export default class PreviousEmission {
    static async resolve(
        db: Db,
        { workspaceId, workerId, turnId }: { workspaceId: number; workerId: number; turnId: number },
        executors: ExecutorRegistry | undefined,
    ): Promise<PreviousEmissionView | null> {
        const options = {
            executors: executors?.availableRuntimes(workspaceId) ?? [],
            jsonBodyExecutors: executors?.jsonBodyRuntimes(workspaceId) ?? [],
        };
        const programs = await db.turn_source_previous_emission.all<{ content: string; worker: string; loop: number; turn: number }>({ worker_id: workerId, turn_id: turnId });
        for (const program of programs) {
            const statements = PlurnkParser.parse(program.content, options).items
                .filter((item): item is { kind: "statement"; statement: PlurnkStatement } => item.kind === "statement")
                .map(({ statement }) => statement);
            if (statements.length === 0) continue;
            return { content: PlurnkParser.stringify(statements), address: `ops://${program.worker}/${program.loop}/${program.turn}` };
        }
        return null;
    }
}
