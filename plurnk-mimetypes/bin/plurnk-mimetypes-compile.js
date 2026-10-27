#!/usr/bin/env node
import { runCompile } from "../dist/index.js";

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`Usage: plurnk-mimetypes-compile

Compile ANTLR4 grammars in ./grammar/ to ./src/generated/ via antlr-ng,
targeting TypeScript output. Rewrites .js import extensions to .ts so
Node's native TS resolution works without a build step.

Run from a handler repo's root directory.`);
} else {
    runCompile().then(
        () => { console.log("Compile complete."); },
        (err) => {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        },
    );
}
