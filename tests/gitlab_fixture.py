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
            if parsed.path == '/api/v4/users':
                users = []
                for raw_id in parse_qs(parsed.query).get('user_ids[]', []):
                    if re.fullmatch(r'[1-9]\d*', raw_id):
                        user_id = int(raw_id)
                        users.append(dict(id=user_id, username=f'fixture-{user_id}', name=f'Fixture User {user_id}', avatar_url=f'http://127.0.0.1:{args.port}/uploads/avatar/{user_id}.png'))
                body = json.dumps(users).encode()
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
                        web_url=f'http://127.0.0.1:{args.port}/group/project/-/{kind}/{number}')
            if kind == 'merge_requests':
                data.update(iid=number, title='Fixture MR <script>never executed</script>',
                            state='opened', draft=False, detailed_merge_status='not_approved',
                            head_pipeline=dict(id=1000 + number,
                                               sha='head-a' if number == 7 else 'old-head',
                                               status='success'))
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
