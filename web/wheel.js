/* 网页转盘：先从整个筛选池抽取，再安排本轮最多八个扇区。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/guide.js'));
  } else {
    root.Wheel = factory(root.Guide);
  }
}(typeof self !== 'undefined' ? self : this, function (Guide) {
  'use strict';

  function shuffle(items, rand) {
    for (var i = items.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      if (j < 0 || j > i) j = 0;
      var temp = items[i]; items[i] = items[j]; items[j] = temp;
    }
    return items;
  }

  function createRound(items, previousId, rng) {
    var rand = typeof rng === 'function' ? rng : Math.random;
    var item = Guide.pickRandom(items, previousId, rand);
    if (!item) return null;
    var others = shuffle(items.filter(function (x) { return x.id !== item.id; }), rand);
    var sectors = shuffle([item].concat(others.slice(0, 7)), rand);
    return { items: sectors, item: item, index: sectors.indexOf(item) };
  }

  // 第一个扇区中心在上方；旋转后选中扇区仍对准固定指针。
  function targetAngle(index, count) {
    return (360 - index * 360 / count) % 360;
  }

  function createSpinner(options) {
    var spinning = false;
    var sequence = 0;
    function call(name, value) {
      if (typeof options[name] === 'function') options[name](value);
    }
    return {
      start: function (items, previousId) {
        if (spinning) return false;
        var round = createRound(items, previousId);
        if (!round) { call('onEmpty'); return false; }
        spinning = true;
        var token = ++sequence;
        call('onBusy', true);
        var animation;
        try { animation = options.animate(round); }
        catch (error) { animation = Promise.reject(error); }
        return Promise.resolve(animation).then(function () {
          if (token !== sequence) return false;
          spinning = false;
          call('onBusy', false);
          call('onResult', round);
          return round;
        }, function (error) {
          if (token !== sequence) return false;
          spinning = false;
          call('onBusy', false);
          call('onError', error);
          return false;
        });
      },
      cancel: function () {
        ++sequence;
        if (!spinning) return;
        spinning = false;
        call('onCancel');
        call('onBusy', false);
      }
    };
  }

  return { createRound: createRound, targetAngle: targetAngle, createSpinner: createSpinner };
}));
