// #530 — the DETERMINISTIC web fixture for the gate variant of the web-search story. A release
// gate that generates its own nondeterminism can't distinguish flake from regression, so the
// gate runs canned content through the REAL machinery: a local SearXNG-shaped stub feeds the real
// search executor (PLURNK_EXECS_SEARCH_SEARXNG_URL is env-read per query), and the entry-sink's
// injectable WebFetch serves the canned pages the guard would otherwise refuse to fetch locally.
// The live-web form of the story survives as ad-hoc smoke, opt-in, out of the gate.

import { createServer, type Server } from "node:http";
import type { WebFetch } from "../../src/schemes/Exec.ts";

export const CANNED_VERSION = "24.4.1";

const PAGES: Record<string, string> = {
    "https://nodejs.example/blog/release": `# Node.js v${CANNED_VERSION} (LTS)\n\nThe latest stable Node.js release is v${CANNED_VERSION}, published this week. Download it from the official site.`,
    "https://devnews.example/node-latest": `Node.js news roundup: the current stable version is ${CANNED_VERSION}. Earlier releases remain in maintenance.`,
};

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
            results: Object.entries(PAGES).map(([pageUrl, body], i) => ({
                title: body.split("\n")[0].replace(/^#\s*/, ""),
                url: pageUrl,
                content: body.slice(0, 160),
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
            return body === undefined ? null : { body, mimetype: "text/markdown" };
        },
        close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
};
