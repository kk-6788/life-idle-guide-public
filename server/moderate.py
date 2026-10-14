# -*- coding: utf-8 -*-
"""moderate.py — 本机社区审核命令行（仅本机使用，无匿名管理员 HTTP 接口）

用法：
    python moderate.py [--db PATH] list [--all]
    python moderate.py [--db PATH] approve --type post|comment --id ID
    python moderate.py [--db PATH] hide    --type post|comment --id ID

list 除帖子/评论外，同时列出用户举报（时间 / 目标 / 原因），
默认仅列 pending 内容；--all 列出全部帖子/评论与所有举报。

默认数据库与 app.py 一致：<项目根>/work/community.sqlite3。
"""

import argparse
import os
import sys

from community import (
    SQLiteStore,
    STATUS_APPROVED,
    STATUS_HIDDEN,
    STATUS_PENDING,
)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(PROJECT_ROOT, 'work', 'community.sqlite3')


def _render_entry(entry):
    if entry['type'] == 'post':
        label = 'post  #{} [{}] {}: {}'.format(
            entry['id'], entry['status'], entry['nickname'], entry['text'])
        detail = '    activityId={}'.format(entry['activityId'])
    else:
        label = 'comment #{} [{}] {}: {}'.format(
            entry['id'], entry['status'], entry['nickname'], entry['text'])
        detail = '    postId={}'.format(entry['postId'])
    return '{}\n{}'.format(label, detail)


def cmd_list(store, only_pending=False):
    posts = store.list_entries('post')
    comments = store.list_entries('comment')
    if only_pending:
        posts = [p for p in posts if p['status'] == STATUS_PENDING]
        comments = [c for c in comments if c['status'] == STATUS_PENDING]
    # 举报始终列出（无 pending 状态），供运营者处理。
    reports = store.list_reports()

    print('=== posts ({}) ==='.format(len(posts)))
    for e in posts:
        print(_render_entry(e))
    print('=== comments ({}) ==='.format(len(comments)))
    for e in comments:
        print(_render_entry(e))
    print('=== reports ({}) ==='.format(len(reports)))
    for r in reports:
        print('report #{} [{}] target={}#{}: {}'.format(
            r['id'], r['created_at'], r['target_type'],
            r['target_id'], r['reason']))
    return 0


def cmd_set(store, action, entry_type, entry_id):
    status = STATUS_APPROVED if action == 'approve' else STATUS_HIDDEN
    if store.set_status(entry_type, entry_id, status):
        print('{} {} #{} -> {}'.format(action, entry_type, entry_id, status))
        return 0
    print('error: {} #{} not found'.format(entry_type, entry_id), file=sys.stderr)
    return 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='moderate.py', description='人生浪费指南 — 本机社区审核命令行')
    parser.add_argument('--db', default=DEFAULT_DB,
                        help='SQLite 数据库路径（默认 work/community.sqlite3）')
    sub = parser.add_subparsers(dest='command', required=True)

    p_list = sub.add_parser('list', help='列出待审核内容')
    p_list.add_argument('--all', action='store_true', help='列出全部状态（默认仅 pending）')

    for name in ('approve', 'hide'):
        p = sub.add_parser(name, help='{} 某条帖子/评论'.format(name))
        p.add_argument('--type', choices=['post', 'comment'], required=True)
        p.add_argument('--id', type=int, required=True)

    args = parser.parse_args(argv)
    store = SQLiteStore(args.db)

    if args.command == 'list':
        return cmd_list(store, only_pending=not args.all)
    if args.command in ('approve', 'hide'):
        return cmd_set(store, args.command, args.type, args.id)
    parser.error('unknown command')
    return 2


if __name__ == '__main__':
    sys.exit(main())
