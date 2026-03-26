import { testLanguage } from "../../lib/testutil.js";

await testLanguage("c", {
	examplesDir: "vendor/grammars-v4/c/examples",
	extensions: [".c", ".h"],
	maxFiles: 50,
});
