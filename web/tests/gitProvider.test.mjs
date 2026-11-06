import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const { gitProviderOf, repositoryLinkOf, GIT_PROVIDERS } = await import('../src/lib/gitProvider.ts');

test('a Project with no stored provider, or github, reads as GitHub', () => {
  assert.equal(gitProviderOf({}), 'github');
  assert.equal(gitProviderOf({ gitProvider: 'github' }), 'github');
  assert.deepEqual(GIT_PROVIDERS.map((provider) => provider.id), ['github']);
});

test('repository links normalize every accepted remote and reject unsafe or other-host URLs', () => {
  for (const remote of [
    'https://github.com/Owner/repo', 'https://github.com/Owner/repo/', 'https://github.com/Owner/repo.git',
    'git@github.com:Owner/repo.git', 'git@github.com:Owner/repo', 'git@github.com:Owner/repo/',
    'git@github.com-work:Owner/repo.git', 'git@ssh.github.com:Owner/repo.git',
  ]) assert.deepEqual(repositoryLinkOf({ repositoryUrl: remote }), { slug: 'Owner/repo', repository: 'https://github.com/Owner/repo' });
  for (const remote of [undefined, '', 'https://gitlab.com/Owner/repo', 'https://github.com/Owner', 'https://github.com/Owner/repo/extra', 'https://github.com/Owner/repo?x=1', 'https://github.com/./repo', 'https://github.com/Owner/.git', 'git@host:Owner/repo;echo bad']) {
    assert.equal(repositoryLinkOf({ repositoryUrl: remote }), null);
  }
});
