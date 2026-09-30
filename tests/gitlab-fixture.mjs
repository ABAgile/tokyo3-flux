// Loopback-only synthetic GitLab API for browser tests; never production data.
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8095' },
    evolving: { type: 'boolean', default: false },
  },
});
const port = Number(values.port);
const origin = `http://127.0.0.1:${port}`;
const KNOWN_USERS = [7, 42, 43];
const POSITIVE_INT = /^[1-9]\d*$/;
const TOKEN = 'fixture-read-secret';

const AVATAR_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02' +
    '0000000b49444154789c6360600000000400010d0a2db40000000049454e44ae426082',
  'hex',
);

const profile = (id, extra = {}) => ({
  id,
  username: `fixture-${id}`,
  name: `Fixture User ${id}`,
  avatar_url: `${origin}/uploads/avatar/${id}.png`,
  ...extra,
});
const counts = new Map();

function send(res, status, body, type = 'application/json') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': payload.length });
  res.end(payload);
}
const fail = (res, status) => send(res, status, { message: String(status) });

function route(req, res) {
  const url = new URL(req.url, origin);
  const path = url.pathname;
  const query = url.searchParams;
  if (/^\/uploads\/avatar\/[1-9]\d*\.png$/.test(path))
    return send(res, 200, AVATAR_PNG, 'image/png');
  if (req.headers['private-token'] !== TOKEN) return fail(res, 403);

  const user = path.match(/^\/api\/v4\/users\/([1-9]\d*)$/);
  if (user) {
    const id = Number(user[1]);
    return KNOWN_USERS.includes(id) ? send(res, 200, profile(id)) : fail(res, 404);
  }
  if (path === '/api/v4/users') {
    if (query.has('user_ids[]')) {
      return send(
        res,
        200,
        query
          .getAll('user_ids[]')
          .filter((id) => POSITIVE_INT.test(id))
          .map((id) => profile(Number(id))),
      );
    }
    const search = (query.get('search') ?? '').toLowerCase();
    return send(
      res,
      200,
      KNOWN_USERS.map((id) => profile(id, { state: 'active' })).filter(
        (u) =>
          !search ||
          u.username.toLowerCase().includes(search) ||
          u.name.toLowerCase().includes(search),
      ),
    );
  }
  if (path === '/api/v4/projects')
    return send(res, 200, [{ id: 42, name: 'Flux', path_with_namespace: 'team/flux' }]);
  if (path === '/api/v4/projects/42/merge_requests') {
    const mr = (iid, updated) => ({
      id: 100 + iid,
      iid,
      project_id: 42,
      title: `Fixture MR ${iid}`,
      state: 'opened',
      draft: false,
      updated_at: updated,
    });
    let list = [
      mr(7, '2026-09-11T00:00:00Z'),
      mr(8, '2026-09-10T00:00:00Z'),
      mr(9, '2026-09-09T00:00:00Z'),
    ];
    const search = (query.get('search') ?? '').toLowerCase();
    const iids = new Set(
      query
        .getAll('iids[]')
        .filter((v) => POSITIVE_INT.test(v))
        .map(Number),
    );
    if (search) list = list.filter((m) => m.title.toLowerCase().includes(search));
    if (iids.size) list = list.filter((m) => iids.has(m.iid));
    return send(res, 200, list);
  }
  const object = path.match(/^\/api\/v4\/projects\/42\/(merge_requests|pipelines)\/(\d+)$/);
  if (!object) return fail(res, 404);
  const kind = object[1];
  const number = Number(object[2]);
  if (number === 9) return fail(res, 503);
  // The count is keyed by the raw request target, so a query string counts separately.
  counts.set(req.url, (counts.get(req.url) ?? 0) + 1);
  const evolved = values.evolving && number === 7 && counts.get(req.url) > 1;
  const data = {
    id: kind === 'pipelines' ? number : 100 + number,
    project_id: 42,
    sha: evolved ? 'head-b' : 'head-a',
    updated_at: evolved ? '2026-09-10T00:01:00Z' : '2026-09-10T00:00:00Z',
    web_url: `${origin}/team/flux/-/${kind}/${number}`,
  };
  if (kind === 'merge_requests') {
    Object.assign(data, {
      iid: number,
      title: 'Fixture MR <script>never executed</script>',
      state: 'opened',
      draft: false,
      detailed_merge_status: 'not_approved',
      reviewers: [
        { id: 42, name: 'Alex Example', username: 'alex' },
        { id: 43, name: 'Blake Reviewer', username: 'blake' },
      ],
      head_pipeline: {
        id: 1000 + number,
        sha: number === 7 ? 'head-a' : 'old-head',
        status: 'success',
        web_url: `${origin}/team/flux/-/pipelines/${1000 + number}`,
      },
    });
  } else {
    data.status = 'failed';
  }
  return send(res, 200, data);
}

http.createServer(route).listen(port, '127.0.0.1');
