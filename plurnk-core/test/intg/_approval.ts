import type { TestContext } from "node:test";
import type { ProposalPolicy } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import WorkerOwners from "../../src/core/WorkerOwners.ts";

export const TEST_OWNER = "test://primary";

export const ownWorker = async (db: Db, workspaceId: number, workerId: number, tools = ["request_approval", "question", "mcp_input_required"]): Promise<void> => {
    await WorkerOwners.register(db, workspaceId, { address: TEST_OWNER, tools });
    await WorkerOwners.claim(db, workspaceId, workerId, TEST_OWNER);
};

// {§worker-owner-resolution} Fixtures without a reviewing client declare server
// disposition explicitly; message submission cannot carry approval authority.
export const serverProposals = (t: Pick<TestContext, "after">, value: ProposalPolicy): void => {
    const previous = process.env.PLURNK_SERVICE_PROPOSALS;
    process.env.PLURNK_SERVICE_PROPOSALS = value;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_PROPOSALS;
        else process.env.PLURNK_SERVICE_PROPOSALS = previous;
    });
};
