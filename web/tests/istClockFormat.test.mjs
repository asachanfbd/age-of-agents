import assert from 'node:assert/strict';
import test from 'node:test';
import { formatISTClock } from '../src/lib/istTime.ts';

// IST = UTC+5:30, so these UTC instants map to the IST wall-clock times in the names.
const at = (utc) => formatISTClock(new Date(utc));

test('IST midnight reads 12:00:00 AM', () => assert.equal(at('2026-01-01T18:30:00Z'), '12:00:00 AM'));
test('IST noon reads 12:00:00 PM', () => assert.equal(at('2026-01-01T06:30:00Z'), '12:00:00 PM'));
test('morning hours stay AM and are zero-padded', () => assert.equal(at('2026-01-01T03:37:09Z'), '09:07:09 AM'));
test('afternoon hours convert to 12-hour PM', () => assert.equal(at('2026-01-01T09:37:09Z'), '03:07:09 PM'));
test('last second of the day reads 11:59:59 PM', () => assert.equal(at('2026-01-01T18:29:59Z'), '11:59:59 PM'));
