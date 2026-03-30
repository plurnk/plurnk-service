import { testLanguage } from "../../lib/testutil.js";

await testLanguage("objc", {
	examplesDir: "vendor/grammars-v4/objc/examples",
	extensions: [".m", ".h"],
});
