'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const guide = require('../shared/guide.js');
const content = require('../shared/content.json');

const { CATEGORIES, filterActivities, pickRandom } = guide;

// ---------- 内容数据 ----------

const FREE_IDS = [
  'cloud-watch', 'blank-stare', 'rain-sound', 'slow-water', 'old-song',
  'unknown-lane', 'park-bench', 'used-books', 'night-walk', 'street-view',
  'drawer-tidy', 'leaf-wipe', 'hand-wash', 'coin-year', 'paper-boat',
  'remote-clean', 'paper-slap', 'hopscotch', 'string-figure', 'marble',
  'stairs-fruit', 'silent-read', 'paper-plane', 'read-aloud',
];

test('内容：每个活动都有独立、简短的格言', () => {
  const maxims = content.map(item => item.maxim);
  assert.equal(new Set(maxims).size, content.length, '每个活动的短句不应重复');
  for (const item of content) {
    assert.equal(typeof item.maxim, 'string', item.id + ' 缺少短句');
    assert.ok(item.maxim.trim().length > 0 && [...item.maxim].length <= 36, item.id + ' 短句过长或为空');
  }
});

test('内容：共 40 条，id 唯一，字段合法，cost 合法（0 或 paid）', () => {
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 40);

  const ids = content.map((it) => it.id);
  assert.equal(new Set(ids).size, ids.length, 'id 应稳定唯一');

  for (const it of content) {
    assert.ok(typeof it.id === 'string' && it.id.length > 0, 'id 缺失');
    assert.ok(typeof it.title === 'string' && it.title.length > 0, 'title 缺失');
    assert.ok(typeof it.summary === 'string' && it.summary.length > 0, 'summary 缺失');
    assert.ok(Array.isArray(it.body) && it.body.length > 0, 'body 应为非空字符串数组');
    assert.ok(Array.isArray(it.needs), 'needs 应为数组');
    assert.ok(CATEGORIES.includes(it.category), `未知类别: ${it.category}`);
    assert.ok(['indoor', 'outdoor', 'either'].includes(it.setting), `非法 setting: ${it.setting}`);
    assert.ok(guide.COMPANIES.includes(it.company), `非法 company: ${it.company}`);
    assert.ok(it.cost === 0 || it.cost === 'paid', `非法 cost: ${it.cost}`);
    if (it.cost === 'paid') {
      assert.ok(typeof it.costNote === 'string' && it.costNote.length > 0, `paid 条目 ${it.id} 缺少 costNote`);
    }
  }

  // 原始 24 条仍为零成本
  for (const id of FREE_IDS) {
    const it = content.find((x) => x.id === id);
    assert.ok(it, `缺少原始条目: ${id}`);
    assert.equal(it.cost, 0, `原始条目 ${id} 应仍为 cost 0`);
  }

  // 6 条经济成本条目
  const paid = content.filter((it) => it.cost === 'paid');
  assert.equal(paid.length, 6, '应有 6 条 paid 条目');
});

test('内容：costLabel 与费用说明', () => {
  const paid = content.find((it) => it.cost === 'paid');
  assert.ok(paid, '应存在 paid 条目');
  assert.equal(guide.costLabel(paid.cost), '需要花费');
  assert.equal(guide.costLabel(0), '无需额外花费');
  assert.equal(guide.costLabel(undefined), '无需额外花费');
});

test('内容：不收录电子游戏/买游戏/充值类推荐', () => {
  const full = content.map((it) => [it.title, it.summary, ...it.body, ...(it.needs || []), it.costNote || ''].join('\n')).join('\n');
  const banned = ['电子游戏', '手游', '网游', '充值', '买游戏', '游戏机', '主机游戏', '氪金'];
  for (const word of banned) {
    assert.ok(!full.includes(word), `不应推荐: ${word}`);
  }
});

test('内容：五个类别均有覆盖', () => {
  for (const cat of CATEGORIES) {
    assert.ok(content.some((it) => it.category === cat), `缺少类别: ${cat}`);
  }
});

// ---------- 内容修复回归 ----------

test('内容修复：已删除强制时长/消费/成就等冲突表述', () => {
  const full = content.map((it) => [it.title, it.summary, ...it.body, ...(it.needs || [])].join('\n')).join('\n');
  const gone = ['十五分钟', '楼顶', '十分钟', '百分之百', '买一点', '请喝', '零花钱', '摊主', '没白逛', '手洗一件衣服', '闭眼听完'];
  for (const phrase of gone) {
    assert.ok(!full.includes(phrase), `不应再出现: ${phrase}`);
  }
});

test('内容修复：关键条目改为自由/无消费版本', () => {
  const byId = (id) => content.find((x) => x.id === id);
  const full = (it) => [it.title, it.summary, ...it.body, ...(it.needs || [])].join('\n');

  assert.ok(full(byId('stairs-fruit')).includes('家里已有'));
  assert.ok(full(byId('paper-plane')).includes('奖励和惩罚') && !full(byId('paper-plane')).includes('窗前'));
  assert.ok(full(byId('remote-clean')).includes('外号'));
  assert.ok(full(byId('cloud-watch')).includes('不用设时间'));
  assert.ok(full(byId('blank-stare')).includes('坐不住随时可以起身就走'));
  assert.ok(full(byId('used-books')).includes('公共书架') && full(byId('used-books')).includes('免费'));
  assert.equal(byId('hand-wash').title, '在灯下玩手影');
});

// ---------- 筛选：交集 ----------

test('filterActivities：空选项返回全部', () => {
  assert.equal(filterActivities(content, {}).length, content.length);
  assert.equal(filterActivities(content, undefined).length, content.length);
});

test('filterActivities：按 setting 过滤', () => {
  const indoor = filterActivities(content, { setting: 'indoor' });
  assert.ok(indoor.length > 0);
  assert.ok(indoor.every((it) => it.setting === 'indoor' || it.setting === 'either'));

  const outdoor = filterActivities(content, { setting: 'outdoor' });
  assert.ok(outdoor.length > 0);
  assert.ok(outdoor.every((it) => it.setting === 'outdoor' || it.setting === 'either'));
});

test('filterActivities：按 company 过滤', () => {
  const solo = filterActivities(content, { company: 'solo' });
  assert.ok(solo.length > 0);
  assert.ok(solo.every((it) => it.company === 'solo' || it.company === 'either'));

  const together = filterActivities(content, { company: 'together' });
  assert.ok(together.length > 0);
  assert.ok(together.every((it) => ['together', 'social', 'either'].includes(it.company)));
});

test('filterActivities：按 category 精确过滤', () => {
  for (const cat of CATEGORIES) {
    const list = filterActivities(content, { category: cat });
    assert.ok(list.length > 0, `类别 ${cat} 无结果`);
    assert.ok(list.every((it) => it.category === cat));
  }
});

test('filterActivities：多条件取交集，范围不扩大', () => {
  const list = filterActivities(content, {
    setting: 'indoor',
    company: 'solo',
    category: '手边小事',
  });
  assert.ok(list.length > 0, '应存在同时满足三条条件的条目');
  for (const it of list) {
    assert.ok(it.setting === 'indoor' || it.setting === 'either', '交集内不应出现户外条目');
    assert.ok(it.company === 'solo' || it.company === 'either', '交集内不应出现一起条目');
    assert.equal(it.category, '手边小事');
  }
  const byCat = filterActivities(content, { category: '手边小事' });
  assert.ok(list.length <= byCat.length, '交集结果数不应超过单条件');
});

test('filterActivities：无任何交集返回空数组', () => {
  const none = filterActivities(content, {
    setting: 'outdoor',
    company: 'solo',
    category: '手边小事',
  });
  assert.deepEqual(none, []);
});

// ---------- 筛选：中文检索 ----------

test('filterActivities：中文查询命中标题/摘要', () => {
  const list = filterActivities(content, { query: '云' });
  assert.ok(list.some((it) => it.title.includes('云') || it.summary.includes('云') || it.body.join('').includes('云')));
});

test('filterActivities：中文查询命中正文', () => {
  const list = filterActivities(content, { query: '出生证明' });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '把硬币按年份排开');
});

test('filterActivities：中文查询命中需求清单', () => {
  const list = filterActivities(content, { query: '鞋带' });
  assert.ok(list.some((it) => it.needs.join('').includes('鞋带')));
});

test('filterActivities：查询与条件组合', () => {
  const list = filterActivities(content, { query: '废纸', category: '童年游戏' });
  assert.ok(list.length > 0);
  for (const it of list) {
    assert.equal(it.category, '童年游戏');
    const hay = [it.title, it.summary, ...it.body, ...it.needs].join(' ');
    assert.ok(hay.includes('废纸'), '组合结果应同时满足查询与类别');
  }
});

test('filterActivities：无匹配查询返回空数组', () => {
  assert.deepEqual(filterActivities(content, { query: '不存在的事物xyz' }), []);
});

test('filterActivities：查询大小写与首尾空白不影响匹配', () => {
  const a = filterActivities(content, { query: ' 云 ' });
  const b = filterActivities(content, { query: '云' });
  assert.deepEqual(a, b);
});

// ---------- 随机 ----------

test('人数：三人活动齐全、免费，原有双人玩法扩为两人及以上', () => {
  const ids = ['story-relay', 'shared-doodle', 'paper-whisper', 'circle-sounds', 'group-stroll', 'shadow-guess', 'pebble-pattern', 'old-photo-circle', 'leaf-shadows', 'odd-object-names'];
  assert.deepEqual(content.filter(it => it.company === 'group').map(it => it.id), ids);
  for (const id of ids) {
    const item = content.find(it => it.id === id);
    assert.equal(item.cost, 0);
    assert.ok(item.body.length >= 2);
  }
  for (const id of ['stairs-fruit', 'silent-read', 'paper-plane', 'read-aloud']) {
    assert.equal(content.find(it => it.id === id).company, 'social');
  }
  assert.equal(content.find(it => it.id === 'string-figure').company, 'together');
});

test('人数：人数边界互不混淆，兼容不限人数与非法值', () => {
  const items = ['solo', 'together', 'group', 'social', 'either'].map(company => ({ id: company, company }));
  const ids = company => filterActivities(items, { company }).map(it => it.id);
  assert.deepEqual(ids('solo'), ['solo', 'either']);
  assert.deepEqual(ids('together'), ['together', 'social', 'either']);
  assert.deepEqual(ids('group'), ['group', 'social', 'either']);
  assert.deepEqual(ids('social'), ['together', 'group', 'social', 'either']);
  for (const company of ['', undefined, 'either', 'unknown']) assert.deepEqual(ids(company), items.map(it => it.id));
});

test('人数：三人筛选与环境、类别、搜索取交集，随机不越界', () => {
  const before = JSON.stringify(content);
  const group = filterActivities(content, { company: 'group' });
  assert.ok(group.some(it => it.id === 'story-relay'));
  assert.ok(!group.some(it => ['string-figure', 'blank-stare'].includes(it.id)));
  const list = filterActivities(content, { company: 'group', setting: 'indoor', category: '童年游戏', query: '传' });
  assert.deepEqual(list.map(it => it.id), ['paper-whisper']);
  for (let i = 0; i < group.length; i++) {
    const chosen = pickRandom(group, group[0].id, () => i / group.length);
    assert.ok(group.includes(chosen));
    assert.notEqual(chosen.id, group[0].id);
  }
  assert.equal(JSON.stringify(content), before);
});

test('pickRandom：0 条返回 null', () => {
  assert.equal(pickRandom([], 'anything'), null);
  assert.equal(pickRandom(null, 'x'), null);
  assert.equal(pickRandom(undefined, 'x'), null);
});

test('pickRandom：单条返回该条（即使与上一项相同）', () => {
  const one = [content[0]];
  assert.equal(pickRandom(one, one[0].id), one[0]);
});

test('pickRandom：多条时尽量不重复上一项', () => {
  const list = content.slice(0, 5);
  const previousId = list[0].id;
  for (let i = 0; i < 200; i += 1) {
    const r = pickRandom(list, previousId, () => 0);
    assert.notEqual(r.id, previousId, '存在可选项时不应重复上一项');
  }
});

test('pickRandom：上一项不在列表中时正常随机', () => {
  const list = content.slice(0, 5);
  for (let i = 0; i < 50; i += 1) {
    const r = pickRandom(list, 'not-in-list', () => Math.random());
    assert.ok(list.includes(r));
  }
});

test('pickRandom：注入 rng 可控且边界不越界', () => {
  const list = content.slice(0, 3);
  assert.equal(pickRandom(list, null, () => 0), list[0]);
  assert.equal(pickRandom(list, null, () => 0.9999), list[2]);
  // rng 返回 1 的边界不应产生 undefined
  assert.ok(list.includes(pickRandom(list, null, () => 1)));
});

test('pickRandom：默认使用 Math.random，始终落在列表内', () => {
  const list = content.slice(0, 8);
  for (let i = 0; i < 500; i += 1) {
    const r = pickRandom(list);
    assert.ok(list.includes(r));
  }
});
