// #530 — the DETERMINISTIC web fixture for the gate variant of the web-search story. A release
// gate that generates its own nondeterminism can't distinguish flake from regression, so the
// gate runs canned content through the REAL machinery: a local SearXNG-shaped stub feeds the real
// search executor (PLURNK_EXECS_SEARCH_SEARXNG_URL is env-read per query), and the entry-sink's
// injectable WebFetch serves the canned pages the guard would otherwise refuse to fetch locally.
// The live-web form remains enabled as discovery coverage; these canned pages
// pin deterministic search→materialize→retrieve behavior.

import { createServer, type Server } from "node:http";
import type { WebFetch } from "../../src/schemes/Exec.ts";

export const CANNED_VERSION = "24.4.1";
export const CANNED_SAVINGS = "37 percent";
export const CANNED_QUOTE = "the bottleneck is power, not demand";

const PAGES: Record<string, string> = {
    "https://nodejs.example/blog/release": `# Node.js v${CANNED_VERSION} (LTS)\n\nThe latest stable Node.js release is v${CANNED_VERSION}, published this week. Download it from the official site.`,
    "https://devnews.example/node-latest": `Node.js news roundup: the current stable version is ${CANNED_VERSION}. Earlier releases remain in maintenance.`,
    "https://research.example/aurora": `# Aurora inference report\n\nProject Aurora reduced inference cost by ${CANNED_SAVINGS} after switching its batching strategy. The report separates measured savings from projections.`,
    "https://finance.example/interview": `# Treasury interview transcript\n\nAsked about AI infrastructure, Secretary Rowan said “${CANNED_QUOTE}.” The transcript was published Tuesday.`,
};

const RESULTS = [
    { title: "Official Node.js release page", url: "https://nodejs.example/blog/release", content: "The authoritative release page contains the current stable version." },
    { title: "Node.js news roundup", url: "https://devnews.example/node-latest", content: "A secondary report discusses the current stable release." },
    { title: "Project Aurora inference report", url: "https://research.example/aurora", content: "The report contains a measured inference-cost result." },
    { title: "Treasury AI infrastructure interview", url: "https://finance.example/interview", content: "The transcript contains Secretary Rowan's exact answer." },
];

export interface CannedWeb {
    searxngUrl: string;
    fetchWeb: WebFetch;
    close: () => Promise<void>;
}

export const cannedWeb = async (): Promise<CannedWeb> => {
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
            const body = PAGES[pageUrl];
            return body === undefined ? null : {
                body,
                mimetype: "text/markdown",
                // Match the production WebFetcher contract: a page fetched
                // moments ago is immediately readable from the stored entry,
                // not re-fetched from the reserved .example hostname.
                header: `HTTP 200 OK\ncontent-type: text/markdown\nx-plurnk-fetched-at: ${new Date().toISOString()}`,
            };
        },
        close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
};
