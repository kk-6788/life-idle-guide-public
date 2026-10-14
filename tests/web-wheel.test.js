'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Wheel = require('../web/wheel.js');
const Guide = require('../shared/guide.js');
const content = require('../shared/content.json');

function seeded(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('转盘：空池不产生结果，单条可重复且不修改源数组', () => {
  assert.equal(Wheel.createRound([], null), null);
  const items = [content[0]];
  const round = Wheel.createRound(items, items[0].id, () => 0);
  assert.deepEqual(round.items, items);
  assert.equal(round.item, items[0]);
  assert.equal(round.index, 0);
  assert.notEqual(round.items, items);
});

test('转盘：候选最多八件、互不重复，抽中条目与扇区对应', () => {
  const before = content.map(x => x.id);
  for (let seed = 1; seed <= 100; seed++) {
    const round = Wheel.createRound(content, content[0].id, seeded(seed));
    assert.equal(round.items.length, 8);
    assert.equal(new Set(round.items.map(x => x.id)).size, 8);
    assert.equal(round.items[round.index], round.item);
    assert.notEqual(round.item.id, content[0].id);
    assert.ok(round.items.every(x => content.includes(x)));
  }
  assert.deepEqual(content.map(x => x.id), before);
});

test('转盘：抽取范围使用整个池子，不只使用前八件', () => {
  const rng = () => 0.99999;
  const round = Wheel.createRound(content, null, rng);
  assert.equal(round.item, content.at(-1));
  assert.equal(round.items[round.index], content.at(-1));
});

test('转盘：三人、户外与主题筛选的交集不越界', () => {
  const items = Guide.filterActivities(content, {company:'group', setting:'outdoor', category:'一起闲着'});
  assert.ok(items.length > 0);
  for (let seed = 1; seed <= 30; seed++) {
    const round = Wheel.createRound(items, null, seeded(seed));
    assert.ok(round.items.every(x => items.includes(x)));
    assert.ok(items.includes(round.item));
  }
});

test('转盘：每个停止角度都让所选扇区正对上方指针', () => {
  for (let count = 1; count <= 8; count++) {
    for (let index = 0; index < count; index++) {
      const rotation = Wheel.targetAngle(index, count);
      assert.ok(rotation >= 0 && rotation < 360);
      const pointed = (rotation + index * 360 / count) % 360;
      assert.ok(Math.abs(pointed) < 1e-9 || Math.abs(pointed - 360) < 1e-9);
    }
  }
});

test('转盘：连续点击只启动一次动画，只产生一个结果', async () => {
  let finish;
  let animations = 0;
  const results = [];
  const busy = [];
  const spinner = Wheel.createSpinner({
    animate() { animations++; return new Promise(resolve => { finish = resolve; }); },
    onBusy(value) { busy.push(value); },
    onResult(round) { results.push(round.item.id); }
  });
  const pending = spinner.start(content, null);
  assert.equal(spinner.start(content, null), false);
  assert.equal(animations, 1);
  finish();
  await pending;
  assert.equal(results.length, 1);
  assert.deepEqual(busy, [true, false]);
});

test('转盘：换筛选或离开页面后，旧动画不得覆盖新结果', async () => {
  const finishes = [];
  const results = [];
  const spinner = Wheel.createSpinner({
    animate() { return new Promise(resolve => finishes.push(resolve)); },
    onResult(round) { results.push(round.item.id); }
  });
  const oldRun = spinner.start([content[0]], null);
  spinner.cancel();
  const newRun = spinner.start([content[1]], null);
  finishes[0]();
  await oldRun;
  assert.deepEqual(results, []);
  assert.equal(spinner.start(content, null), false);
  finishes[1]();
  await newRun;
  assert.deepEqual(results, [content[1].id]);
});

test('转盘：没有匹配时不动画；动画失败后按钮恢复并能重试', async () => {
  let errors = 0;
  let empty = 0;
  const busy = [];
  const spinner = Wheel.createSpinner({
    animate() { throw new Error('animation unavailable'); },
    onBusy(value) { busy.push(value); },
    onEmpty() { empty++; },
    onError() { errors++; }
  });
  assert.equal(spinner.start([], null), false);
  assert.equal(empty, 1);
  await spinner.start(content, null);
  await spinner.start(content, null);
  assert.equal(errors, 2);
  assert.deepEqual(busy, [true, false, true, false]);
});
