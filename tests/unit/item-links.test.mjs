// Pasted GitLab merge-request URLs: canonical form, sub-page stripping and rejections.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const modules = '../../internal/planningui/static/modules';
const { resolveGitLabMRURL } = await import(`${modules}/item-links.js`);

const projects = [
  { id: 42, path_with_namespace: 'team/flux' },
  { id: 43, path_with_namespace: 'team/sub/tools' },
  { id: 44, path_with_namespace: 'team/unapproved' },
];
function board(instance = 'https://gitlab.example') {
  return { connector_instance: instance, integration: { instance, projects: [42, 43] } };
}
const resolve = (url, currentBoard = board()) => resolveGitLabMRURL(url, currentBoard, projects);

test('a canonical MR URL resolves to its project and IID', () => {
  assert.deepEqual(resolve('https://gitlab.example/team/flux/-/merge_requests/7'), {
    project: 42,
    kind: 'mr',
    number: 7,
  });
  assert.deepEqual(
    resolve('https://gitlab.example/team/sub/tools/-/merge_requests/12').project,
    43,
  );
});

test('MR sub-pages, query and hash are stripped', () => {
  for (const suffix of [
    '/',
    '/diffs',
    '/commits',
    '/pipelines',
    '/diffs/',
    '?tab=x',
    '#note_9',
    '/diffs?a=1#b',
  ])
    assert.deepEqual(
      resolve(`https://gitlab.example/team/flux/-/merge_requests/7${suffix}`),
      { project: 42, kind: 'mr', number: 7 },
      suffix,
    );
});

test('a GitLab instance under a sub-path is honoured', () => {
  const nested = board('https://example.com/gitlab');
  assert.equal(
    resolve('https://example.com/gitlab/team/flux/-/merge_requests/3/diffs', nested).number,
    3,
  );
  assert.throws(
    () => resolve('https://example.com/other/team/flux/-/merge_requests/3', nested),
    /outside/,
  );
});

test('non-MR, malformed or foreign URLs are rejected', () => {
  const reject = (url, pattern) => assert.throws(() => resolve(url), pattern, url);
  reject('', /Paste a GitLab/);
  reject('not a url', /valid GitLab/);
  reject('https://other.example/team/flux/-/merge_requests/7', /configured GitLab instance/);
  reject('https://gitlab.example/team/flux/-/issues/7', /canonical/);
  reject('https://gitlab.example/team/flux/-/merge_requests/', /canonical/);
  reject('https://gitlab.example/team/flux/-/merge_requests/abc/diffs', /canonical/);
  reject('https://gitlab.example/team/flux/-/merge_requests/0', /canonical/);
  reject('https://gitlab.example/-/merge_requests/7', /canonical/);
  reject('https://gitlab.example/team/unapproved/-/merge_requests/7', /approved/);
  reject('https://gitlab.example/team/unknown/-/merge_requests/7', /approved/);
});
