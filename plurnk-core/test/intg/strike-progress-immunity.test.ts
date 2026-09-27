import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";

const response = (content: string) => ({
    assistant: { content, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
const invalidFind = "````FIND (worker:///x) [{\"pattern\":\"$fC\"}]````";
const read = "````READ (worker:///answer) <1,-1>````";

const loop = async (responses: string[], maxStrikes: number) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `strike-progress-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Read the answer and conclude.");
    await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/answer", channel: "body", content: "42", mimetype: "text/plain", state: "static" });
    const provider = new Mock({ contextWindow: 100000, responses: responses.map(response) });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns: responses.length + 1, maxStrikes });
    return { db, loopId, result };
};

// The recorded shape (#853, glm): a turn whose READ succeeded beside a hard 400 struck, and two such
// turns ended productive loops.
test("{§strike-progress-immunity}: a hard 400 beside a successful READ neither strikes nor survives into the streak", async () => {
    const { db, loopId, result } = await loop([`${invalidFind}\n${read}`, invalidFind, `${invalidFind}\n${read}`, "````KILL\n42\n````"], 2);
    try {
        assert.equal(result.result.status, 200, "no productive turn struck, and the lone failing turn was forgiven by the next productive one");
        assert.equal(await new StrikeRail(db).streak(loopId), 0);
    } finally { await db.close(); }
});

test("{§strike-progress-immunity}: failures beside only NOTE and WAIT still strike", async () => {
    const { db, result } = await loop([`${invalidFind}\n\`\`\`\`NOTE\nthinking\n\`\`\`\``, `${invalidFind}\nprose outside the fence`], 2);
    try {
        assert.equal(result.result.status, 500);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
    } finally { await db.close(); }
});
