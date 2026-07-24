import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const OUTPUT_PATH = resolve("contracts/studio-programmatic-access-operations.json");
const args = process.argv.slice(2);
const check = args.includes("--check");
const stdout = args.includes("--stdout");
const sourceArg = args.find((arg) => arg !== "--check" && arg !== "--stdout" && arg !== "--");

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
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
};

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
  if (typeof operation.requestLocation !== "string" || operation.requestLocation.length === 0) {
    throw new Error(`Studio operation ${operation.operationId} has an invalid requestLocation.`);
  }
  if (typeof operation.wrapperTier !== "string" || operation.wrapperTier.length === 0) {
    throw new Error(`Studio operation ${operation.operationId} has an invalid wrapperTier.`);
  }
  if (
    operation.effectiveTier !== undefined &&
    operation.effectiveTier !== null &&
    (typeof operation.effectiveTier !== "object" || Array.isArray(operation.effectiveTier))
  ) {
    throw new Error(`Studio operation ${operation.operationId} has an invalid effectiveTier.`);
  }
  if (!Number.isInteger(operation.successStatus) || operation.successStatus < 100 || operation.successStatus > 599) {
    throw new Error(`Studio operation ${operation.operationId} has an invalid successStatus.`);
  }
  if (
    operation.pagination !== null &&
    (typeof operation.pagination !== "object" || Array.isArray(operation.pagination))
  ) {
    throw new Error(`Studio operation ${operation.operationId} has invalid pagination metadata.`);
  }
  if (
    operation.querySchema !== undefined &&
    operation.querySchema !== null &&
    (typeof operation.querySchema !== "object" || Array.isArray(operation.querySchema))
  ) {
    throw new Error(`Studio operation ${operation.operationId} has an invalid querySchema.`);
  }
  if (
    !Array.isArray(operation.stableErrorCodes) ||
    operation.stableErrorCodes.some((code) => typeof code !== "string" || code.length === 0)
  ) {
    throw new Error(`Studio operation ${operation.operationId} has invalid stableErrorCodes.`);
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
    requestLocation: operation.requestLocation,
    querySchema: canonicalize(operation.querySchema ?? null),
    wrapperTier: operation.wrapperTier,
    effectiveTier: canonicalize(operation.effectiveTier ?? null),
    successStatus: operation.successStatus,
    pagination: canonicalize(operation.pagination),
    stableErrorCodes: [...operation.stableErrorCodes].sort(),
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

if (stdout) {
  process.stdout.write(serialized);
} else if (check) {
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
