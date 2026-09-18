import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const workingDirectory = await mkdtemp(join(tmpdir(), "plurnk-mcp-test-"));
after(() => rm(workingDirectory, { recursive: true, force: true }));
