#!/usr/bin/env node
import { cli } from "../dist/compile.js";

cli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
