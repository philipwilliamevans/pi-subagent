import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCallIndex,
  validateMaxEvents,
  validateMaxOutputLength,
  MAX_PEEK_EVENTS_LIMIT,
  MAX_OUTPUT_LENGTH_LIMIT,
} from "../types.ts";

// ---------------------------------------------------------------------------
// validateCallIndex
// ---------------------------------------------------------------------------

test("validateCallIndex returns null for undefined", () => {
  assert.equal(validateCallIndex(undefined, 5), null);
});

test("validateCallIndex returns null for valid integer", () => {
  assert.equal(validateCallIndex(0, 5), null);
  assert.equal(validateCallIndex(3, 5), null);
  assert.equal(validateCallIndex(5, 5), null);
});

test("validateCallIndex rejects fractional number", () => {
  const err = validateCallIndex(1.5, 5);
  assert.match(err, /Invalid callIndex 1\.5/);
  assert.match(err, /non-negative integer/);
});

test("validateCallIndex rejects negative number", () => {
  const err = validateCallIndex(-1, 5);
  assert.match(err, /Invalid callIndex -1/);
  assert.match(err, /non-negative integer/);
});

test("validateCallIndex rejects NaN", () => {
  const err = validateCallIndex(NaN, 5);
  assert.match(err, /Invalid callIndex NaN/);
  assert.match(err, /non-negative integer/);
});

test("validateCallIndex rejects Infinity", () => {
  const err = validateCallIndex(Infinity, 5);
  assert.match(err, /Invalid callIndex Infinity/);
  assert.match(err, /non-negative integer/);
});

test("validateCallIndex rejects string", () => {
  const err = validateCallIndex("0", 5);
  assert.match(err, /Invalid callIndex 0/);
  assert.match(err, /non-negative integer/);
});

test("validateCallIndex rejects out-of-range value showing valid range", () => {
  const err = validateCallIndex(10, 5);
  assert.match(err, /Invalid callIndex 10/);
  assert.match(err, /0–5/);
  assert.match(err, /6 calls/);
});

test("validateCallIndex shows correct singular for single result", () => {
  const err = validateCallIndex(1, 0);
  assert.match(err, /Invalid callIndex 1/);
  assert.match(err, /1 call/);
  assert.match(err, /0–0/);
});

// ---------------------------------------------------------------------------
// validateMaxOutputLength
// ---------------------------------------------------------------------------

test("validateMaxOutputLength returns null for undefined", () => {
  assert.equal(validateMaxOutputLength(undefined), null);
});

test("validateMaxOutputLength returns null for valid integer", () => {
  assert.equal(validateMaxOutputLength(1), null);
  assert.equal(validateMaxOutputLength(500), null);
  assert.equal(validateMaxOutputLength(MAX_OUTPUT_LENGTH_LIMIT), null);
});

test("validateMaxOutputLength rejects 0", () => {
  const err = validateMaxOutputLength(0);
  assert.match(err, /Invalid maxOutputLength 0/);
  assert.match(err, /integer from 1 to/);
});

test("validateMaxOutputLength rejects negative", () => {
  const err = validateMaxOutputLength(-1);
  assert.match(err, /Invalid maxOutputLength -1/);
  assert.match(err, /integer from 1 to/);
});

test("validateMaxOutputLength rejects fractional", () => {
  const err = validateMaxOutputLength(2.5);
  assert.match(err, /Invalid maxOutputLength 2\.5/);
  assert.match(err, /integer from 1 to/);
});

test("validateMaxOutputLength rejects NaN", () => {
  const err = validateMaxOutputLength(NaN);
  assert.match(err, /Invalid maxOutputLength NaN/);
  assert.match(err, /integer from 1 to/);
});

test("validateMaxOutputLength rejects value above limit", () => {
  const err = validateMaxOutputLength(MAX_OUTPUT_LENGTH_LIMIT + 1);
  assert.match(err, new RegExp(`Invalid maxOutputLength ${MAX_OUTPUT_LENGTH_LIMIT + 1}`));
  assert.match(err, /integer from 1 to/);
  assert.match(err, new RegExp(String(MAX_OUTPUT_LENGTH_LIMIT)));
});

test("validateMaxOutputLength rejects string", () => {
  const err = validateMaxOutputLength("100");
  assert.match(err, /Invalid maxOutputLength 100/);
  assert.match(err, /integer from 1 to/);
});

// ---------------------------------------------------------------------------
// validateMaxEvents
// ---------------------------------------------------------------------------

test("validateMaxEvents returns null for undefined and valid integer", () => {
  assert.equal(validateMaxEvents(undefined), null);
  assert.equal(validateMaxEvents(1), null);
  assert.equal(validateMaxEvents(20), null);
  assert.equal(validateMaxEvents(MAX_PEEK_EVENTS_LIMIT), null);
});

test("validateMaxEvents rejects invalid values", () => {
  assert.match(validateMaxEvents(0), /Invalid maxEvents 0/);
  assert.match(validateMaxEvents(-1), /Invalid maxEvents -1/);
  assert.match(validateMaxEvents(1.5), /Invalid maxEvents 1\.5/);
  assert.match(validateMaxEvents("20"), /Invalid maxEvents 20/);
  assert.match(
    validateMaxEvents(MAX_PEEK_EVENTS_LIMIT + 1),
    new RegExp(`Invalid maxEvents ${MAX_PEEK_EVENTS_LIMIT + 1}`),
  );
});
