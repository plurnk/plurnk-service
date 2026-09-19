// {§loop-answer} — one resolution for a loop's address. `ops://<worker>/<loop>` is what the loop
// said: the latest reply to the message that started it, whether prose or a SEND. A loop that has
// not answered yet is 425; one that ended without answering is how it ended, its terminal problem
// or an empty success. The same resolution serves the model's READ, the `worker://` pull, and the
// termination row a concluded child leaves in its parent's log, so those never disagree (#766).
import type { Db } from "./Db.ts";
import type { SchemeResult } from "@plurnk/plurnk-schemes";
import Results from "./results.ts";
import TerminalResult from "./TerminalResult.ts";

export interface LoopOutcome {
    readonly resource: string;
    readonly result: SchemeResult;
    readonly terminatedBy: string | null;
}

export const loopAddress = (worker: string, sequence: number): string => `ops://${worker}/${sequence}`;

// `null` means no such loop; every other state is a result the caller can publish.
export const loopOutcome = async (
    db: Db,
    workspaceId: number,
    worker: string,
    sequence: number,
): Promise<LoopOutcome | null> => {
    const row = await db.turn_source_loop_answer.get<{
        status: number; terminal_result: string | null; terminated_by: string | null; answer: string | null;
    }>({ workspace_id: workspaceId, worker_name: worker, loop_seq: sequence });
    if (row === undefined) return null;
    const resource = loopAddress(worker, sequence);
    const terminal = row.terminal_result === null ? null : TerminalResult.parse(row.terminal_result, resource);
    // A loop that ended badly reports how it ended, even when it answered earlier: the failure is
    // the news. Otherwise its answer is what it said.
    if (terminal !== null && Results.isErrorStatus(terminal.status)) {
        return { resource, result: terminal, terminatedBy: row.terminated_by };
    }
    if (row.answer !== null) {
        return { resource, result: Results.assert({ status: 200, content: row.answer, mimetype: "text/markdown" }), terminatedBy: row.terminated_by };
    }
    if (terminal === null) {
        return {
            resource,
            result: Results.failure("scheme:ops", "loop-running", 425, `The execution at ${resource} has not concluded.`, { resource }, { retryable: true }),
            terminatedBy: row.terminated_by,
        };
    }
    return { resource, result: terminal, terminatedBy: row.terminated_by };
};
