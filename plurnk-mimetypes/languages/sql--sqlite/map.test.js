import { testLanguage } from "../../lib/testutil.js";

await testLanguage("sql--sqlite", {
	examplesDir: "vendor/grammars-v4/sql/sqlite/examples",
	extensions: [".sql"],
});
