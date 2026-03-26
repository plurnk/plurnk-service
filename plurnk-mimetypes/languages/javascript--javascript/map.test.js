import { testLanguage } from "../../lib/testutil.js";

await testLanguage("javascript--javascript", {
	examplesDir: "vendor/grammars-v4/javascript/javascript/examples",
	extensions: [".js"],
});
