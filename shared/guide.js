/**
 * guide.js — 《人生浪费指南》共享筛选/随机逻辑
 *
 * UMD：Node 用 require('../shared/guide.js')，浏览器可直接 <script> 引入，
 * 挂到 window.Guide。唯一内容源是 shared/content.json，本文件不内嵌内容。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.Guide = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CATEGORIES = ['放空', '闲逛', '手边小事', '童年游戏', '一起闲着'];
  var SETTINGS = ['indoor', 'outdoor', 'either'];
  var COMPANIES = ['solo', 'together', 'group', 'social', 'either'];

  function toHaystack(item) {
    return [
      item.title,
      item.summary,
      item.category,
      item.setting,
      item.company,
      (item.body || []).join(' '),
      (item.needs || []).join(' ')
    ].join(' ').toLowerCase();
  }

  function matchesQuery(item, query) {
    var q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return true;
    return toHaystack(item).indexOf(q) !== -1;
  }

  function matchesSetting(item, setting) {
    if (!setting || setting === 'either') return true;
    return item.setting === setting || item.setting === 'either';
  }

  function matchesCompany(item, company) {
    if (!company || company === 'either') return true;
    switch (company) {
      case 'solo':
        return item.company === 'solo' || item.company === 'either';
      case 'together':
        return item.company === 'together' || item.company === 'social' || item.company === 'either';
      case 'group':
        return item.company === 'group' || item.company === 'social' || item.company === 'either';
      case 'social':
        return item.company === 'social' || item.company === 'together' ||
          item.company === 'group' || item.company === 'either';
      default:
        // 非法值按约定不过滤。
        return true;
    }
  }

  function matchesCategory(item, category) {
    if (!category || category === 'all' || CATEGORIES.indexOf(category) === -1) return true;
    return item.category === category;
  }

  /**
   * 筛选：query（中文子串）/ setting / company / category 全部取交集。
   * 非法值等同不过滤，返回原数组顺序。
   */
  function filterActivities(items, opts) {
    if (!Array.isArray(items)) return [];
    opts = opts || {};
    var query = opts.query;
    var setting = opts.setting;
    var company = opts.company;
    var category = opts.category;
    return items.filter(function (it) {
      return matchesQuery(it, query) &&
        matchesSetting(it, setting) &&
        matchesCompany(it, company) &&
        matchesCategory(it, category);
    });
  }

  /**
   * 随机取一条。0 条返回 null；单条直接返回；
   * 多条时优先在“排除上一项”的池子里取，实在没得选才允许重复。
   * rng 可注入（默认 Math.random），返回 [0,1)；对 1 的边界做兜底。
   */
  function pickRandom(items, previousId, rng) {
    if (!Array.isArray(items) || items.length === 0) return null;
    var rand = typeof rng === 'function' ? rng : Math.random;
    if (items.length === 1) return items[0];

    var pool = items;
    var others = items.filter(function (it) { return it.id !== previousId; });
    if (others.length > 0) pool = others;

    var index = Math.floor(rand() * pool.length);
    if (index < 0 || index >= pool.length) index = 0;
    return pool[index];
  }

  /** cost 标签：'paid' → 需要花费；其余（0 / undefined）→ 无需额外花费。 */
  function costLabel(cost) {
    return cost === 'paid' ? '需要花费' : '无需额外花费';
  }

  return {
    CATEGORIES: CATEGORIES,
    SETTINGS: SETTINGS,
    COMPANIES: COMPANIES,
    filterActivities: filterActivities,
    pickRandom: pickRandom,
    costLabel: costLabel
  };
}));
