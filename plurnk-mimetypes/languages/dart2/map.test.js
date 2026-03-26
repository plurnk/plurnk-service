import { testLanguage } from "../../lib/testutil.js";

await testLanguage("dart2", {
	examplesDir: "vendor/grammars-v4/dart2/examples",
	extensions: [".dart"],
	maxFiles: 50,
});
