import { testLanguage } from "../../lib/testutil.js";

await testLanguage("r", {
	examplesDir: "vendor/grammars-v4/r/examples",
	extensions: [".r", ".R"],
});
