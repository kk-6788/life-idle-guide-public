# 一起共建

欢迎给《人生浪费指南》添一件小事。可以先开 Issue，说说你的想法；会改代码的话，也可以直接提交 Pull Request。

## 添一件小事

先看 [内容规则](CONTENT_GUIDE.md)。`shared/content.json` 是网页的唯一内容源；新条目追加到数组末尾，保留已有条目的顺序和 id。

写清楚名字、做法、人数、地点，以及是否需要经济成本。加一句短短的格言，允许读者什么也没做、随时停下。不要把休息写成任务，也不要把花钱写成休息的前提。

修改后运行：

```bash
node --test tests/guide.test.js
```

## 改网页或本机服务

- 网页代码在 `web/`，共用逻辑在 `shared/guide.js`，可选的本机闲聊服务在 `server/`。
- 保持简单，避免引入不必要的依赖；后端目前只用 Python 标准库。
- 用户留言、回复和昵称按纯文本展示，不能直接作为 HTML 插入。
- 新功能和错误修复应有能验证实际行为的检查；内容与筛选测试在 `tests/guide.test.js`，本机服务测试在 `tests/test_community.py`。
- 网页转盘在 `web/wheel.js`，对应 `tests/web-wheel.test.js`；抽取范围、指针与结果的对应、重复点击和中断都应保持一致。

运行相关检查：

```bash
node --test tests/guide.test.js tests/web-wheel.test.js
python -m unittest discover -s tests -p test_community.py -v
```

## 提交前看看

说明这次改了什么、为什么改，以及做过哪些检查。保留与这次修改无关的内容，勿提交个人数据、密钥或本机数据库。

不虚构用户、评论、访客数字或收入；不收录刷短视频、电子游戏、充值或盗版资源；不把本机匿名接口描述成可以直接用于公网的社区后台。

代码与文字的许可尚未确定。上线相关说明见 [上线前事项](docs/上线前事项.md)。
