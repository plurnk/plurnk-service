import { testLanguage } from "../../lib/testutil.js";

await testLanguage("dockerfile", {
	examplesDir: "languages/dockerfile/examples",
	extensions: [".dockerfile"],
});
