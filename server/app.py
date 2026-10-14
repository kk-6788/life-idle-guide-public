# -*- coding: utf-8 -*-
"""app.py — 本机社区 HTTP 服务（Python 标准库）

- 仅绑定 127.0.0.1，默认端口 8765（--port / --db 可覆盖）。
- 静态服务只允许 web/ 与 shared/ 内的页面/JS/CSS/JSON 及安全资源；
  拒绝 work/、server/、隐藏文件、数据库及越界路径；根 / 重定向到 /web/。
- API：
    GET  /api/status
    GET  /api/posts?activityId=   （仅已批准帖子/评论）
    POST /api/posts                JSON {activityId,nickname,text}
    POST /api/posts/:id/comments   JSON {nickname,text}（仅已批准父帖）
    POST /api/reports              JSON {targetType,targetId,reason}
- 写入防护：跨站 Origin 拒绝、仅 application/json、请求体 ≤ 8KB、
  基础写入节流（单调时间 + 锁，不影响只读）、恶意输入一律 4xx。
"""

import argparse
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from community import (
    SQLiteStore,
    STATUS_APPROVED,
    STATUS_PENDING,
)

HOST = '127.0.0.1'
DEFAULT_PORT = 8765
MAX_BODY = 8 * 1024  # 8KB
WRITE_WINDOW = 10.0  # 秒
WRITE_LIMIT = 20     # 每窗口最大写入次数
# SQLite 有符号 64 位主键上限；超出会在绑定参数时抛 OverflowError。
MAX_DB_ID = 2 ** 63 - 1


def is_valid_db_id(value):
    """数据库 ID 须为 1..2^63-1 的整数；布尔值不算。"""
    if isinstance(value, bool) or not isinstance(value, int):
        return False
    return 1 <= value <= MAX_DB_ID

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(PROJECT_ROOT, 'work', 'community.sqlite3')
CONTENT_PATH = os.path.join(PROJECT_ROOT, 'shared', 'content.json')

# 静态资源允许的目录（相对项目根）。
STATIC_ROOTS = ('web', 'shared')
# 允许的扩展名（含安全资源）。
ALLOWED_EXT = {
    '.html', '.htm', '.js', '.css', '.json',
    '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
    '.txt', '.woff', '.woff2', '.ttf', '.map', '.webmanifest',
}

CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
    '.webmanifest': 'application/manifest+json',
}


def load_activity_ids():
    """从 shared/content.json 读取已知 activityId 集合。"""
    try:
        with open(CONTENT_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, list):
            return {str(item.get('id')) for item in data if isinstance(item, dict) and item.get('id')}
    except (OSError, ValueError):
        pass
    return set()


def clean_str(value, min_len, max_len):
    """去首尾空白后校验长度与类型。合法返回清洗后的字符串，否则返回 None。"""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not (min_len <= len(cleaned) <= max_len):
        return None
    return cleaned


class CommunityServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, store, project_root, activity_ids):
        self.store = store
        self.project_root = project_root
        self.activity_ids = activity_ids
        # 写入限流状态（锁 + 单调时间），只影响写，不影响读。
        self.write_lock = threading.Lock()
        self.write_times = []
        super().__init__(addr, CommunityHandler)


class CommunityHandler(BaseHTTPRequestHandler):
    server_version = 'LifeIdle/1.0'

    # ---------- 公共 ----------

    @property
    def store(self):
        return self.server.store

    def _expected_origin(self):
        """本机同源应形如 http://127.0.0.1:PORT。精确比对，不用前缀。"""
        port = self.server.server_port
        return 'http://127.0.0.1:{}'.format(port)

    def _check_origin(self):
        """写入需本机同源。无 Origin 视为非浏览器（允许）；异站拒绝。

        同源判定：与期望值 http://127.0.0.1:PORT 做整串精确比对。
        Origin 不含 path/query/fragment，故任何带后缀、异 scheme、异主机的
        Origin 都不可能等于该字符串，天然拒绝 https、127.0.0.1.evil.com、
        附加 /bad 等伪装值。
        """
        origin = self.headers.get('Origin')
        if origin is None:
            return True
        return origin == self._expected_origin()

    # ---------- 发送 ----------

    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _send_error_json(self, code, message):
        self._send_json(code, {'error': message})

    # ---------- 请求体 ----------

    def _read_body(self):
        """读取请求体，校验 Content-Length 合法性及 8KB 上限。

        返回 bytes；校验失败时已写好错误响应并返回 None。
        """
        raw = self.headers.get('Content-Length')
        if raw is None:
            self._send_error_json(411, 'Content-Length required')
            return None
        if not raw.isdigit():
            self._send_error_json(400, 'invalid Content-Length')
            return None
        length = int(raw)
        if length > MAX_BODY:
            self._send_error_json(413, 'request body too large')
            return None
        body = self.rfile.read(length)
        if len(body) != length:
            self._send_error_json(400, 'body length mismatch')
            return None
        return body

    def _throttle(self):
        """写入节流：单调时间 + 锁，超限返回 False。不影响读。"""
        now = time.monotonic()
        with self.server.write_lock:
            self.server.write_times = [
                t for t in self.server.write_times if now - t < WRITE_WINDOW
            ]
            if len(self.server.write_times) >= WRITE_LIMIT:
                return False
            self.server.write_times.append(now)
            return True

    def _parse_json_object(self):
        """校验 Content-Type、读取并解析 JSON 对象。

        成功返回 dict；失败已写好错误响应并返回 None。
        """
        ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if ctype != 'application/json':
            self._send_error_json(415, 'Content-Type must be application/json')
            return None
        body = self._read_body()
        if body is None:
            return None
        try:
            data = json.loads(body.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            self._send_error_json(400, 'invalid JSON body')
            return None
        if not isinstance(data, dict):
            self._send_error_json(400, 'JSON body must be an object')
            return None
        return data

    # ---------- GET ----------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/':
            self._redirect('/web/')
            return
        if path == '/api/status':
            self._send_json(200, {
                'enabled': True,
                'mode': 'local',
                'notice': '本机体验版，尚未公开上线',
            })
            return
        if path == '/api/posts':
            qs = parse_qs(parsed.query)
            activity_id = qs.get('activityId', [None])[0]
            if activity_id == '':
                activity_id = None
            posts = self.store.list_posts(activity_id)
            self._send_json(200, {'posts': posts})
            return
        if path.startswith('/api/'):
            self._send_error_json(404, 'not found')
            return

        self._serve_static(path)

    # ---------- POST ----------

    def do_POST(self):
        if not self._check_origin():
            self._send_error_json(403, 'cross-origin write rejected')
            return
        data = self._parse_json_object()
        if data is None:
            return
        if not self._throttle():
            self._send_error_json(429, 'too many requests')
            return

        path = urlparse(self.path).path
        if path == '/api/posts':
            self._create_post(data)
            return
        m = re.fullmatch(r'/api/posts/(\d+)/comments', path)
        if m:
            post_id = int(m.group(1))
            if not is_valid_db_id(post_id):
                self._send_error_json(400, 'invalid post id')
                return
            self._create_comment(post_id, data)
            return
        if path == '/api/reports':
            self._create_report(data)
            return
        self._send_error_json(404, 'not found')

    def _create_post(self, data):
        activity_id = data.get('activityId')
        if not isinstance(activity_id, str) or activity_id.strip() == '':
            self._send_error_json(400, 'activityId required')
            return
        activity_id = activity_id.strip()
        if activity_id not in self.server.activity_ids:
            self._send_error_json(400, 'unknown activityId')
            return
        nickname = clean_str(data.get('nickname'), 1, 20)
        if nickname is None:
            self._send_error_json(400, 'nickname must be 1..20 chars')
            return
        text = clean_str(data.get('text'), 1, 500)
        if text is None:
            self._send_error_json(400, 'text must be 1..500 chars')
            return
        post_id = self.store.add_post(activity_id, nickname, text)
        self._send_json(201, {'id': post_id, 'status': STATUS_PENDING})

    def _create_comment(self, post_id, data):
        post_status = self.store.get_post_status(post_id)
        if post_status is None:
            self._send_error_json(404, 'post not found')
            return
        if post_status != STATUS_APPROVED:
            self._send_error_json(403, 'parent post not approved')
            return
        nickname = clean_str(data.get('nickname'), 1, 20)
        if nickname is None:
            self._send_error_json(400, 'nickname must be 1..20 chars')
            return
        text = clean_str(data.get('text'), 1, 300)
        if text is None:
            self._send_error_json(400, 'text must be 1..300 chars')
            return
        comment_id = self.store.add_comment(post_id, nickname, text)
        self._send_json(201, {'id': comment_id, 'status': STATUS_PENDING})

    def _create_report(self, data):
        target_type = data.get('targetType')
        if target_type not in ('post', 'comment'):
            self._send_error_json(400, 'targetType must be post or comment')
            return
        target_id = data.get('targetId')
        # 允许整数或纯数字字符串；布尔/浮点/越界一律拒绝，避免 OverflowError。
        if isinstance(target_id, bool) or isinstance(target_id, float):
            self._send_error_json(400, 'invalid targetId')
            return
        if isinstance(target_id, int):
            tid = target_id
        elif isinstance(target_id, str) and target_id.isdigit():
            tid = int(target_id)
        else:
            self._send_error_json(400, 'invalid targetId')
            return
        if not is_valid_db_id(tid):
            self._send_error_json(400, 'invalid targetId')
            return
        reason = clean_str(data.get('reason'), 1, 200)
        if reason is None:
            self._send_error_json(400, 'reason must be 1..200 chars')
            return
        if not self.store.target_exists(target_type, tid):
            self._send_error_json(404, 'target not found')
            return
        # 只记录，不自动封禁。
        self.store.add_report(target_type, tid, reason)
        self._send_json(201, {'status': 'received'})

    # ---------- 静态服务 ----------

    def _serve_static(self, path):
        root_name = None
        if path.startswith('/web/'):
            root_name = 'web'
            rel = path[len('/web/'):]
        elif path.startswith('/shared/'):
            root_name = 'shared'
            rel = path[len('/shared/'):]
        else:
            self._send_error_json(404, 'not found')
            return

        if not rel:
            # /web/ 或 /shared/ 默认入口。
            if root_name == 'web':
                self._redirect('/web/index.html')
            else:
                self._send_error_json(404, 'not found')
            return

        # 先解码，再统一校验，避免用 %2e / %5c 等编码绕过隐藏/穿越检查。
        try:
            rel = unquote(rel)
        except Exception:
            self._send_error_json(400, 'bad path')
            return

        # 空字符会使 os 路径函数抛错，明确拒绝（4xx 而非中断连接）。
        if '\x00' in rel:
            self._send_error_json(400, 'bad path')
            return

        segments = rel.split('/')
        if any(seg == '' or seg.startswith('.') or seg == '..' for seg in segments):
            self._send_error_json(403, 'forbidden')
            return

        # 拒绝 URL 解码后的原始反斜杠与穿越片段。
        if '\\' in rel or '..' in rel.split('/'):
            self._send_error_json(403, 'forbidden')
            return

        # 仅允许安全扩展名（不直接放行数据库等二进制）。
        ext = os.path.splitext(rel)[1].lower()
        if ext not in ALLOWED_EXT:
            self._send_error_json(403, 'file type not allowed')
            return

        try:
            root_real = os.path.realpath(os.path.join(self.server.project_root, root_name))
            fs = os.path.realpath(os.path.join(root_real, rel))
        except (ValueError, OSError):
            self._send_error_json(400, 'bad path')
            return

        # 越界保护：必须落在根目录之内。
        if not (fs == root_real or fs.startswith(root_real + os.sep)):
            self._send_error_json(403, 'forbidden')
            return

        try:
            if not os.path.isfile(fs):
                self._send_error_json(404, 'not found')
                return
        except (ValueError, OSError):
            self._send_error_json(400, 'bad path')
            return

        try:
            with open(fs, 'rb') as f:
                content = f.read()
        except OSError:
            self._send_error_json(500, 'read error')
            return

        self.send_response(200)
        self.send_header('Content-Type', CONTENT_TYPES.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(content)

    # 抑制默认请求日志噪音。
    def log_message(self, fmt, *args):
        return


def build_server(host=HOST, port=DEFAULT_PORT, db_path=DEFAULT_DB,
                 project_root=PROJECT_ROOT, activity_ids=None):
    """构造服务实例（不启动）。db_path 可指向临时文件供测试使用。"""
    store = SQLiteStore(db_path)
    if activity_ids is None:
        activity_ids = load_activity_ids()
    return CommunityServer((host, port), store, project_root, set(activity_ids))


def main(argv=None):
    parser = argparse.ArgumentParser(description='人生浪费指南 — 本机社区服务')
    # 只监听本机回环地址，不允许绑定公网（计划要求）。
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help='监听端口（默认 8765）')
    parser.add_argument('--db', default=DEFAULT_DB, help='SQLite 数据库路径')
    args = parser.parse_args(argv)

    server = build_server(port=args.port, db_path=args.db)
    print('life-idle community server on http://{}:{}'.format(HOST, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
