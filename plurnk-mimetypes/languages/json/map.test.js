import { testLanguage } from "../../lib/testutil.js";

await testLanguage("json", {
	examplesDir: "vendor/grammars-v4/json/examples",
	extensions: [".json"],
});
