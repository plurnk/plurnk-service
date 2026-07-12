import { describe, it } from "node:test";
import { runConformance } from "./harness.ts";

// bash.ts is FLAT (function defs carry no container), so a call's container is
// the bare name of the enclosing function def (its body span); top-level
// commands have none. Local function calls join; external commands are dead
// rows by design.
const SOURCE = `#!/usr/bin/env bash
# deploy helper script

greet() {
  echo "hello there"
}

main() {
  greet world
  log_message "starting up"
}

log_message() {
  printf '%s\\n' "$1"
}

main
`;

describe("conformance: text/x-shellscript refs (SPEC §16)", () => {
    it("command calls join to local functions; externals are dead rows", async () => {
        await runConformance({
            mimetype: "text/x-shellscript",
            source: SOURCE,
            decoyNames: ["deploy", "hello", "there", "starting"],
            expectJoins: [
                { refName: "greet", container: "main" },
                { refName: "log_message", container: "main" },
            ],
            expectRefs: [
                { name: "greet", kind: "call" },
                { name: "echo", kind: "call" },
                { name: "main", kind: "call" },
            ],
        });
    });
});
