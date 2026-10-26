import type { Db } from "../src/core/Db.ts";
import Envelope, { type SessionRow } from "../src/server/envelope.ts";

export const readSessionTopology = async (db: Db, workspaceId: number): Promise<{ sessions: SessionRow[]; delegatedSessions: number }> => {
    const sessions = await Envelope.listSessionsForWorkspace(db, workspaceId);
    const delegatedSessions = sessions.filter(({ origin, parentSessionId }) => origin === "model" && parentSessionId !== null).length;
    return { sessions, delegatedSessions };
};
