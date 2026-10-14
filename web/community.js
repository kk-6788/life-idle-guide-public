/**
 * community.js — 社区模块：访问本机 server 的真实 HTTP 客户端。
 *
 * 本文件只与 app.js 约定的接口打交道，不生成任何虚构帖子/评论。
 * 遵循 server 契约：
 *   GET  /api/status              -> {enabled, mode, notice}
 *   GET  /api/posts               -> {posts:[{id,activityId,nickname,text,createdAt,comments:[...]}]}
 *   POST /api/posts               -> 201 {id,status:'pending'}（{activityId,nickname,text}）
 *   POST /api/posts/:id/comments  -> 201 {id,status:'pending'}（{nickname,text}）
 *   POST /api/reports             -> 201 {status:'received'}（{targetType,targetId,reason}）
 *
 * 所有外部文本都由 app.js 用 textContent 呈现，不把内容插成 HTML。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CommunityModule = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 页面由本机 server 以 /web/ 提供，API 在同一源根路径下。
  var API_ROOT = '/api';
  var TIMEOUT_MS = 8000;

  function apiPath(sub) {
    return API_ROOT + sub;
  }

  function http(method, sub, payload) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    function done() { if (timer) clearTimeout(timer); }
    var opts = {
      method: method,
      headers: { 'Accept': 'application/json' }
    };
    if (controller) opts.signal = controller.signal;
    if (payload !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(payload);
    }
    return fetch(apiPath(sub), opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(
            data && data.error ? data.error : ('请求失败（HTTP ' + res.status + '）'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }).then(function (data) {
      done();
      return data;
    }).catch(function (e) {
      done();
      throw e;
    });
  }

  function errorResult(reason) {
    var err = new Error(reason);
    err.unavailable = true;
    return err;
  }

  return {
    /** 本机服务状态：成功返回原始 body；断线/404 返回 unavailable 错误。 */
    getStatus: function () {
      return http('GET', '/status');
    },

    /** 读取已审核通过的帖子数组（仅 approved）。失败会拒绝（由调用方显示明确错误）。 */
    listPosts: function () {
      return http('GET', '/posts')
        .then(function (body) {
          return Array.isArray(body.posts) ? body.posts : [];
        });
    },

    /** 发布体验：{activityId, nickname, text} -> {id, status:'pending'} */
    createPost: function (payload) {
      return http('POST', '/posts', payload);
    },

    /** 发表评论：{postId, nickname, text} -> {id, status:'pending'} */
    createComment: function (postId, payload) {
      return http('POST', '/posts/' + encodeURIComponent(postId) + '/comments', payload);
    },

    /** 举报：{targetType, targetId, reason} -> {status:'received'} */
    report: function (payload) {
      return http('POST', '/reports', payload);
    }
  };
}));
