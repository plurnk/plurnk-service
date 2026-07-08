#!/usr/bin/env node

// Boot the #353 mock OAuth server standalone — the cross-stack /auth validation surface for the
// client (plurnk#116). Prints the base URL and the one env var to point a daemon's MCP target at it,
// then serves until SIGINT. RFC 8628 Device Authorization Grant: no redirect, no loopback — the
// /token endpoint returns authorization_pending on the first poll and the bearer thereafter, so the
// client's poll loop runs browserless:
//
//   node bin/mock-oauth.ts                       # → base URL on stdout
//   PLURNK_EXECS_MCP_TESTAUTH=<base>/mcp plurnk-service # the daemon's `testauth` target
//   /auth testauth                                # in the client — authorize, then poll to authorized
import { mockOAuthServer } from "../test/_mock-oauth.ts";

if (import.meta.main) {
    const { base } = await mockOAuthServer();
    process.stdout.write(`${base}\n`);
    process.stderr.write(`mock-oauth: serving RFC 9728 discovery → DCR → device authorization → token poll (pending → authorized)\nmock-oauth: point a daemon at it with PLURNK_EXECS_MCP_TESTAUTH=${base}/mcp\n`);
}
