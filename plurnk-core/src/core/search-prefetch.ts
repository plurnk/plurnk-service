import type { Db, PrepMethod } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { WakeRunPayload } from "./ChannelWrite.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import EntryCrud from "../schemes/_entry-crud.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";

// §search-prefetch (#333, owner rulings) — search declares web members. The executor's
// #results digest is the CANDIDATE enumeration; this pass materializes every candidate into an
// ordinary http entry through the scheme's own read path (below the dispatcher — a sync pass,
// like workspace membership, mints no log rows), then REWRITES #results as the survivor render:
// the entry set is the only truth, so a dead page never appears because there is nothing to
// render a row from. Chooser context (title/snippet/date) is stamped onto each survivor entry's
// attributes and rides the render together with live token/line costs — one listing, no
// synthetic FIND. The pass runs INSIDE the exec hold window (Engine's hold loop holds while
// holds() is true), so the packet the model wakes to already carries post-prefetch truth.
type DigestRow = { title?: string; url?: string; snippet?: string; publishedDate?: string };

const RESULTS = "#results";

const readKnob = (name: string): string => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`${name} is unset — the .env.defaults floor must declare it`);
    return v;
};

export default class SearchPrefetch {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #tokenize: (text: string) => number;
    // The hold leg: runs with a pass in flight. Set SYNCHRONOUSLY on the conclusion event
    // (same tick as the spawn's deregistration), so the Engine hold loop can never observe
    // the gap between "search stream closed" and "prefetch registered".
    readonly #pending = new Map<number, Promise<void>>();
    // Page-read conclusions this pass owns, keyed by storage pathname — their wakes are
    // swallowed (a prefetched page is a sync write, not a wake edge).
    readonly #waiters = new Map<string, (status: number) => void>();

    constructor(args: { db: Db; schemes: SchemeRegistry; tokenize: (text: string) => number }) {
        this.#db = args.db;
        this.#schemes = args.schemes;
        this.#tokenize = args.tokenize;
    }

    holds(runId: number): boolean { return this.#pending.has(runId); }

    // A search-runtime exec stream concluded — the trigger. The runtime set is a knob
    // (reader-declares: declared in this package's .env.defaults).
    isSearchConclusion(payload: WakeRunPayload): boolean {
        if (payload.closeStatus !== 200) return false;
        const runtimes = new Set(readKnob("PLURNK_SERVICE_SEARCH_PREFETCH_RUNTIMES").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
        return runtimes.has(payload.scheme);
    }

    // A page conclusion from our own fan-out: resolve its waiter, tell the caller to swallow.
    ownsConclusion(payload: WakeRunPayload): boolean {
        const key = payload.target;
        const waiter = this.#waiters.get(key);
        if (waiter === undefined) return false;
        this.#waiters.delete(key);
        waiter(payload.closeStatus);
        return true;
    }

    // The sync pass. Called by the daemon's wake handler BEFORE the wake proceeds; awaited, so
    // the fold-back the model reads is post-prefetch truth. Idempotent per run.
    async onSearchConcluded(payload: WakeRunPayload, mkCtx: (sessionId: number, runId: number) => Promise<PlurnkSchemeContext>): Promise<void> {
        if (this.#pending.has(payload.runId)) return this.#pending.get(payload.runId);
        const pass = this.#run(payload, mkCtx).finally(() => this.#pending.delete(payload.runId));
        this.#pending.set(payload.runId, pass);
        return pass;
    }

    async #run(payload: WakeRunPayload, mkCtx: (sessionId: number, runId: number) => Promise<PlurnkSchemeContext>): Promise<void> {
        const ctx = await mkCtx(payload.sessionId, payload.runId);
        const execPathname = payload.target.replace(/^[a-z+.-]+:\/\//, "/").replace(/^\/+/, "/");
        const execEntry = await EntryCrud.readEntry(execPathname, ctx, payload.scheme);
        const raw = execEntry.entry?.channels[RESULTS]?.content;
        if (raw === undefined || raw.length === 0) return;  // no digest — nothing declared
        let candidates: DigestRow[];
        try { candidates = JSON.parse(raw) as DigestRow[]; }
        catch { return; }  // a non-JSON #results is not a digest; leave it untouched
        if (!Array.isArray(candidates)) return;

        const http = this.#schemes.get("http") as { read: (s: ReadStatement, c: unknown) => Promise<{ status: number }> } | undefined;
        if (http === undefined) throw new Error("search-prefetch: http scheme absent — the bundle guarantees it");


        const concurrency = Number.parseInt(readKnob("PLURNK_SERVICE_SEARCH_PREFETCH_CONCURRENCY"), 10);
        const pageTimeoutMs = Number.parseInt(readKnob("PLURNK_SERVICE_SEARCH_PREFETCH_TIMEOUT_MS"), 10);

        const survivors: Array<{ row: DigestRow; pathname: string }> = [];
        const queue = candidates.filter((r): r is DigestRow & { url: string } => typeof r.url === "string" && r.url.length > 0);
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < queue.length) {
                const row = queue[next++];
                const target = SearchPrefetch.#urlPath(row.url);
                // The wake payload's target is the literal `scheme://pathname` concatenation
                // (ChannelWrite #179) — match it exactly, not the model-facing render.
                const key = `${target.scheme}://${target.pathname}`;
                const concluded = new Promise<number>((resolve) => this.#waiters.set(key, resolve));
                const stmt: ReadStatement = { op: "READ", suffix: "", signal: null, target, lineMarker: null, body: null, position: { line: 1, column: 1 } };
                let opened: { status: number };
                // A fresh caps wrapper per page: the subscription cap is stateful (its bound
                // pathname), so concurrent reads must not share one — mirrors dispatch (one
                // SchemeCtxImpl per op).
                const httpCtx = new SchemeCtxImpl(ctx, "http") as unknown as PlurnkSchemeContext;
                try { opened = await http.read(stmt, httpCtx); }
                catch { this.#waiters.delete(key); continue; }  // a page that fails to open is not a member
                if (opened.status >= 400) { this.#waiters.delete(key); continue; }
                const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(504), pageTimeoutMs).unref());
                const status = await Promise.race([concluded, timeout]);
                if (status !== 200) { this.#waiters.delete(key); continue; }
                const page = await EntryCrud.readEntry(target.pathname, ctx, "http");
                const body = page.entry?.channels.body;
                if (body === undefined || body.content.length === 0) continue;  // rendered to nothing — dead
                const httpStatus = SearchPrefetch.#headerStatus(page.entry?.channels.header?.content ?? "");
                if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) continue;  // not a 2xx page — the server declined, not a member
                survivors.push({ row, pathname: target.pathname });
                // Chooser context lives ON the entry (owner ruling): title/snippet/date as attributes.
                await (this.#db.search_stamp_entry_attributes as PrepMethod).run({
                    session_id: payload.sessionId, scheme: "http", pathname: target.pathname,
                    patch: JSON.stringify({ title: row.title ?? null, snippet: row.snippet ?? null, publishedDate: row.publishedDate ?? null }),
                });
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

        // The survivor render — the ONE listing: chooser context + live costs, rebuilt from the
        // entries that exist. Rewrites #results in place so the OPEN fold-back carries it.
        const rendered = [];
        for (const { row, pathname } of survivors) {
            const page = await EntryCrud.readEntry(pathname, ctx, "http");
            const content = page.entry?.channels.body?.content ?? "";
            rendered.push({
                title: row.title, url: row.url, snippet: row.snippet,
                ...(row.publishedDate !== undefined ? { publishedDate: row.publishedDate } : {}),
                tokens: this.#tokenize(content), lines: content.length === 0 ? 0 : content.split("\n").length,
            });
        }
        if (execEntry.entry !== null && execEntry.entry !== undefined) {
            const channels = { ...execEntry.entry.channels, [RESULTS]: { content: JSON.stringify(rendered), mimetype: "application/json" } };
            await EntryCrud.writeEntry(execPathname, { channels, tags: execEntry.entry.tags ?? [] }, ctx, payload.scheme);
        }
    }

    // The FOLDED storage form (authority in the pathname) — the shape the engine's
    // authority-fold hands the scheme and renderAddress reconstructs; `raw` stays the
    // verbatim URL because Http fetches from raw.
    // The HEADER channel's first line is `HTTP <status> <text>` (schemes-http #writeHeader).
    static #headerStatus(header: string): number | null {
        const m = /^HTTP (\d{3})\b/.exec(header);
        return m === null ? null : Number(m[1]);
    }

    static #urlPath(url: string): UrlPath {
        const u = new URL(url);
        const scheme = u.protocol.replace(":", "");
        return {
            kind: "url", raw: url, scheme,
            username: null, password: null, hostname: null, port: null,
            pathname: `/${u.hostname}${u.port.length > 0 ? `:${u.port}` : ""}${u.pathname}${u.search}`,
            params: {}, fragment: null,
        };
    }
}
