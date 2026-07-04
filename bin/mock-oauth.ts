#!/usr/bin/env node

// Boot the #306 mock OAuth server standalone — the cross-stack /auth validation surface for the
// client (plurnk#116). Prints the base URL and the one env var to point a daemon's MCP target at
// it, then serves until SIGINT. The /authorize endpoint 302s straight back to the caller's
// redirect_uri with a code (+ echoed state), so the whole flow runs browserless:
//
//   node bin/mock-oauth.ts                       # → base URL on stdout
//   PLURNK_EXECS_MCP_TESTAUTH=<base>/mcp plurnk-service # the daemon's `testauth` target
//   /auth testauth                                # in the client — full loop, no browser
import { mockOAuthServer } from "../test/_mock-oauth.ts";

if (import.meta.main) {
    const { base } = await mockOAuthServer();
    process.stdout.write(`${base}\n`);
    process.stderr.write(`mock-oauth: serving RFC 9728 discovery → DCR → authorize (302s back with a code) → token\nmock-oauth: point a daemon at it with PLURNK_EXECS_MCP_TESTAUTH=${base}/mcp\n`);
}
