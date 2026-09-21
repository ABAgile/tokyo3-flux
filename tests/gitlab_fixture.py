#!/usr/bin/env python3
"""Loopback-only synthetic GitLab API for browser tests; never production data."""
import argparse
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


AVATAR_PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02'
    '0000000b49444154789c6360600000000400010d0a2db40000000049454e44ae426082'
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8095)
    parser.add_argument('--evolving', action='store_true')
    args = parser.parse_args()
    counts, lock = {}, threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlsplit(self.path)
            if re.fullmatch(r'/uploads/avatar/[1-9]\d*\.png', parsed.path):
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(AVATAR_PNG)))
                self.end_headers()
                self.wfile.write(AVATAR_PNG)
                return
            if self.headers.get('PRIVATE-TOKEN') != 'fixture-read-secret':
                self.send_error(403)
                return
            user_match = re.fullmatch(r'/api/v4/users/([1-9]\d*)', parsed.path)
            if user_match:
                user_id = int(user_match.group(1))
                if user_id not in (7, 42, 43):
                    self.send_error(404)
                    return
                user = dict(id=user_id, username=f'fixture-{user_id}', name=f'Fixture User {user_id}', avatar_url=f'http://127.0.0.1:{args.port}/uploads/avatar/{user_id}.png')
                body = json.dumps(user).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == '/api/v4/users':
                query = parse_qs(parsed.query)
                users = []
                if 'user_ids[]' in query:
                    for raw_id in query.get('user_ids[]', []):
                        if re.fullmatch(r'[1-9]\d*', raw_id):
                            user_id = int(raw_id)
                            users.append(dict(id=user_id, username=f'fixture-{user_id}', name=f'Fixture User {user_id}', avatar_url=f'http://127.0.0.1:{args.port}/uploads/avatar/{user_id}.png'))
                else:
                    search = query.get('search', [''])[0].lower()
                    for user_id in (7, 42, 43):
                        user = dict(id=user_id, username=f'fixture-{user_id}', name=f'Fixture User {user_id}', avatar_url=f'http://127.0.0.1:{args.port}/uploads/avatar/{user_id}.png', state='active')
                        if not search or search in user['username'].lower() or search in user['name'].lower():
                            users.append(user)
                body = json.dumps(users).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == '/api/v4/projects':
                body = json.dumps([dict(id=42, name='Flux', path_with_namespace='team/flux')]).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == '/api/v4/projects/42/merge_requests':
                merge_requests = [
                    dict(id=107, iid=7, project_id=42, title='Fixture MR 7', state='opened', draft=False, updated_at='2026-09-11T00:00:00Z'),
                    dict(id=108, iid=8, project_id=42, title='Fixture MR 8', state='opened', draft=False, updated_at='2026-09-10T00:00:00Z'),
                    dict(id=109, iid=9, project_id=42, title='Fixture MR 9', state='opened', draft=False, updated_at='2026-09-09T00:00:00Z'),
                ]
                query = parse_qs(parsed.query)
                search = query.get('search', [''])[0].lower()
                iids = {int(value) for value in query.get('iids[]', []) if re.fullmatch(r'[1-9]\d*', value)}
                if search:
                    merge_requests = [mr for mr in merge_requests if search in mr['title'].lower()]
                if iids:
                    merge_requests = [mr for mr in merge_requests if mr['iid'] in iids]
                body = json.dumps(merge_requests).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            match = re.fullmatch(r'/api/v4/projects/42/(merge_requests|pipelines)/(\d+)', parsed.path)
            if not match:
                self.send_error(404)
                return
            kind, number = match.group(1), int(match.group(2))
            if number == 9:
                self.send_error(503)
                return
            with lock:
                counts[self.path] = counts.get(self.path, 0) + 1
                evolved = args.evolving and number == 7 and counts[self.path] > 1
            sha = 'head-b' if evolved else 'head-a'
            data = dict(id=number if kind == 'pipelines' else 100 + number,
                        project_id=42, sha=sha,
                        updated_at='2026-09-10T00:01:00Z' if evolved else '2026-09-10T00:00:00Z',
                        web_url=f'http://127.0.0.1:{args.port}/team/flux/-/{kind}/{number}')
            if kind == 'merge_requests':
                data.update(iid=number, title='Fixture MR <script>never executed</script>',
                            state='opened', draft=False, detailed_merge_status='not_approved',
                            reviewers=[dict(id=42, name='Alex Example', username='alex'),
                                       dict(id=43, name='Blake Reviewer', username='blake')],
                            head_pipeline=dict(id=1000 + number,
                                               sha='head-a' if number == 7 else 'old-head',
                                               status='success',
                                               web_url=f'http://127.0.0.1:{args.port}/team/flux/-/pipelines/{1000 + number}'))
            else:
                data.update(status='failed')
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
