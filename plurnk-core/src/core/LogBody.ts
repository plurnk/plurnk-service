import {
    assertEditReceipt,
    assertResourceEffects,
    type EditReceipt,
} from "../content/index.ts";
import TerminalResult from "./TerminalResult.ts";

export interface LogBodyRow {
    readonly op: string | null;
    readonly attrs?: unknown;
    readonly tx: unknown;
    readonly rx: unknown;
    readonly mimetypeTx?: string;
    readonly mimetypeRx?: string;
}

export interface ResolvedLogBody {
    readonly content: string;
    readonly mimetype: string;
    readonly startLine: number | null;
}

const EMPTY_BODY: ResolvedLogBody = Object.freeze({
    content: "",
    mimetype: "text/plain",
    startLine: 1,
});

// The durable log row has one canonical body regardless of how it is consumed.
// Packet rendering projects this body, while READ(log://), FIND(log://), and
// search derivation consume it complete. Storage envelopes and tx/rx placement
// are persistence details and must not change what the row means.
export default class LogBody {
    static #decode(value: unknown, mimetype: string | undefined): unknown {
        if (typeof value !== "string" || mimetype !== "application/json") return value;
        try {
            return JSON.parse(value) as unknown;
        } catch {
            return value;
        }
    }

    static #contentBody(value: unknown, fallbackMimetype: string | undefined): ResolvedLogBody | null {
        if (value === null || typeof value !== "object") return null;
        const body = value as { content?: unknown; mimetype?: unknown; startLine?: unknown };
        if (typeof body.content !== "string") return null;
        return {
            content: body.content,
            mimetype: typeof body.mimetype === "string" ? body.mimetype : (fallbackMimetype ?? "text/plain"),
            startLine: body.startLine === null ? null : (typeof body.startLine === "number" ? body.startLine : 1),
        };
    }

    static #receiptBody(receipts: readonly EditReceipt[]): ResolvedLogBody {
        // {§edit-result-receipt-projection} — the canonical row body is the
        // bounded landed context, not the authored mutation text.
        if (receipts.length === 0) return EMPTY_BODY;
        return {
            content: receipts
                .map((receipt) => "effect" in receipt
                    ? receipt.effect.context
                    : receipt.replacement?.context ?? "")
                .filter((context) => context.length > 0)
                .join("\n\n"),
            mimetype: "text/plain",
            startLine: null,
        };
    }

    static resolve(row: LogBodyRow): ResolvedLogBody {
        const attrs = typeof row.attrs === "string"
            ? LogBody.#decode(row.attrs, "application/json")
            : row.attrs;
        const tx = LogBody.#decode(row.tx, row.mimetypeTx);
        const rx = LogBody.#decode(row.rx, row.mimetypeRx);
        const contentBody = LogBody.#contentBody(rx, row.mimetypeRx);

        if (row.op === null) {
            if (attrs === null || typeof attrs !== "object" || (attrs as { kind?: unknown }).kind !== "model_emission") {
                throw new TypeError("An actionless log body must carry attrs.kind=model_emission.");
            }
            return contentBody ?? EMPTY_BODY;
        }

        if (row.op === "READ" || row.op === "FIND" || row.op === "prompt") {
            return contentBody ?? EMPTY_BODY;
        }

        if (row.op === "EDIT") {
            if (rx !== null && typeof rx === "object") {
                const result = rx as Record<string, unknown>;
                if (Object.hasOwn(result, "receipt")) {
                    return LogBody.#receiptBody([
                        assertEditReceipt(result.receipt),
                    ]);
                }
                if (typeof result.span === "string") {
                    return {
                        content: result.span,
                        mimetype: "text/plain",
                        startLine: null,
                    };
                }
            }
            return EMPTY_BODY;
        }

        if (row.op === "COPY" || row.op === "MOVE") {
            if (rx !== null && typeof rx === "object") {
                const result = rx as Record<string, unknown>;
                if (Object.hasOwn(result, "effects")) {
                    const receipts = assertResourceEffects(result.effects)
                        .flatMap(({ receipt }) => receipt === undefined ? [] : [receipt]);
                    return LogBody.#receiptBody(receipts);
                }
            }
            return EMPTY_BODY;
        }

        if (row.op === "EXEC" && tx !== null && typeof tx === "object") {
            const body = (tx as { body?: unknown }).body;
            if (typeof body === "string") {
                return {
                    content: body,
                    mimetype: "text/plain",
                    startLine: 1,
                };
            }
        }

        if (
            row.op === "SEND"
            && attrs !== null
            && typeof attrs === "object"
            && !Array.isArray(attrs)
            && (attrs as { kind?: unknown }).kind === "loop_termination"
        ) {
            const context = attrs as { terminatedBy?: unknown; receipt?: unknown };
            if (context.terminatedBy !== undefined && context.terminatedBy !== "cancel") {
                throw new TypeError("A loop-termination log body carries malformed terminal authorship.");
            }
            if (context.receipt !== undefined && typeof context.receipt !== "string") {
                throw new TypeError("A loop-termination log body carries a malformed branch receipt.");
            }
            const exact = TerminalResult.assert(rx, "loop-termination log body");
            const presentation = TerminalResult.present(exact, {
                terminatedBy: context.terminatedBy,
                receipt: context.receipt,
                fallback: `[ worker concluded with no deliverable (status ${exact.status}) ]`,
            });
            if (presentation === null) return EMPTY_BODY;
            return { ...presentation, startLine: 1 };
        }

        if (row.op === "PLAN" || row.op === "SEND" || row.op === "WORK" || row.op === "FORK") {
            if (tx !== null && typeof tx === "object") {
                const body = (tx as { body?: unknown }).body;
                const content = typeof body === "string"
                    ? body
                    : body !== null && typeof body === "object" && typeof (body as { raw?: unknown }).raw === "string"
                        ? (body as { raw: string }).raw
                        : "";
                if (content.length > 0) {
                    return {
                        content,
                        mimetype: "text/plain",
                        startLine: 1,
                    };
                }
            }
            if (row.op === "SEND" && typeof rx === "string" && rx.length > 0) {
                return {
                    content: rx,
                    mimetype: row.mimetypeRx ?? "text/plain",
                    startLine: 1,
                };
            }
        }

        if (row.op === "error" && rx !== null && typeof rx === "object") {
            const message = (rx as { message?: unknown }).message;
            if (typeof message === "string" && message.length > 0) {
                return {
                    content: message,
                    mimetype: "text/plain",
                    startLine: 1,
                };
            }
        }

        // Extension rows use the same durable result/statement envelopes as
        // built-in operations. Keep the fallback structural so a new producer
        // cannot require a packet-renderer branch merely to expose its body.
        if (contentBody !== null) return contentBody;
        if (tx !== null && typeof tx === "object") {
            const body = (tx as { body?: unknown }).body;
            if (typeof body === "string" && body.length > 0) {
                return {
                    content: body,
                    mimetype: row.mimetypeTx ?? "text/plain",
                    startLine: 1,
                };
            }
        }

        return EMPTY_BODY;
    }
}
