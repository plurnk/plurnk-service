import type { Db } from "./Db.ts";

type ReceiptRow = {
    batch_id: number;
    batch_state: string;
    branch: string;
    item_state: string;
    result: string | null;
    result_commit: string | null;
    changed: number | null;
    worker_name: string;
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
        // {§worker-branch-batch-receipt} — world state, not a next step: which worker, which
        // branch, and the commit that now sits on it. What happens next is the parent's call.
        const who = `Branch worker \`${first.worker_name}\``;
        const tip = first.result_commit === null ? "" : ` at \`${first.result_commit.slice(0, revisionChars)}\``;
        if (first.item_state !== "succeeded") return `${who} ${first.item_state} on branch \`${first.branch}\`${tip}.`;
        return first.changed === 1
            ? `${who} created branch \`${first.branch}\`${tip}.`
            : `${who} left branch \`${first.branch}\` unchanged${tip}.`;
    }
}
