import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const OUTPUT_PATH = resolve("contracts/studio-programmatic-access-operations.json");
const args = process.argv.slice(2);
const check = args.includes("--check");
const sourceArg = args.find((arg) => arg !== "--check" && arg !== "--");

if (!sourceArg) {
  throw new Error(
    "Usage: pnpm run contract:sync -- /path/to/programmatic-access-contract.json\n" +
      "   or: pnpm run contract:check -- /path/to/programmatic-access-contract.json",
  );
}

const sourcePath = resolve(sourceArg);
const source = JSON.parse(await readFile(sourcePath, "utf8"));

if (typeof source.contractId !== "string" || !/^[a-z][a-z0-9-]*$/.test(source.contractId)) {
  throw new Error("Studio contractId must be a non-empty lowercase kebab-case identifier.");
}
if (!Number.isInteger(source.revision) || source.revision < 1) {
  throw new Error("Studio contract revision must be a positive integer.");
}
if (!Array.isArray(source.operations)) {
  throw new Error("Studio contract operations must be an array.");
}

const operationIds = new Set();
const operationKeys = new Set();
const operations = source.operations.map((operation, index) => {
  if (
    typeof operation.operationId !== "string" ||
    operation.operationId.length === 0 ||
    typeof operation.method !== "string" ||
    !/^[A-Z]+$/.test(operation.method) ||
    typeof operation.path !== "string" ||
    !operation.path.startsWith("/api/v1")
  ) {
    throw new Error(`Studio operation at index ${index} has an invalid operationId, method, or path.`);
  }
  if (operation.requestLocation === "query") {
    if (Object.hasOwn(operation, "requestSchema")) {
      throw new Error(
        `Query operation ${operation.operationId} uses stale requestSchema; query operations must use querySchema.`,
      );
    }
  }

  const key = `${operation.method} ${operation.path}`;
  if (operationIds.has(operation.operationId)) {
    throw new Error(`Duplicate Studio operationId: ${operation.operationId}`);
  }
  if (operationKeys.has(key)) {
    throw new Error(`Duplicate Studio operation key: ${key}`);
  }
  operationIds.add(operation.operationId);
  operationKeys.add(key);

  return {
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
  };
});

operations.sort(
  (a, b) =>
    a.operationId.localeCompare(b.operationId) || a.method.localeCompare(b.method) || a.path.localeCompare(b.path),
);

const projection = {
  contractId: source.contractId,
  revision: source.revision,
  operations,
};
const serialized = `${JSON.stringify(projection, null, 2)}\n`;

if (check) {
  const current = await readFile(OUTPUT_PATH, "utf8");
  if (current !== serialized) {
    throw new Error(`Studio contract projection is stale. Run: pnpm run contract:sync -- ${sourceArg}`);
  }
  console.log(
    `Studio contract projection is synchronized (${operations.length} operations, revision ${source.revision}).`,
  );
} else {
  await writeFile(OUTPUT_PATH, serialized);
  console.log(`Wrote ${OUTPUT_PATH} (${operations.length} operations, revision ${source.revision}).`);
}
