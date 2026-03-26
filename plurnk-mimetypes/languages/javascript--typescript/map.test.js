import { testLanguage } from "../../lib/testutil.js";

await testLanguage("javascript--typescript", {
	examplesDir: "vendor/grammars-v4/javascript/typescript/examples",
	extensions: [".ts", ".tsx"],
});
