---
"@plurnk/plurnk-mcp": minor
---

An enabled server that cannot run keeps its alias, registered out of service;
a call to it is refused with the state that keeps it from running
({§mcp-unavailable-runtime}). A request refused for want of a sign-in — a tool
call, a resource or prompt read, or a completion — on a URL-only or interactive
OAuth definition fails `401 authorization-required` and republishes its alias
awaiting a sign-in ({§mcp-request-unauthorized}).
