import { resolve } from "node:path";
import { inspectRelease } from "./inspect-release.mjs";

const directory = resolve(process.argv[2] ?? "release-assets");
process.stdout.write(`${JSON.stringify(inspectRelease(directory))}\n`);
