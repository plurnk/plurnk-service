// #530 — the DETERMINISTIC web fixture for the gate variant of the web-search story. A release
// gate that generates its own nondeterminism can't distinguish flake from regression, so the
// gate runs canned content through the REAL machinery: a local SearXNG-shaped stub feeds the real
// search executor (PLURNK_EXECS_SEARCH_SEARXNG_URL is env-read per query), and the entry-sink's
// injectable WebFetch serves the canned pages the guard would otherwise refuse to fetch locally.
// The live-web form remains enabled as discovery coverage; these canned pages
// pin deterministic search→materialize→retrieve behavior.

import { createServer, type Server } from "node:http";
import type { WebFetch } from "../../src/schemes/Exec.ts";

const RESULTS = [
    { title: "Official Node.js release page", url: "https://nodejs.example/blog/release", content: "The authoritative release page contains the current stable version." },
    { title: "Node.js news roundup", url: "https://devnews.example/node-latest", content: "A secondary report discusses the current stable release." },
    { title: "Project Aurora inference report", url: "https://research.example/aurora", content: "The report contains a measured inference-cost result." },
    { title: "Treasury AI infrastructure interview", url: "https://finance.example/interview", content: "The transcript contains Secretary Rowan's exact answer." },
];

export interface CannedWeb {
    searxngUrl: string;
    fetchWeb: WebFetch;
    facts: {
        version: string;
        savings: string;
        quote: string;
    };
    evidence: {
        node: string;
        aurora: string;
        rowan: string;
    };
    close: () => Promise<void>;
}

export const cannedWeb = async (): Promise<CannedWeb> => {
    const sentinel = crypto.randomUUID().toUpperCase();
    const facts = {
        version: "24.4.1",
        savings: "37 percent",
        quote: "the bottleneck is power, not demand",
    };
    const evidence = {
        node: `NODE-${sentinel}`,
        aurora: `AURORA-${sentinel}`,
        rowan: `ROWAN-${sentinel}`,
    };
    // Search summaries intentionally omit both answers and per-fixture evidence.
    // The only route to a sentinel is the primary page's materialized body.
    const pages: Record<string, string> = {
        "https://nodejs.example/blog/release": `# Node.js v${facts.version} (LTS)\n\nThe latest stable Node.js release is v${facts.version}, published this week. Primary-source evidence code: ${evidence.node}.`,
        "https://devnews.example/node-latest": "Node.js news roundup: the current stable release is discussed on the official project page.",
        "https://research.example/aurora": `# Aurora inference report\n\nProject Aurora reduced inference cost by ${facts.savings} after switching its batching strategy. Primary-source evidence code: ${evidence.aurora}.`,
        "https://finance.example/interview": `# Treasury interview transcript\n\nAsked about AI infrastructure, Secretary Rowan said “${facts.quote}.” Primary-source evidence code: ${evidence.rowan}.`,
    };
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/search") { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            results: RESULTS.map((result, i) => ({
                ...result,
                publishedDate: `2026-07-${10 + i}`,
            })),
        }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("canned searxng stub failed to bind");
    return {
        searxngUrl: `http://127.0.0.1:${address.port}`,
        fetchWeb: async (pageUrl: string) => {
            const body = pages[pageUrl];
            return body === undefined ? null : {
                body,
                mimetype: "text/markdown",
                // Match the production WebFetcher contract: a page fetched
                // moments ago is immediately readable from the stored entry,
                // not re-fetched from the reserved .example hostname.
                header: `HTTP 200 OK\ncontent-type: text/markdown\nx-plurnk-fetched-at: ${new Date().toISOString()}`,
            };
        },
        facts,
        evidence,
        close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
};
