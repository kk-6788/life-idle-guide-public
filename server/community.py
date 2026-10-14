# -*- coding: utf-8 -*-
"""community.py — SQLite 数据访问层（本机社区服务）

使用 Python 标准库 sqlite3，仅参数化 SQL。
每次操作独立打开连接并关闭，避免跨线程共享连接（线程独立连接）。
表：posts / comments / reports。帖子与评论状态 pending / approved / hidden。
举报只记录，不自动封禁。
"""

import os
import sqlite3
import threading
import time
from datetime import datetime, timezone

STATUS_PENDING = 'pending'
STATUS_APPROVED = 'approved'
STATUS_HIDDEN = 'hidden'

VALID_STATUSES = (STATUS_PENDING, STATUS_APPROVED, STATUS_HIDDEN)


def _now():
    """ISO 8601 UTC 时间字符串，形如 2026-09-29T04:00:00Z。"""
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class SQLiteStore:
    """对 posts / comments / reports 的持久化访问。

    线程安全：每个线程每次操作使用独立连接；跨线程不共享 sqlite3 连接。
    """

    def __init__(self, db_path):
        self.db_path = db_path
        self._lock = threading.Lock()
        # 新解压/首次启动可能不存在 work 目录；连接前先创建数据库父目录。
        parent = os.path.dirname(os.path.abspath(db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._ensure_schema()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        return conn

    def _ensure_schema(self):
        conn = self._connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS posts (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    activity_id TEXT    NOT NULL,
                    nickname    TEXT    NOT NULL,
                    text        TEXT    NOT NULL,
                    status      TEXT    NOT NULL DEFAULT 'pending',
                    created_at  TEXT    NOT NULL
                );
                CREATE TABLE IF NOT EXISTS comments (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    post_id    INTEGER NOT NULL REFERENCES posts(id),
                    nickname   TEXT    NOT NULL,
                    text       TEXT    NOT NULL,
                    status     TEXT    NOT NULL DEFAULT 'pending',
                    created_at TEXT    NOT NULL
                );
                CREATE TABLE IF NOT EXISTS reports (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_type TEXT    NOT NULL,
                    target_id   INTEGER NOT NULL,
                    reason      TEXT    NOT NULL,
                    created_at  TEXT    NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_posts_activity ON posts(activity_id);
                CREATE INDEX IF NOT EXISTS idx_comments_post  ON comments(post_id);
                """
            )
            conn.commit()
        finally:
            conn.close()

    # ---------- 写入 ----------

    def add_post(self, activity_id, nickname, text):
        conn = self._connect()
        try:
            cur = conn.execute(
                'INSERT INTO posts (activity_id, nickname, text, status, created_at) '
                'VALUES (?, ?, ?, ?, ?)',
                (activity_id, nickname, text, STATUS_PENDING, _now()),
            )
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def add_comment(self, post_id, nickname, text):
        conn = self._connect()
        try:
            cur = conn.execute(
                'INSERT INTO comments (post_id, nickname, text, status, created_at) '
                'VALUES (?, ?, ?, ?, ?)',
                (post_id, nickname, text, STATUS_PENDING, _now()),
            )
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def add_report(self, target_type, target_id, reason):
        conn = self._connect()
        try:
            cur = conn.execute(
                'INSERT INTO reports (target_type, target_id, reason, created_at) '
                'VALUES (?, ?, ?, ?)',
                (target_type, target_id, reason, _now()),
            )
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def set_status(self, entry_type, entry_id, status):
        """把帖子或评论置为指定状态。返回是否真的影响了一行。"""
        if status not in VALID_STATUSES:
            raise ValueError('invalid status')
        table = 'posts' if entry_type == 'post' else 'comments'
        conn = self._connect()
        try:
            cur = conn.execute(
                'UPDATE {} SET status = ? WHERE id = ?'.format(table),
                (status, entry_id),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()

    # ---------- 读取 ----------

    def get_post_status(self, post_id):
        """返回帖子状态；不存在返回 None。用于“仅已批准父帖才能评论”。"""
        conn = self._connect()
        try:
            row = conn.execute(
                'SELECT status FROM posts WHERE id = ?', (post_id,)
            ).fetchone()
            return row['status'] if row else None
        finally:
            conn.close()

    def target_exists(self, target_type, target_id):
        """举报目标是否存在（帖子或评论）。"""
        table = 'posts' if target_type == 'post' else 'comments'
        conn = self._connect()
        try:
            row = conn.execute(
                'SELECT 1 FROM {} WHERE id = ?'.format(table), (target_id,)
            ).fetchone()
            return row is not None
        finally:
            conn.close()

    def list_posts(self, activity_id=None):
        """仅返回已批准（approved）的帖子及其已批准评论；hidden/pending 不可见。"""
        conn = self._connect()
        try:
            if activity_id is not None:
                rows = conn.execute(
                    'SELECT * FROM posts WHERE status = ? AND activity_id = ? '
                    'ORDER BY id',
                    (STATUS_APPROVED, activity_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    'SELECT * FROM posts WHERE status = ? ORDER BY id',
                    (STATUS_APPROVED,),
                ).fetchall()

            posts = []
            for r in rows:
                comments = conn.execute(
                    'SELECT id, nickname, text, created_at FROM comments '
                    'WHERE post_id = ? AND status = ? ORDER BY id',
                    (r['id'], STATUS_APPROVED),
                ).fetchall()
                posts.append({
                    'id': r['id'],
                    'activityId': r['activity_id'],
                    'nickname': r['nickname'],
                    'text': r['text'],
                    'createdAt': r['created_at'],
                    'comments': [
                        {
                            'id': c['id'],
                            'nickname': c['nickname'],
                            'text': c['text'],
                            'createdAt': c['created_at'],
                        }
                        for c in comments
                    ],
                })
            return posts
        finally:
            conn.close()

    def list_entries(self, entry_type, status=None):
        """审核视图：列出帖子或评论。status 可选，None 表示全部。"""
        table = 'posts' if entry_type == 'post' else 'comments'
        conn = self._connect()
        try:
            if status is not None:
                rows = conn.execute(
                    'SELECT * FROM {} WHERE status = ? ORDER BY id'.format(table),
                    (status,),
                ).fetchall()
            else:
                rows = conn.execute(
                    'SELECT * FROM {} ORDER BY id'.format(table)
                ).fetchall()
            result = []
            for r in rows:
                d = dict(r)
                d['type'] = entry_type
                if entry_type == 'post':
                    d['activityId'] = d.pop('activity_id')
                else:
                    d['postId'] = d.pop('post_id')
                result.append(d)
            return result
        finally:
            conn.close()

    def list_reports(self):
        """列出所有举报记录，供本机运营者处理。"""
        conn = self._connect()
        try:
            rows = conn.execute(
                'SELECT * FROM reports ORDER BY id').fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
