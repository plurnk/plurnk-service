// Integration harness: packet and log projections read back from stored turns.

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Db } from "../../src/core/Db.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { parseLogRecords } from "../LogRecords.ts";

// {§loop-response-messages}: evaluate delivered text independently of execution outcome.
export const lastReply = async (db: Db, loopId: number): Promise<string> =>
    (await db.test_last_loop_reply.get<{ content: string }>({ loop_id: loopId }))?.content ?? "";

// Read one section's rendered content off a stored (parsed) packet by name —
// the test-side mirror of the wire/digest read path (PacketWire.sectionContent).
export const packetSection = (packet: unknown, name: string): string =>
    PacketWire.sectionContent(packet as Parameters<typeof PacketWire.sectionContent>[0], name);

// Parse the model's actual Markdown-framed log view for field-precise assertions.
// The H3 supplies the test reader's `logPath`; the next line is metadata, and any remaining
// coordinate-prefixed lines are the visible body ({§log-wire-format}).
export const logEntries = (packet: unknown): Array<Record<string, unknown>> => {
    return parseLogRecords(packetSection(packet, "log"));
};

// {§message-arrival} — an arrival row: the harness's inbound SEND, marked `attrs.kind = "message"`.
export const isArrivalRow = (row: { op?: unknown; origin?: unknown; attrs?: unknown }): boolean => {
    if (row.op !== "SEND" || row.origin !== "_plurnk") return false;
    const attrs = typeof row.attrs === "string" ? JSON.parse(row.attrs) as unknown : row.attrs;
    return attrs !== null && typeof attrs === "object" && (attrs as { kind?: unknown }).kind === "message";
};

// {§share-packet-names}: the packet artifact stems a digest wrote, in turn-id order, as its digest.json records them.
export const digestStems = async (digestDir: string): Promise<string[]> => {
    const { turns } = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { turns: Array<{ id: number; artifact: string | null }> };
    return turns.toSorted((a, b) => a.id - b.id).flatMap(({ artifact }) => artifact === null ? [] : [artifact]);
};
