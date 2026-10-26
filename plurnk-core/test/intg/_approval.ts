import type { TestContext } from "node:test";
import type { ProposalPolicy } from "@plurnk/plurnk-contracts";
import type { Db } from "../../src/core/Db.ts";
import SessionOwners from "../../src/core/SessionOwners.ts";

export const TEST_OWNER = "test://primary";

// A full client by default: every client tool, with a person attending.
export const ownSession = async (db: Db, workspaceId: number, sessionId: number, tools = ["request_approval", "question", "mcp_input_required"], interactive = true): Promise<void> => {
    await SessionOwners.register(db, workspaceId, { address: TEST_OWNER, tools, interactive });
    await SessionOwners.claim(db, workspaceId, sessionId, TEST_OWNER);
};

// {§session-owner-resolution} Fixtures without a reviewing client declare server
// disposition explicitly; message submission cannot carry approval authority.
export const serverProposals = (t: Pick<TestContext, "after">, value: ProposalPolicy): void => {
    const previous = process.env.PLURNK_SERVICE_PROPOSALS;
    process.env.PLURNK_SERVICE_PROPOSALS = value;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_PROPOSALS;
        else process.env.PLURNK_SERVICE_PROPOSALS = previous;
    });
};
