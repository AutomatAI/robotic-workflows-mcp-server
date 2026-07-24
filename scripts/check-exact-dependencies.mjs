import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const invalid = [];

for (const section of ["dependencies", "devDependencies"]) {
  for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
    if (typeof version !== "string" || !exactVersion.test(version)) {
      invalid.push(`${section}.${name}=${JSON.stringify(version)}`);
    }
  }
}

if (invalid.length > 0) {
  console.error(`Dependencies must use exact semantic versions:\n${invalid.join("\n")}`);
  process.exitCode = 1;
}
