import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL_TYPES, nameKey, normaliseHandle, parseCountryCode } from '../src/crm/normalize.ts';
import type { ChannelType } from '../src/crm/normalize.ts';

const n = (type: ChannelType, raw: unknown, opts: { countryCode?: string | null; label?: string } = {}) => normaliseHandle(type, raw, opts);
const val = (type: ChannelType, raw: unknown, opts = {}) => { const r = n(type, raw, opts); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
const reason = (type: ChannelType, raw: unknown, opts = {}) => { const r = n(type, raw, opts); assert.ok(!r.ok); return r.reason; };

test('U001 email is trimmed and lower-cased', () => {
  assert.equal(val('email', '  Foo@Bar.COM '), 'foo@bar.com');
});
test('U002 email without @, empty, or with inner whitespace is rejected "Invalid email"', () => {
  for (const bad of ['nope', 'a b@c.de', 'a@b c.de']) assert.equal(reason('email', bad), 'Invalid email');
  assert.equal(reason('email', '   '), 'No handle');
});
test('U003 phone with + reduces to digits and ignores the default country code', () => {
  assert.equal(val('phone', '+49 (151) 234-567', { countryCode: '1' }), '49151234567');
});
test('U004 phone without + or 00 gets the default country code and drops one national leading 0', () => {
  assert.equal(val('phone', '0151 234567', { countryCode: '49' }), '49151234567');
  assert.equal(val('phone', '151234567', { countryCode: '49' }), '49151234567');
});
test('U005 phone starting 00 is an international prefix, same as +', () => {
  assert.equal(val('phone', '0049 151 234567', { countryCode: '1' }), val('phone', '+49 151 234567', { countryCode: '1' }));
});
test('U006 phone with no digits, or more than 15 digits, is rejected; full-width digits count', () => {
  assert.equal(reason('phone', 'abc'), 'Invalid phone');
  assert.equal(reason('phone', '+1234567890123456'), 'Invalid phone');
  assert.equal(val('phone', '+49１５１', {}), '49151');
  assert.equal(val('phone', '+123456789012345'), '123456789012345');
});
test('U007 phone with no country code set and no prefix keeps its digits and is flagged', () => {
  const r = n('phone', '0151 234567');
  assert.ok(r.ok);
  assert.equal(r.value, '0151234567');
  assert.equal((r as { noCountryCode?: boolean }).noCountryCode, true);
});
test('U008 Instagram URL, @, bare and trailing-slash forms all give tom.h', () => {
  for (const raw of ['https://www.instagram.com/Tom.H/?hl=en', 'instagram.com/tom.h', '@Tom.H', 'tom.h/']) assert.equal(val('instagram', raw), 'tom.h');
});
test('U009 Facebook and LinkedIn URLs reduce to a lower-cased handle; /in/ and /company/ do not collide', () => {
  for (const raw of ['https://m.facebook.com/Jane.Doe?ref=x#y', 'facebook.com/jane.doe/', '@Jane.Doe']) assert.equal(val('facebook', raw), 'jane.doe');
  assert.equal(val('linkedin', 'https://www.linkedin.com/in/Jane-Doe/'), 'in/jane-doe');
  assert.equal(val('linkedin', 'linkedin.com/company/Jane-Doe'), 'company/jane-doe');
  assert.notEqual(val('linkedin', 'linkedin.com/in/acme'), val('linkedin', 'linkedin.com/company/acme'));
});
test('U010 a social handle empty after stripping is rejected "No handle"', () => {
  for (const raw of ['@', 'instagram.com', 'https://www.instagram.com/']) assert.equal(reason('instagram', raw), 'No handle');
});
test('U011 other channel needs a label; the same handle under another label is a different handle', () => {
  assert.equal(reason('other', 'Handle', {}), 'Label required');
  assert.equal(val('other', ' Handle ', { label: 'Telegram' }), 'handle');
});
test('U012 same handle on two channel types is not a duplicate key; the same type is', () => {
  assert.equal(val('instagram', '@x'), val('facebook', '@x'));
  assert.equal(val('instagram', '@X'), val('instagram', 'x'));
});
test('U013 accents are kept, only case-folded; İ and ß fold deterministically', () => {
  assert.equal(val('instagram', '@Élodie'), 'élodie');
  assert.equal(val('email', 'STRAẞE@x.de'), 'straße@x.de'.toLowerCase());
  assert.equal(val('email', 'İ@x.com'), 'İ@x.com'.toLowerCase());
  assert.equal(nameKey('José García'), nameKey('jose garcia'));
});
test('U014 normalisation is idempotent for every channel type', () => {
  const samples: Record<ChannelType, string> = { email: ' A@B.com ', phone: '+49 151 234', instagram: 'https://instagram.com/A_b', facebook: 'fb.com/x', linkedin: 'linkedin.com/in/A', other: 'Zed' };
  for (const type of CHANNEL_TYPES) {
    const once = val(type, samples[type], { label: 'L' });
    assert.equal(val(type, once, { label: 'L' }), once, type);
  }
});
test('U131 default country code accepts 1-3 digits with or without +; others are refused', () => {
  assert.equal(parseCountryCode('+49'), '49');
  assert.equal(parseCountryCode('1'), '1');
  assert.equal(parseCountryCode(''), null);
  for (const bad of ['abc', '0', '9999', '+']) assert.throws(() => parseCountryCode(bad), RangeError);
});

test('U050 phone with letters or other text is rejected, including a "+" or "00" after leading text', () => {
  for (const bad of ['Tarun Gera, +919910166500', 'call 0049 151 234567', 'ext 5', '+49,151', '12a34', '+49 151 x']) {
    assert.equal(reason('phone', bad, { countryCode: '91' }), 'Invalid phone', bad);
  }
});
test('U051 phone accepts digits with spaces, dashes, dots, parentheses and slashes', () => {
  assert.equal(val('phone', '+49 151-234.567'), '49151234567');
  assert.equal(val('phone', '(0151) 234/567', { countryCode: '49' }), '49151234567');
});
