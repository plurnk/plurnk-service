// {§rollback} — undo a session's settled file mutations after one of its log coordinates. Each row's
// patch ({§log-mutation-patch}) is reversed against the file as it is now and written back as an
// ordinary operation of the acting client, so every step is a proposal, a row and a patch of its
// own; the first file that no longer holds what its mutation wrote stops the rollback where it is.
import { errnoCode } from "@plurnk/plurnk-contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPatch, parsePatch, reversePatch, type StructuredPatch } from "diff";
import type { PlurnkStatement, RollbackReport } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { Db } from "../core/Db.ts";
import { entryAddress } from "../core/plurnk-uri.ts";
import { daemonFailure } from "./daemon-results.ts";

type MutationRow = {
    id: number; loop_seq: number; turn_seq: number; sequence: number;
    op: string; scheme: string | null; pathname: string | null; patch: string | null;
};
type Coordinate = { loopSeq: number; turnSeq: number; sequence: number };
type Restored = RollbackReport["restored"][number];
type Stopped = Exclude<RollbackReport["stopped"], null>;

export interface RollbackSeam {
    readonly db: Db;
    projectRoot(workspaceId: number): Promise<string | null>;
    // The runtimes the parser recognizes in this workspace, for the fenced forms this builds.
    executorTags(workspaceId: number): readonly string[];
    // One operation of the acting client, applied and settled under that client's authority.
    apply(statement: PlurnkStatement): Promise<{ status: number; problem?: { detail?: string } }>;
}

export default class Rollback {
    // `<loop>/<turn>/<item>`, with or without the `log:///` prefix and a trailing `/<OP>`.
    static coordinate(to: string): Coordinate | null {
        const match = /^(?:log:\/\/\/)?(\d+)\/(\d+)\/(\d+)(?:\/[A-Za-z]+)?$/u.exec(to.trim());
        if (match === null) return null;
        const [loopSeq, turnSeq, sequence] = match.slice(1).map(Number);
        return loopSeq > 0 && turnSeq > 0 && sequence > 0 ? { loopSeq: loopSeq, turnSeq: turnSeq, sequence: sequence } : null;
    }

    static async run(seam: RollbackSeam, args: { workspaceId: number; sessionId: number; to: string }): Promise<RollbackReport> {
        const coordinate = Rollback.coordinate(args.to);
        if (coordinate === null) {
            throw daemonFailure("daemon:rollback", "coordinate-invalid", 400, `'${args.to}' is not a log coordinate.`, {
                to: args.to, recovery: "Name the coordinate as <loop>/<turn>/<item>, as the log shows it.",
            });
        }
        const at = `${coordinate.loopSeq}/${coordinate.turnSeq}/${coordinate.sequence}`;
        const anchor = await seam.db.log_id_by_coordinate.get<{ id: number }>({
            session_id: args.sessionId, loop_seq: coordinate.loopSeq, turn_seq: coordinate.turnSeq, sequence: coordinate.sequence,
        });
        if (anchor === undefined) {
            throw daemonFailure("daemon:rollback", "coordinate-not-found", 404, `No log entry exists at log:///${at}.`, { to: at });
        }
        const root = await seam.projectRoot(args.workspaceId);
        if (root === null) {
            throw daemonFailure("daemon:rollback", "project-root-required", 400, "Rollback restores files, and this workspace has no project root.", {});
        }
        const rows = await seam.db.log_file_mutations_after.all<MutationRow>({
            session_id: args.sessionId, loop_seq: coordinate.loopSeq, turn_seq: coordinate.turnSeq, sequence: coordinate.sequence,
        });
        const restored: Restored[] = [];
        const skipped: RollbackReport["skipped"][number][] = [];
        const executors = seam.executorTags(args.workspaceId);
        for (const row of rows) {
            const rowCoordinate = `${row.loop_seq}/${row.turn_seq}/${row.sequence}`;
            if (row.patch === null) {
                // A file mutation that kept no patch: nothing is invented for it ({§log-mutation-patch}).
                if (row.scheme === null || row.scheme === "file") skipped.push({ coordinate: rowCoordinate, reason: "no-patch" });
                continue;
            }
            // A row that wrote several files is reversed last file first.
            for (const file of parsePatch(row.patch).toReversed()) {
                const outcome = await Rollback.#reverse(seam, { root, executors, file, coordinate: rowCoordinate }, restored);
                if (outcome === "already-reversed") { skipped.push({ coordinate: rowCoordinate, reason: "already-reversed" }); continue; }
                if (outcome !== null) return { to: at, restored, skipped, stopped: outcome };
            }
        }
        return { to: at, restored, skipped, stopped: null };
    }

    static async #reverse(
        seam: RollbackSeam,
        { root, executors, file, coordinate }: { root: string; executors: readonly string[]; file: StructuredPatch; coordinate: string },
        restored: Restored[],
    ): Promise<Stopped | "already-reversed" | null> {
        const path = file.oldFileName;
        if (typeof path !== "string" || path.length === 0) throw new Error(`log:///${coordinate} keeps a patch that names no file.`);
        let current: string | null;
        try {
            current = await readFile(join(root, path), "utf8");
        } catch (cause) {
            if (errnoCode(cause) !== "ENOENT") throw cause;
            current = null;
        }
        const created = file.hunks.every((hunk) => hunk.oldLines === 0);
        const removed = !created && file.hunks.every((hunk) => hunk.newLines === 0);
        // A row whose forward patch still applies was reversed already, by an earlier rollback whose
        // own rows live in the client's log: nothing to do for it, and nothing invented.
        const alreadyReversed = (): boolean => applyPatch(current ?? "", file) !== false;
        if (removed ? current !== null : current === null) {
            if (alreadyReversed()) return "already-reversed";
            return { coordinate, path, reason: "drift", detail: `'${path}' ${current === null ? "no longer exists" : "exists again"}; log:///${coordinate} ${removed ? "removed" : "wrote"} it.` };
        }
        const previous = applyPatch(current ?? "", reversePatch(file));
        if (previous === false) {
            if (alreadyReversed()) return "already-reversed";
            return { coordinate, path, reason: "drift", detail: `'${path}' no longer holds what log:///${coordinate} wrote.` };
        }
        const action: Restored["action"] = created ? "delete" : removed ? "create" : "update";
        const target = entryAddress("file", "", path, root);
        const source = action === "delete"
            ? `\`\`\`\`KILL (${target})\`\`\`\``
            : `\`\`\`\`EDIT (${target})${action === "update" ? " <1,-1>" : ""}\n${previous}\n\`\`\`\``;
        const { items } = PlurnkParser.parseStatements(source, { executors: [...executors] });
        const item = items[0];
        if (items.length !== 1 || item?.kind !== "statement") throw new Error(`rollback of log:///${coordinate} built an operation the parser refused: ${source.slice(0, 120)}`);
        const result = await seam.apply(item.statement);
        if (result.status >= 300) {
            return { coordinate, path, reason: "refused", detail: result.problem?.detail ?? `The reversing operation answered ${result.status}.` };
        }
        restored.push({ coordinate, path, action });
        return null;
    }
}
