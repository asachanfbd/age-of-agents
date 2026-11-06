import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { BUILTIN_SOFTWARE_TYPE, withBuiltinFallback } = await import('../src/lib/newBuildingDialog.ts');
const make = (id, extra = {}) => ({ ...BUILTIN_SOFTWARE_TYPE, id, name: id, repository: false, ...extra });

test('withBuiltinFallback offers the built-in Software entry only when there are no types', () => {
  assert.deepEqual(withBuiltinFallback([]), [BUILTIN_SOFTWARE_TYPE]);
  const loaded = [make('software'), make('seo')];
  assert.equal(withBuiltinFallback(loaded), loaded);
});

test('the built-in entry is a repository-backed Software type, so its form matches the daemon\'s', () => {
  assert.equal(BUILTIN_SOFTWARE_TYPE.id, 'software');
  assert.equal(BUILTIN_SOFTWARE_TYPE.repository, true);
  assert.equal(BUILTIN_SOFTWARE_TYPE.devOnly, false);
});
