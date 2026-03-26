import { testLanguage } from "../../lib/testutil.js";

await testLanguage("zig", {
	examplesDir: "vendor/grammars-v4/zig/examples",
	extensions: [".zig"],
});
