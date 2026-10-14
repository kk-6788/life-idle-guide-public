# -*- coding: utf-8 -*-
"""test_community.py — 本机社区服务单元测试

覆盖：pending 不公开、批准后可见、评论审核、重启持久化、隐藏、
输入验证（JSON 对象/字符串类型/长度/已知 activityId/已批准父帖）、
举报不自动封禁、跨站写入、8KB 限制、Content-Length 非法、静态越界保护。
"""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
import http.client

# 把 server/ 加入模块搜索路径，使测试可导入 app/community。
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SERVER_DIR = os.path.join(_PROJECT_ROOT, 'server')
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)

from community import (  # noqa: E402
    SQLiteStore,
    STATUS_APPROVED,
    STATUS_HIDDEN,
    STATUS_PENDING,
)
from app import build_server  # noqa: E402

ACTIVITY = 'cloud-watch'


class TestSQLiteStore(unittest.TestCase):
    """store 层：状态、可见性、重启持久化、举报。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, 'c.sqlite3')
        self.store = SQLiteStore(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_approved_post(self, text='hello'):
        pid = self.store.add_post(ACTIVITY, 'alice', text)
        self.assertTrue(self.store.set_status('post', pid, STATUS_APPROVED))
        return pid

    def test_pending_post_not_public_until_approved(self):
        pid = self.store.add_post(ACTIVITY, 'alice', '待审核')
        self.assertEqual([], self.store.list_posts())
        self.assertTrue(self.store.set_status('post', pid, STATUS_APPROVED))
        posts = self.store.list_posts()
        self.assertEqual(1, len(posts))
        self.assertEqual('待审核', posts[0]['text'])
        self.assertEqual(ACTIVITY, posts[0]['activityId'])

    def test_approved_visible_to_second_client(self):
        pid = self._seed_approved_post()
        # 第二个独立连接/实例看到相同数据（持久化一致性）。
        second = SQLiteStore(self.db)
        self.assertEqual(pid, second.list_posts()[0]['id'])

    def test_comment_needs_approval_to_be_public(self):
        pid = self._seed_approved_post()
        cid = self.store.add_comment(pid, 'bob', '评论')
        self.assertEqual([], self.store.list_posts()[0]['comments'])
        self.assertTrue(self.store.set_status('comment', cid, STATUS_APPROVED))
        comments = self.store.list_posts()[0]['comments']
        self.assertEqual(1, len(comments))
        self.assertEqual('评论', comments[0]['text'])

    def test_hidden_post_invisible(self):
        pid = self._seed_approved_post()
        self.assertTrue(self.store.set_status('post', pid, STATUS_HIDDEN))
        self.assertEqual([], self.store.list_posts())

    def test_hidden_comment_invisible(self):
        pid = self._seed_approved_post()
        cid = self.store.add_comment(pid, 'bob', '将被隐藏')
        self.assertTrue(self.store.set_status('comment', cid, STATUS_APPROVED))
        self.assertTrue(self.store.set_status('comment', cid, STATUS_HIDDEN))
        self.assertEqual([], self.store.list_posts()[0]['comments'])

    def test_persistence_across_restart(self):
        self._seed_approved_post('重启后仍在')
        # 重新打开同一数据库文件（模拟服务重启）。
        fresh = SQLiteStore(self.db)
        posts = fresh.list_posts()
        self.assertEqual(1, len(posts))
        self.assertEqual('重启后仍在', posts[0]['text'])

    def test_report_recorded_without_auto_ban(self):
        pid = self._seed_approved_post()
        rid = self.store.add_report('post', pid, '广告')
        self.assertTrue(rid >= 1)
        # 举报不自动隐藏/封禁：帖子仍可见。
        self.assertEqual(pid, self.store.list_posts()[0]['id'])
        self.assertTrue(self.store.target_exists('post', pid))

    def test_parent_status_lookup(self):
        pid = self.store.add_post(ACTIVITY, 'a', 'x')
        self.assertEqual(STATUS_PENDING, self.store.get_post_status(pid))
        self.assertIsNone(self.store.get_post_status(9999))

    def test_target_exists(self):
        pid = self.store.add_post(ACTIVITY, 'a', 'x')
        cid = self.store.add_comment(pid, 'b', 'c')
        self.assertTrue(self.store.target_exists('post', pid))
        self.assertTrue(self.store.target_exists('comment', cid))
        self.assertFalse(self.store.target_exists('post', 9999))
        self.assertFalse(self.store.target_exists('comment', 9999))

    def test_fresh_db_creates_parent_dirs(self):
        # 新解压工程没有 work 目录；默认首次启动必须自动创建 db 父目录。
        nested = os.path.join(self.tmp.name, 'sub', 'nested', 'fresh.sqlite3')
        store = SQLiteStore(nested)
        self.assertTrue(os.path.isfile(nested))
        self.assertEqual([], store.list_posts())

    def test_list_reports_returns_records(self):
        pid = self._seed_approved_post()
        self.store.add_report('post', pid, '广告推销')
        reports = self.store.list_reports()
        self.assertEqual(1, len(reports))
        self.assertEqual('post', reports[0]['target_type'])
        self.assertEqual(pid, reports[0]['target_id'])
        self.assertEqual('广告推销', reports[0]['reason'])
        self.assertTrue(reports[0]['created_at'])


class TestModerateReports(unittest.TestCase):
    """moderate.py 的 list 必须能让运营者看到举报（不悄悄写库）。"""

    def test_list_all_shows_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, 'sub', 'nested', 'moderate.sqlite3')
            store = SQLiteStore(db)
            pid = store.add_post(ACTIVITY, 'alice', '正文')
            store.set_status('post', pid, STATUS_APPROVED)
            store.add_report('post', pid, 'VISIBLE_REPORT_QA')
            run = subprocess.run(
                [sys.executable, '-X', 'utf8', os.path.join(_SERVER_DIR, 'moderate.py'),
                 '--db', db, 'list', '--all'],
                cwd=_PROJECT_ROOT, capture_output=True, encoding='utf-8')
            self.assertEqual(0, run.returncode, run.stderr)
            self.assertIn('VISIBLE_REPORT_QA', run.stdout)
            self.assertIn('正文', run.stdout)
            self.assertIn('report #1', run.stdout)
            self.assertIn('target=post#{}'.format(pid), run.stdout)


class _ServerCase(unittest.TestCase):
    """共享一个运行在本机回环地址的真实 HTTP 服务。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, 'http.sqlite3')
        cls.server = build_server(
            host='127.0.0.1', port=0, db_path=cls.db,
            activity_ids={ACTIVITY, 'blank-stare'},
        )
        cls.port = cls.server.server_address[1]
        cls._thread = threading.Thread(
            target=cls.server.serve_forever, daemon=True)
        cls._thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls._thread.join(timeout=5)
        cls.tmp.cleanup()

    def setUp(self):
        # 清空共享服务的数据，保证每个测试从干净库开始。
        conn = sqlite3.connect(self.db)
        try:
            for table in ('reports', 'comments', 'posts'):
                conn.execute('DELETE FROM {}'.format(table))
            conn.commit()
        finally:
            conn.close()

    # ---- 请求辅助 ----

    def _origin(self):
        return 'http://127.0.0.1:{}'.format(self.port)

    def request(self, method, path, body=None, headers=None, origin=True,
                content_type='application/json'):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        h = dict(headers or {})
        body_bytes = None
        if body is not None:
            if isinstance(body, bytes):
                body_bytes = body
            else:
                body_bytes = json.dumps(body).encode('utf-8')
            if content_type is not None:
                h['Content-Type'] = content_type
        if origin:
            h['Origin'] = self._origin()
        conn.request(method, path, body=body_bytes, headers=h)
        resp = conn.getresponse()
        data = resp.read()
        headers_out = resp.getheaders()
        conn.close()
        return resp.status, headers_out, data

    def json_of(self, data):
        return json.loads(data.decode('utf-8'))

    def approve(self, entry_type, entry_id):
        self.assertTrue(self.server.store.set_status(entry_type, entry_id, STATUS_APPROVED))

    def seed_post(self, text='你好', nickname='alice', activity=ACTIVITY):
        status, _, data = self.request(
            'POST', '/api/posts',
            {'activityId': activity, 'nickname': nickname, 'text': text})
        self.assertEqual(201, status)
        return self.json_of(data)['id']


class TestHTTPBasics(_ServerCase):
    def test_root_redirects_to_web(self):
        status, headers, _ = self.request('GET', '/', origin=False)
        self.assertEqual(302, status)
        self.assertEqual('/web/', dict(headers)['Location'])

    def test_status_endpoint(self):
        status, _, data = self.request('GET', '/api/status', origin=False)
        self.assertEqual(200, status)
        body = self.json_of(data)
        self.assertTrue(body['enabled'])
        self.assertEqual('local', body['mode'])
        self.assertTrue(body['notice'])


class TestStatic(_ServerCase):
    def test_serves_web_index(self):
        status, headers, data = self.request('GET', '/web/index.html', origin=False)
        self.assertEqual(200, status)
        self.assertIn(b'<html', data.lower() or b'')
        ct = dict(headers)['Content-Type']
        self.assertIn('text/html', ct)

    def test_serves_shared_json(self):
        status, _, data = self.request('GET', '/shared/content.json', origin=False)
        self.assertEqual(200, status)
        self.json_of(data)  # 合法 JSON

    def test_rejects_work_directory(self):
        status, _, _ = self.request('GET', '/work/anything', origin=False)
        self.assertIn(status, (403, 404))

    def test_rejects_server_directory(self):
        status, _, _ = self.request('GET', '/server/app.py', origin=False)
        self.assertIn(status, (403, 404))

    def test_rejects_traversal(self):
        status, _, _ = self.request('GET', '/web/../server/app.py', origin=False)
        self.assertIn(status, (403, 404))
        # 编码穿越同样被拒
        status2, _, _ = self.request(
            'GET', '/web/%2e%2e/server/app.py', origin=False)
        self.assertIn(status2, (403, 404))

    def test_rejects_hidden_file(self):
        status, _, _ = self.request('GET', '/web/.env', origin=False)
        self.assertIn(status, (403, 404))

    def test_rejects_database_extension(self):
        status, _, _ = self.request('GET', '/web/evil.sqlite3', origin=False)
        self.assertEqual(403, status)

    def test_unknown_file_404(self):
        status, _, _ = self.request('GET', '/web/nope.js', origin=False)
        self.assertEqual(404, status)

    def test_encoded_hidden_file_blocked(self):
        # 用 %2e 编码的隐藏文件名，解码后必须被拒（不能 200 读取）。
        fname = '.qa-hidden-' + uuid.uuid4().hex + '.txt'
        abs_path = os.path.join(_PROJECT_ROOT, 'web', fname)
        with open(abs_path, 'w', encoding='utf-8') as f:
            f.write('ONLY TEST MARKER')
        try:
            status, _, _ = self.request(
                'GET', '/web/%2e' + fname[1:], origin=False)
            self.assertIn(status, (400, 403, 404))
        finally:
            if os.path.exists(abs_path):
                os.unlink(abs_path)

    def test_null_byte_path_blocked(self):
        # 空字符不能进入 os 路径，必须 4xx 而非中断连接。
        status, _, _ = self.request('GET', '/web/a%00.js', origin=False)
        self.assertIn(status, (400, 403, 404))

    def test_encoded_backslash_blocked(self):
        status, _, _ = self.request('GET', '/web/%5c..%5cserver%5capp.py', origin=False)
        self.assertIn(status, (400, 403, 404))


class TestPosts(_ServerCase):
    def test_pending_post_not_in_get_until_approved(self):
        pid = self.seed_post('分享体验')
        status, _, data = self.request('GET', '/api/posts', origin=False)
        self.assertEqual(200, status)
        self.assertEqual([], self.json_of(data)['posts'])
        self.approve('post', pid)
        status, _, data = self.request('GET', '/api/posts', origin=False)
        posts = self.json_of(data)['posts']
        self.assertEqual(1, len(posts))
        self.assertEqual('分享体验', posts[0]['text'])

    def test_filter_by_activityId(self):
        pid = self.seed_post(text='云', activity=ACTIVITY)
        self.approve('post', pid)
        status, _, data = self.request(
            'GET', '/api/posts?activityId={}'.format(ACTIVITY), origin=False)
        self.assertEqual(ACTIVITY, self.json_of(data)['posts'][0]['activityId'])
        status2, _, data2 = self.request(
            'GET', '/api/posts?activityId=blank-stare', origin=False)
        self.assertEqual([], self.json_of(data2)['posts'])

    def test_create_post_valid(self):
        status, _, data = self.request(
            'POST', '/api/posts',
            {'activityId': ACTIVITY, 'nickname': '路人甲', 'text': ' 一条体验 '})
        self.assertEqual(201, status)
        body = self.json_of(data)
        self.assertEqual(STATUS_PENDING, body['status'])
        self.assertTrue(isinstance(body['id'], int))

    def test_create_post_non_object_400(self):
        status, _, data = self.request('POST', '/api/posts', [1, 2, 3])
        self.assertEqual(400, status)
        self.assertIn('error', self.json_of(data))

    def test_create_post_unknown_activity_400(self):
        status, _, data = self.request(
            'POST', '/api/posts',
            {'activityId': 'not-an-activity', 'nickname': 'a', 'text': 'x'})
        self.assertEqual(400, status)

    def test_create_post_wrong_types_400(self):
        cases = [
            {'activityId': 123, 'nickname': 'a', 'text': 'x'},
            {'activityId': ACTIVITY, 'nickname': 5, 'text': 'x'},
            {'activityId': ACTIVITY, 'nickname': 'a', 'text': {'bad': 1}},
        ]
        for payload in cases:
            status, _, _ = self.request('POST', '/api/posts', payload)
            self.assertEqual(400, status)

    def test_create_post_length_validation_400(self):
        too_long_text = 'x' * 501
        too_long_nick = 'y' * 21
        empty = '   '
        cases = [
            {'activityId': ACTIVITY, 'nickname': too_long_nick, 'text': 'ok'},
            {'activityId': ACTIVITY, 'nickname': 'a', 'text': too_long_text},
            {'activityId': ACTIVITY, 'nickname': 'a', 'text': empty},
        ]
        for payload in cases:
            status, _, _ = self.request('POST', '/api/posts', payload)
            self.assertEqual(400, status)

    def test_malicious_input_never_500(self):
        bad_bodies = [
            b'{invalid json',
            b'\xff\xfe\x00 garbage',
            b'null',
            b'"string"',
            b'12345',
        ]
        for raw in bad_bodies:
            status, _, _ = self.request('POST', '/api/posts', raw)
            self.assertLess(status, 500)

    def test_create_post_missing_fields_400(self):
        status, _, _ = self.request('POST', '/api/posts', {})
        self.assertEqual(400, status)


class TestComments(_ServerCase):
    def test_comment_on_pending_parent_403(self):
        pid = self.seed_post()
        status, _, data = self.request(
            'POST', '/api/posts/{}/comments'.format(pid),
            {'nickname': 'b', 'text': 'hi'})
        self.assertEqual(403, status)

    def test_comment_on_unknown_parent_404(self):
        status, _, _ = self.request(
            'POST', '/api/posts/99999/comments',
            {'nickname': 'b', 'text': 'hi'})
        self.assertEqual(404, status)

    def test_comment_on_approved_parent_pending_until_approved(self):
        pid = self.seed_post()
        self.approve('post', pid)
        status, _, data = self.request(
            'POST', '/api/posts/{}/comments'.format(pid),
            {'nickname': 'bob', 'text': '评论内容'})
        self.assertEqual(201, status)
        self.assertEqual(STATUS_PENDING, self.json_of(data)['status'])
        # 未批准前评论不可见
        _, _, posts = self.request('GET', '/api/posts', origin=False)
        self.assertEqual([], self.json_of(posts)['posts'][0]['comments'])
        cid = self.json_of(data)['id']
        self.approve('comment', cid)
        _, _, posts = self.request('GET', '/api/posts', origin=False)
        comments = self.json_of(posts)['posts'][0]['comments']
        self.assertEqual(1, len(comments))
        self.assertEqual('评论内容', comments[0]['text'])

    def test_comment_length_400(self):
        pid = self.seed_post()
        self.approve('post', pid)
        status, _, _ = self.request(
            'POST', '/api/posts/{}/comments'.format(pid),
            {'nickname': 'b', 'text': 'x' * 301})
        self.assertEqual(400, status)


class TestReports(_ServerCase):
    def test_report_created_and_no_auto_ban(self):
        pid = self.seed_post()
        self.approve('post', pid)
        status, _, data = self.request(
            'POST', '/api/reports',
            {'targetType': 'post', 'targetId': pid, 'reason': '广告推销'})
        self.assertEqual(201, status)
        self.assertEqual('received', self.json_of(data)['status'])
        # 举报后帖子仍然公开，不立即封禁。
        _, _, posts = self.request('GET', '/api/posts', origin=False)
        self.assertEqual(pid, self.json_of(posts)['posts'][0]['id'])

    def test_report_missing_target_404(self):
        status, _, _ = self.request(
            'POST', '/api/reports',
            {'targetType': 'post', 'targetId': 9999, 'reason': 'x'})
        self.assertEqual(404, status)

    def test_report_invalid_400(self):
        cases = [
            {'targetType': 'banana', 'targetId': 1, 'reason': 'x'},
            {'targetType': 'post', 'targetId': 'not-a-number', 'reason': 'x'},
            {'targetType': 'post', 'targetId': 1.5, 'reason': 'x'},
            {'targetType': 'post', 'targetId': 1, 'reason': 'x' * 201},
            {'targetType': 'post', 'targetId': 1, 'reason': '   '},
        ]
        for payload in cases:
            status, _, _ = self.request('POST', '/api/reports', payload)
            self.assertEqual(400, status)


class TestSecurity(_ServerCase):
    def test_cross_origin_write_rejected(self):
        pid = self.server.store.add_post(ACTIVITY, 'a', 'x')
        self.assertTrue(self.server.store.set_status('post', pid, STATUS_APPROVED))
        status, _, data = self.request(
            'POST', '/api/posts',
            {'activityId': ACTIVITY, 'nickname': 'evil', 'text': 'x'},
            origin=False,  # 覆盖为异站
            headers={'Origin': 'http://127.0.0.1.evil.com'},
        )
        self.assertEqual(403, status)
        self.assertIn('error', self.json_of(data))

    def test_prefix_like_origin_is_cross_origin(self):
        # 127.0.0.1:PORT.evil.com 的前缀不能当作同源。
        status, _, _ = self.request(
            'POST', '/api/posts',
            {'activityId': ACTIVITY, 'nickname': 'a', 'text': 'x'},
            origin=False,
            headers={'Origin': 'http://{}:9999.evil.com'.format(self.port)})
        self.assertEqual(403, status)

    def test_missing_origin_write_allowed(self):
        # 无 Origin（非浏览器客户端）允许写入。
        status, _, data = self.request(
            'POST', '/api/posts',
            {'activityId': ACTIVITY, 'nickname': 'a', 'text': 'ok'},
            origin=False)
        self.assertEqual(201, status)

    def test_non_json_content_type_415(self):
        status, _, _ = self.request(
            'POST', '/api/posts',
            'activityId=1', content_type='application/x-www-form-urlencoded')
        self.assertEqual(415, status)

    def test_body_over_8kb_413(self):
        huge = json.dumps(
            {'activityId': ACTIVITY, 'nickname': 'a', 'text': 'x' * 9000}
        ).encode('utf-8')
        status, _, _ = self.request('POST', '/api/posts', huge)
        self.assertEqual(413, status)

    def test_invalid_content_length_400(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.putrequest('POST', '/api/posts')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', 'abc')
        conn.putheader('Origin', self._origin())
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(400, resp.status)
        resp.read()
        conn.close()

    def test_missing_content_length_411(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.putrequest('POST', '/api/posts')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Origin', self._origin())
        conn.putheader('Transfer-Encoding', 'identity')
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(411, resp.status)
        resp.read()
        conn.close()

    def test_reads_do_not_require_origin(self):
        status, _, _ = self.request('GET', '/api/posts', origin=False)
        self.assertEqual(200, status)

    def test_https_same_port_origin_rejected(self):
        # https 同端口不被强制转成 http 后放行，必须精确同源。
        status, _, _ = self.request(
            'POST', '/api/posts',
            {'activityId': ACTIVITY, 'nickname': 'a', 'text': 'x'},
            origin=False,
            headers={'Origin': 'https://127.0.0.1:{}'.format(self.port)})
        self.assertEqual(403, status)

    def test_origin_with_path_rejected(self):
        # 伪 Origin 附带 /bad 路径，不得当作同源。
        status, _, _ = self.request(
            'POST', '/api/posts',
            {'activityId': ACTIVITY, 'nickname': 'a', 'text': 'x'},
            origin=False,
            headers={'Origin': 'http://127.0.0.1:{}/bad'.format(self.port)})
        self.assertEqual(403, status)

    def test_oversized_report_ids_rejected(self):
        # 越界整数/字符串/负数/布尔均须 4xx，不能 OverflowError。
        for target in (10 ** 30, str(10 ** 30), -1, True):
            status, _, _ = self.request(
                'POST', '/api/reports',
                {'targetType': 'post', 'targetId': target, 'reason': 'x'})
            self.assertGreaterEqual(status, 400)
            self.assertLess(status, 500)

    def test_oversized_comment_parent_rejected(self):
        status, _, _ = self.request(
            'POST', '/api/posts/{}/comments'.format(10 ** 30),
            {'nickname': 'b', 'text': 'hi'})
        self.assertEqual(400, status)

    def test_negative_comment_parent_rejected(self):
        status, _, _ = self.request(
            'POST', '/api/posts/-5/comments',
            {'nickname': 'b', 'text': 'hi'})
        self.assertIn(status, (400, 404))
        self.assertLess(status, 500)


if __name__ == '__main__':
    unittest.main()
