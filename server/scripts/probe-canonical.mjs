/**
 * Evidence digest checks.
 *
 * The property that makes verification work at all is idempotence: an artifact
 * is hashed, stored in a JSONB column, read back and re-hashed, so
 * canonicalJson(JSON.parse(stored)) must equal canonicalJson(content) exactly.
 */
import { canonicalJson, sha256Json } from "../dist/security.js";

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
};
const eq = (a, b) => a === b;
const same = (value, label) => check(eq(canonicalJson(value), canonicalJson(JSON.parse(JSON.stringify(value)))), label);

// 1. key order is irrelevant
check(canonicalJson({ b: 1, a: 2 }) === canonicalJson({ a: 2, b: 1 }), "object key order is normalised");
check(canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}', "keys sort lexicographically");

// 2. array order is significant
check(canonicalJson([1, 2]) !== canonicalJson([2, 1]), "array order is preserved");

// 3. the round trip that storage performs
same({ z: [1, { y: null, x: undefined }], a: "s", n: 1.5, nested: { deep: [{ k: true }] } }, "deep round trip is stable");
same({ s: "unicode ✓ – €", sym: "0xAbC" }, "string round trip is stable");
same({ negative: -0, big: 1e21, small: 1e-7 }, "numeric literals round trip");
same([null, true, false, 0, ""], "primitive array round trip");
same({}, "empty object round trip");
same([], "empty array round trip");

// 4. normalisation matches what JSON.stringify would have stored
check(canonicalJson(undefined) === "null", "undefined becomes null (array slot)");
check(canonicalJson({ a: undefined, b: 1 }) === '{"b":1}', "undefined members are dropped");
check(canonicalJson(NaN) === "null", "NaN becomes null");
check(canonicalJson(Infinity) === "null", "Infinity becomes null");
check(canonicalJson(10n) === '"10"', "bigint becomes a decimal string");
check(canonicalJson(new Date("2026-01-02T03:04:05.678Z")) === '"2026-01-02T03:04:05.678Z"', "Date uses toJSON");
check(
  canonicalJson({ toJSON: () => ({ b: 1, a: 2 }) }) === '{"a":2,"b":1}',
  "custom toJSON is honoured"
);

// 5. cycles are rejected rather than silently truncated
let threw = false;
try {
  const cyc = { a: 1 };
  cyc.self = cyc;
  canonicalJson(cyc);
} catch {
  threw = true;
}
check(threw, "circular structures are rejected");

// 6. the reported failure mode
const legacy = { provenance: { collectedBy: "a@b.c", collectedAt: "2026-01-01T00:00:00.000Z" } };
check(sha256Json(legacy) !== sha256Json(null), "legacy no-data seal does not verify against its own payload");
check(
  sha256Json({ data: null, provenance: legacy.provenance }) === sha256Json({ data: null, provenance: legacy.provenance }),
  "new envelope seal is self-consistent"
);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
