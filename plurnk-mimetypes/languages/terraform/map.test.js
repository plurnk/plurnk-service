import { testLanguage } from "../../lib/testutil.js";

await testLanguage("terraform", {
	examplesDir: "vendor/grammars-v4/terraform/examples",
	extensions: [".tf"],
});
