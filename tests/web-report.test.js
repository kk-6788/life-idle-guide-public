'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const elements = new Map(), requests = [], toasts = [];
  function element() {
    return { value: '', hidden: true, disabled: false, textContent: '', events: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, cb) { this.events[name] = cb; },
      querySelector() { return this.submit ||= element(); },
      focus() {}, setAttribute() {} };
  }
  function el(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }
  const sandbox = {
    window: { Guide: {}, Wheel: {}, addEventListener() {}, CommunityModule: {
      report(payload) {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        requests.push({ payload, resolve, reject });
        return promise;
      }
    } },
    document: { getElementById: el, querySelectorAll() { return []; }, addEventListener() {},
      createElement: element, body: { style: {}, appendChild(el) { toasts.push(el); } } },
    localStorage: { getItem() { return null; } }, setTimeout() {}, clearTimeout() {}
  };
  let source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  const startup = '  cacheEls();\n  setupWheel();\n  bind();\n  loadContent();\n  route();';
  assert.ok(source.includes(startup));
  source = source.replace(startup, '  cacheEls();\n  bind();\n  window.reportTest = { openReport, closeReport };');
  vm.runInNewContext(source, sandbox);
  return { el, requests, toasts, ...sandbox.window.reportTest,
    submit(reason = 'test reason') { el('report-reason').value = reason; el('report-form').events.submit({ preventDefault() {} }); },
    button() { return el('report-form').submit; }
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const result of ['resolve', 'reject']) {
  for (const reopenSame of [false, true]) {
    test(`LIG-01: stale ${result}, reopening ${reopenSame ? 'same' : 'different'} target preserves new pending dialog`, async () => {
      const s = setup();
      s.openReport('post', 1, 'A'); s.submit('reason A');
      s.closeReport();
      s.openReport('post', reopenSame ? 1 : 2, 'B'); s.submit('draft B');
      const old = s.requests[0];
      old[result](result === 'reject' ? new Error('old failure') : undefined);
      await flush();
      assert.equal(s.el('report-dialog').hidden, false);
      assert.equal(s.el('report-reason').value, 'draft B');
      assert.equal(s.el('report-error').hidden, true);
      assert.equal(s.button().disabled, true, 'old callbacks must not enable the new pending submit');
      assert.equal(s.toasts.length, 0);
      s.requests[1].resolve(); await flush();
      assert.equal(s.el('report-dialog').hidden, true);
      assert.equal(s.toasts.length, 1);
    });
  }
}
test('LIG-01: cancelled request stays quiet without reopening', async () => {
  const s = setup();
  s.openReport('comment', 3, 'C'); s.submit();
  s.el('report-cancel').events.click();
  s.requests[0].resolve(); await flush();
  assert.equal(s.el('report-dialog').hidden, true);
  assert.equal(s.toasts.length, 0);
});
test('LIG-01: current failure permits retry and repeated clicks submit once', async () => {
  const s = setup();
  s.openReport('post', 4, 'D'); s.submit('current'); s.submit('current');
  assert.equal(s.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(s.requests[0].payload)), { targetType: 'post', targetId: 4, reason: 'current' });
  s.requests[0].reject(new Error('retry me')); await flush();
  assert.equal(s.button().disabled, false);
  assert.equal(s.el('report-error').hidden, false);
  assert.equal(s.el('report-error').textContent, 'retry me');
  s.submit('retry'); s.requests[1].resolve(); await flush();
  assert.equal(s.el('report-dialog').hidden, true);
  assert.equal(s.toasts.length, 1);
});
