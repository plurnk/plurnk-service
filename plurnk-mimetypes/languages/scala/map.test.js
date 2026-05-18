import { testLanguage } from "../../lib/testutil.js";

await testLanguage("scala", {
	examplesDir: "vendor/grammars-v4/scala/scala2/examples",
	extensions: [".scala"],
});
