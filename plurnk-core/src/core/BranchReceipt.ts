import type { Db } from "./Db.ts";

type ReceiptRow = {
    batch_id: number;
    batch_state: string;
    branch: string;
    item_state: string;
    result: string | null;
    result_commit: string | null;
    changed: number | null;
};

export default class BranchReceipt {
    static #revisionChars(): number {
        const raw = process.env.PLURNK_SERVICE_BRANCH_RECEIPT_REVISION_CHARS;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
            throw new Error(`PLURNK_SERVICE_BRANCH_RECEIPT_REVISION_CHARS must be a safe integer from 1 through 64, got ${JSON.stringify(raw)}`);
        }
        return value;
    }

    static async render(db: Db, workerId: number): Promise<string | null> {
        const rows = await db.branch_batch_receipt_for_worker.all<ReceiptRow>({
            worker_id: workerId,
        });
        if (rows.length === 0) return null;
        const first = rows[0];
        const revisionChars = BranchReceipt.#revisionChars();
        const tip = first.result_commit === null
            ? ""
            : ` at \`${first.result_commit.slice(0, revisionChars)}\` (${first.changed === 1 ? "changed" : "unchanged"})`;
        return `Branch receipt: \`${first.branch}\` ${first.item_state}${tip} (batch ${first.batch_id} ${first.batch_state}).`;
    }
}
