import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import type { ResolvedEditStatement, SchemeResult } from "@plurnk/plurnk-schemes";
import LineAnchors from "../content/line-anchors.ts";
import LineMarkerOps from "../content/line-marker.ts";
import { assertEditReceipt } from "../content/edit-receipt.ts";

export interface EditSnapshot {
    readonly identity: string;
    readonly content: string;
    readonly anchors: ReadonlyMap<string, readonly number[]>;
}

// {§edit-anchor-continuity} — scoped to one admitted program, never persisted or shared.
export default class EditSequence {
    readonly #snapshots = new Map<string, EditSnapshot>();

    forget(identity: string): void {
        this.#snapshots.delete(identity);
    }

    observe(identity: string, content: string): EditSnapshot {
        content = EditSequence.#lines(content);
        const prior = this.#snapshots.get(identity);
        const anchors = new Map(prior?.content === content ? prior.anchors : []);
        const current = new Map<string, number[]>();
        for (const [index, anchor] of LineAnchors.tokens(identity, content).entries()) {
            const lines = current.get(anchor) ?? [];
            lines.push(index + 1);
            current.set(anchor, lines);
        }
        for (const [anchor, lines] of current) {
            if (!anchors.has(anchor)) anchors.set(anchor, lines);
        }
        const snapshot = { identity, content, anchors };
        this.#snapshots.set(identity, snapshot);
        return snapshot;
    }

    settle(snapshot: EditSnapshot, statement: ResolvedEditStatement, result: SchemeResult): void {
        if (result.status >= 300) return;
        const receipt = result.receipt === undefined ? undefined : assertEditReceipt(result.receipt);
        if (receipt === undefined || "disposition" in receipt || statement.lineMarker === null) {
            this.forget(snapshot.identity);
            return;
        }
        const replacement = LineMarkerOps.textReplacement(snapshot.content, statement.lineMarker, (statement.body ?? "").replace(/\r\n?/g, "\n"));
        if ("error" in replacement) {
            throw new Error("A successful EDIT has no valid text replacement.");
        }
        const { start, end, body } = replacement;
        // This is an expectation, not a snapshot of disk. observe() must confirm the
        // complete resulting line content before any carried binding can be used.
        const updated = EditSequence.#lines(snapshot.content.slice(0, start) + body + snapshot.content.slice(end));
        const lines = TextCoordinates.logicalLines(snapshot.content);
        const nextLines = TextCoordinates.logicalLines(updated);
        const nextOrdinals = new Map(nextLines.map((line, index) => [line.start, index + 1]));
        const shifted = new Map<number, number>();
        const delta = body.length - (end - start);
        for (const [index, line] of lines.entries()) {
            if (start < line.end && end > line.start) continue;
            if (start === end && start > line.start && start < line.end) continue;
            const offset = line.start + (end <= line.start ? delta : 0);
            const ordinal = nextOrdinals.get(offset);
            if (ordinal === undefined) continue;
            const next = nextLines[ordinal - 1]!;
            if (snapshot.content.slice(line.start, line.contentEnd) !== updated.slice(next.start, next.contentEnd)) continue;
            shifted.set(index + 1, ordinal);
        }
        const anchors = new Map([...snapshot.anchors].map(([anchor, ordinals]) => [
            anchor, ordinals.flatMap((line) => shifted.has(line) ? [shifted.get(line)!] : []),
        ]));
        this.#snapshots.set(snapshot.identity, { identity: snapshot.identity, content: updated, anchors });
    }

    static #lines(content: string): string {
        return TextCoordinates.logicalLines(content).map(({ start, contentEnd }) => content.slice(start, contentEnd)).join("\n");
    }
}
