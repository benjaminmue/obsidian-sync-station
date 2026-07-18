import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/auth.js";

test("hashPassword produces a scrypt hash that verifies", () => {
  const hash = hashPassword("correct horse battery");
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword("correct horse battery", hash), true);
});

test("verifyPassword rejects wrong password", () => {
  const hash = hashPassword("secret-one");
  assert.equal(verifyPassword("secret-two", hash), false);
});

test("verifyPassword rejects null / malformed stored hash", () => {
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", "not-a-hash"), false);
  assert.equal(verifyPassword("x", "scrypt$onlysalt"), false);
});

test("two hashes of the same password differ (unique salt)", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});
