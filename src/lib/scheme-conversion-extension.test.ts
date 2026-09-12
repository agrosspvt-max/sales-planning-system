import assert from "node:assert/strict";
import {
  UNLIMITED_EXTENSION_ATTEMPTS,
  extensionAttemptsEnabled,
  hasExtensionAttemptsRemaining,
  isConversionExtensionStatusEligible,
  isWithinConversionExtensionDayLimit,
} from "./scheme-conversion-extension";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

test("-1 allows repeated extension attempts", () => {
  assert.equal(extensionAttemptsEnabled(UNLIMITED_EXTENSION_ATTEMPTS), true);
  for (const attemptsUsed of [0, 1, 20, 1000]) {
    assert.equal(hasExtensionAttemptsRemaining(attemptsUsed, UNLIMITED_EXTENSION_ATTEMPTS), true);
  }
});

test("0 remains disabled", () => {
  assert.equal(extensionAttemptsEnabled(0), false);
  assert.equal(hasExtensionAttemptsRemaining(0, 0), false);
});

test("positive numeric attempt limits are unchanged", () => {
  assert.equal(hasExtensionAttemptsRemaining(0, 2), true);
  assert.equal(hasExtensionAttemptsRemaining(1, 2), true);
  assert.equal(hasExtensionAttemptsRemaining(2, 2), false);
  assert.equal(hasExtensionAttemptsRemaining(3, 2), false);
});

test("maxExtensionDays is still enforced with unlimited attempts", () => {
  assert.equal(hasExtensionAttemptsRemaining(500, UNLIMITED_EXTENSION_ATTEMPTS), true);
  assert.equal(isWithinConversionExtensionDayLimit(30, 29, 1), true);
  assert.equal(isWithinConversionExtensionDayLimit(30, 29, 2), false);
  assert.equal(isWithinConversionExtensionDayLimit(30, 30, 1), false);
});

test("existing plan status and verification restrictions remain enforced", () => {
  for (const status of ["PENDING_RM", "PENDING_APPROVAL", "APPROVED"]) {
    assert.equal(isConversionExtensionStatusEligible(status, "PENDING", false), true);
  }
  for (const status of ["DRAFT", "RETURNED", "REJECTED"]) {
    assert.equal(isConversionExtensionStatusEligible(status, "PENDING", false), false);
  }
  assert.equal(isConversionExtensionStatusEligible("APPROVED", "CONVERTED", false), false);
  assert.equal(isConversionExtensionStatusEligible("APPROVED", "PENDING", true), false);
});

console.log(`\n${passed} conversion-extension contracts passed`);

