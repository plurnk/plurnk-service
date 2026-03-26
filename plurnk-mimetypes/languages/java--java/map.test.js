import { testLanguage } from "../../lib/testutil.js";

await testLanguage("java--java", {
	examplesDir: "vendor/grammars-v4/java/java/examples",
	extensions: [".java"],
});
