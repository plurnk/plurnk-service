import { testLanguage } from "../../lib/testutil.js";

await testLanguage("thrift", {
	examplesDir: "vendor/grammars-v4/thrift/examples",
	extensions: [".thrift"],
});
