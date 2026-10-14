'use strict';

/* 人生浪费指南 — 静态网页逻辑（无依赖，配合 shared/guide.js、wheel.js 与 community.js） */

(function () {
  var Guide = window.Guide;
  var Community = window.CommunityModule;
  var Wheel = window.Wheel;

  var CONTENT_URL = '../shared/content.json';
  var SAVED_KEY = 'lwz-favorites-v1';

  var CAT_CLASS = { '放空': 'rest', '闲逛': 'stroll', '手边小事': 'hand', '童年游戏': 'child', '一起闲着': 'together' };
  var SETTING_LABEL = { indoor: '室内', outdoor: '户外', either: '室内外都行' };
  var COMPANY_LABEL = { solo: '一个人', together: '两个人', group: '三人及以上', social: '两人及以上', either: '不限人数' };

  var state = {
    items: [],
    loaded: false,
    query: '',
    category: '',
    setting: '',
    company: '',
    saved: loadSaved(),
    lastRandomId: null,
    view: 'browse',
    detailItem: null
  };

  var els = {};
  var lastFocus = null;
  var wheelSpinner;
  var wheelPoolKey = null;
  var wheelAnimation = null;

  function $(id) { return document.getElementById(id); }

  function loadSaved() {
    try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')); }
    catch (e) { return new Set(); }
  }

  function saveSaved() {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(Array.from(state.saved)));
      return true;
    } catch (e) {
      showFavError();
      return false;
    }
  }

  var favToast = null;
  var toastTimer = null;
  function showToast(text) {
    if (!favToast) {
      favToast = document.createElement('div');
      favToast.className = 'toast';
      favToast.setAttribute('role', 'status');
      document.body.appendChild(favToast);
    }
    favToast.textContent = text;
    favToast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { favToast.hidden = true; }, 4000);
  }

  function showFavError() {
    showToast('收着保存失败：浏览器可能禁用了本地存储，本次没有存下来。');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 加载内容 ---------- */

  function loadContent() {
    wheelSpinner.cancel();
    wheelPoolKey = null;
    state.loaded = false;
    els.wheelSpin.disabled = els.randomBtn.disabled = true;
    els.wheelHint.textContent = '小事正在路上…';
    els.loadError.hidden = true;
    fetch(CONTENT_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.items = Array.isArray(data) ? data : [];
        state.loaded = true;
        renderBrowse();
        renderSaved();
        // 深链接：route 早于 fetch 完成时，内容就绪后重新处理一次路由
        route();
      })
      .catch(function (err) {
        state.loaded = false;
        els.loadError.hidden = false;
        els.browseList.innerHTML = '';
        els.resultCount.textContent = '';
        els.wheelHint.textContent = '内容没加载出来，请在下方再试一次。';
      });
  }

  /* ---------- 筛选 ---------- */

  function filtered() {
    return Guide.filterActivities(state.items, {
      query: state.query,
      setting: state.setting,
      company: state.company,
      category: state.category
    });
  }

  /* ---------- 渲染：列表卡片 ---------- */

  function cardHTML(it) {
    var pressed = state.saved.has(it.id);
    var needs = (it.needs || []).join('、');
    return '<article class="card card--' + (CAT_CLASS[it.category] || 'hand') + '" data-id="' + esc(it.id) + '">' +
      '<div class="card-head">' +
        '<span class="tag"><i class="cat-dot cat-dot--' + CAT_CLASS[it.category] + '" aria-hidden="true"></i>' + esc(it.category) + '</span>' +
        '<button type="button" class="fav-btn" data-fav="' + esc(it.id) + '" aria-pressed="' + pressed + '" aria-label="' + (pressed ? '取消收着：' : '收着：') + esc(it.title) + '">' + (pressed ? '★' : '☆') + '</button>' +
      '</div>' +
      '<h3 class="card-title"><a href="#/a/' + encodeURIComponent(it.id) + '">' + esc(it.title) + '</a></h3>' +
      '<p class="card-summary">' + esc(it.summary) + '</p>' +
      '<p class="card-cost">' + esc(Guide.costLabel(it.cost)) + '</p>' +
      (needs ? '<p class="card-needs">需要：' + esc(needs) + '</p>' : '') +
    '</article>';
  }

  function renderBrowse() {
    if (!state.loaded) return;
    var list = filtered();
    refreshWheel(list);
    els.resultCount.textContent = list.length > 0 ? '共 ' + list.length + ' 条' : '';
    els.browseList.innerHTML = list.map(cardHTML).join('');
    els.browseEmpty.hidden = list.length !== 0;
  }

  function renderSaved() {
    if (!state.loaded) return;
    var list = state.items.filter(function (it) { return state.saved.has(it.id); });
    els.savedList.innerHTML = list.map(cardHTML).join('');
    els.savedEmpty.hidden = list.length !== 0;
  }

  /* ---------- 详情弹窗 ---------- */

  function openDetail(id) {
    var it = state.items.find(function (x) { return x.id === id; });
    if (!it) return;
    state.detailItem = it;
    lastFocus = document.activeElement;

    els.detailTitle.textContent = it.title;
    els.detailMaxim.textContent = it.maxim || '';
    els.detailMaxim.hidden = !it.maxim;
    els.detailSummary.textContent = it.summary;
    els.detailCost.textContent = Guide.costLabel(it.cost) + (it.costNote ? '：' + it.costNote : '');
    els.detailCategory.innerHTML = '<i class="cat-dot cat-dot--' + CAT_CLASS[it.category] + '" aria-hidden="true"></i>' + esc(it.category);
    els.detailSetting.textContent = SETTING_LABEL[it.setting] || it.setting;
    els.detailCompany.textContent = COMPANY_LABEL[it.company] || it.company;
    els.detailBody.innerHTML = it.body.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    els.detailNeedsList.innerHTML = (it.needs || []).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');

    var fav = state.saved.has(it.id);
    els.detailFav.textContent = fav ? '★ 已收着' : '☆ 收着';
    els.detailFav.setAttribute('aria-pressed', String(fav));

    els.detailDialog.hidden = false;
    document.body.style.overflow = 'hidden';
    els.detailClose.focus();
  }

  function closeDetail() {
    if (els.detailDialog.hidden) return;
    els.detailDialog.hidden = true;
    document.body.style.overflow = '';
    state.detailItem = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    if (location.hash.indexOf('#/a/') === 0) {
      history.replaceState(null, '', '#/' + (state.view === 'saved' ? 'saved' : 'browse'));
    }
  }

  /* ---------- 路由 ---------- */

  function route() {
    var hash = location.hash || '#/browse';
    var m = hash.match(/^#\/a\/(.+)$/);
    if (m) {
      var id;
      try { id = decodeURIComponent(m[1]); }
      catch (e) { id = ''; }
      if (id) {
        openDetail(id);
        setView(state.view, true);
        return;
      }
    }
    closeDetail();
    var view = hash.replace(/^#\//, '').split('?')[0];
    if (['browse', 'community', 'saved'].indexOf(view) === -1) view = 'browse';
    setView(view, false);
  }

  function setView(view, keepActive) {
    if (view !== 'browse') {
      wheelSpinner.cancel();
      wheelPoolKey = null;
    }
    state.view = view;
    ['browse', 'community', 'saved'].forEach(function (v) {
      els['view' + cap(v)].hidden = v !== view;
    });
    document.querySelectorAll('.main-nav a').forEach(function (a) {
      a.classList.toggle('is-active', a.dataset.view === view);
    });
    if (view === 'community' && !keepActive) renderCommunity();
    if (view === 'saved' && !keepActive) renderSaved();
    if (view === 'browse' && !keepActive) renderBrowse();
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ---------- 社区 ---------- */

  function activityTitle(id) {
    if (!state.items) return id;
    var it = state.items.find(function (x) { return x.id === id; });
    return it ? it.title : id;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function populateActivitySelect() {
    var sel = els.postActivity;
    sel.textContent = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = state.items.length ? '选择这次是哪件事' : '（内容尚未加载）';
    sel.appendChild(placeholder);
    state.items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.title;
      sel.appendChild(o);
    });
  }

  function renderCommunity() {
    Community.getStatus().then(function (st) {
      state.community = st;
      // 状态区单独如实说明本机/未开放；标题用中文，不直接显示英文 mode。
      els.communityStatus.hidden = false;
      els.communityStatus.innerHTML =
        '<h2>' + esc('本机体验版') + '</h2>' +
        '<p>' + esc(st.notice || '尚未公开上线') + '</p>';
      if (st.enabled) {
        els.communityError.hidden = true;
        els.postForm.hidden = false;
        populateActivitySelect();
        loadAndRenderPosts();
      } else {
        // 服务明确返回未开放：禁用提交，清除列表，不显示"还没有人分享"空态。
        els.communityError.hidden = false;
        els.postForm.hidden = true;
        els.communityList.textContent = '';
        els.communityEmpty.hidden = true;
        els.communityLoadError.hidden = true;
      }
    }).catch(function () {
      // 无 API / 404 / 断线 / 超时：明确"社区尚未开放"，不当成空社区。
      els.communityStatus.hidden = true;
      els.communityError.hidden = false;
      els.postForm.hidden = true;
      els.communityList.textContent = '';
      els.communityEmpty.hidden = true;
      els.communityLoadError.hidden = true;
    });
  }

  function loadAndRenderPosts() {
    els.communityLoadError.hidden = true;
    els.communityEmpty.hidden = true;
    Community.listPosts().then(function (posts) {
      renderCommunityList(posts, true);
    }).catch(function () {
      // 接口 500/断线/超时：不是"还没有人分享"，明确报错并提供重试。
      els.communityList.textContent = '';
      els.communityEmpty.hidden = true;
      els.communityLoadError.hidden = false;
    });
  }

  function renderCommunityList(posts, loaded) {
    var list = els.communityList;
    list.textContent = '';
    // 空态只在"成功加载且确实 0 条"时出现；失败/未开放不显示空态。
    els.communityEmpty.hidden = !(loaded && posts.length === 0);
    els.communityLoadError.hidden = true;
    if (!posts.length) return;
    posts.forEach(function (p) {
      list.appendChild(buildPost(p, true));
    });
  }

  function buildPost(p, enabled) {
    var art = document.createElement('article');
    art.className = 'post';

    var meta = document.createElement('div');
    meta.className = 'post-meta';
    var act = document.createElement('span');
    act.className = 'post-activity';
    act.textContent = activityTitle(p.activityId);
    var nick = document.createElement('span');
    nick.className = 'post-nick';
    nick.textContent = p.nickname;
    var time = document.createElement('time');
    time.className = 'post-time';
    time.textContent = fmtTime(p.createdAt);
    meta.appendChild(act);
    meta.appendChild(nick);
    meta.appendChild(time);
    art.appendChild(meta);

    var txt = document.createElement('p');
    txt.className = 'post-text';
    txt.textContent = p.text;
    art.appendChild(txt);

    var reportBtn = document.createElement('button');
    reportBtn.type = 'button';
    reportBtn.className = 'link-btn';
    reportBtn.textContent = '举报这条体验';
    reportBtn.addEventListener('click', function () {
      openReport('post', p.id, activityTitle(p.activityId) + ' · ' + p.nickname);
    });
    art.appendChild(reportBtn);

    var commentsBox = document.createElement('div');
    commentsBox.className = 'post-comments';
    var commentsTitle = document.createElement('h4');
    commentsTitle.className = 'post-comments-title';
    commentsTitle.textContent = '评论';
    commentsBox.appendChild(commentsTitle);
    (p.comments || []).forEach(function (c) {
      commentsBox.appendChild(buildComment(c, enabled));
    });
    if (enabled) {
      commentsBox.appendChild(buildCommentForm(p.id));
    } else {
      var note = document.createElement('p');
      note.className = 'post-offline-note';
      note.textContent = '社区暂不可用，暂时不能评论。';
      commentsBox.appendChild(note);
    }
    art.appendChild(commentsBox);
    return art;
  }

  function buildComment(c, enabled) {
    var box = document.createElement('div');
    box.className = 'comment';
    var head = document.createElement('div');
    head.className = 'comment-head';
    var nick = document.createElement('span');
    nick.className = 'comment-nick';
    nick.textContent = c.nickname;
    var time = document.createElement('time');
    time.className = 'post-time';
    time.textContent = fmtTime(c.createdAt);
    head.appendChild(nick);
    head.appendChild(time);
    box.appendChild(head);
    var txt = document.createElement('p');
    txt.className = 'comment-text';
    txt.textContent = c.text;
    box.appendChild(txt);
    if (enabled) {
      var rep = document.createElement('button');
      rep.type = 'button';
      rep.className = 'link-btn';
      rep.textContent = '举报评论';
      rep.addEventListener('click', function () {
        openReport('comment', c.id, c.nickname);
      });
      box.appendChild(rep);
    }
    return box;
  }

  function buildCommentForm(postId) {
    var form = document.createElement('form');
    form.className = 'comment-form';
    form.setAttribute('aria-label', '发表评论');

    var nick = document.createElement('input');
    nick.type = 'text';
    nick.maxLength = 20;
    nick.placeholder = '昵称（1–20 字）';
    nick.setAttribute('aria-label', '评论昵称');
    form.appendChild(nick);

    var text = document.createElement('textarea');
    text.rows = 2;
    text.maxLength = 300;
    text.placeholder = '评论（1–300 字）';
    text.setAttribute('aria-label', '评论内容');
    form.appendChild(text);

    var row = document.createElement('div');
    row.className = 'comment-form-row';
    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-ghost';
    submit.textContent = '发表评论';
    row.appendChild(submit);
    var msg = document.createElement('p');
    msg.className = 'comment-msg';
    msg.setAttribute('role', 'status');
    row.appendChild(msg);
    form.appendChild(row);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (submit.disabled) return;
      var nickname = nick.value.trim();
      var content = text.value.trim();
      msg.classList.remove('is-error');
      if (nickname.length < 1 || nickname.length > 20) {
        showCommentError(msg, '昵称需 1–20 字');
        return;
      }
      if (content.length < 1 || content.length > 300) {
        showCommentError(msg, '评论需 1–300 字');
        return;
      }
      submit.disabled = true;
      msg.textContent = '提交中…';
      Community.createComment(postId, { nickname: nickname, text: content }).then(function () {
        msg.textContent = '评论已提交，审核通过后展示。';
        text.value = '';
        nick.value = '';
        submit.disabled = false;
      }).catch(function (err) {
        showCommentError(msg, err.message || '评论提交失败，请稍后再试。');
        submit.disabled = false;
      });
    });
    return form;
  }

  function showCommentError(msg, text) {
    msg.textContent = text;
    msg.classList.add('is-error');
  }

  /* ---------- 举报 ---------- */

  var reportState = null; // {targetType, targetId}

  function openReport(targetType, targetId, label) {
    reportState = { targetType: targetType, targetId: targetId };
    els.reportTarget.textContent = '要举报的内容：' + label;
    els.reportReason.value = '';
    // 重新打开时恢复按钮状态，避免上次成功后仍 disabled。
    els.reportSubmit.disabled = false;
    els.reportSubmit.textContent = '提交举报';
    els.reportError.hidden = true;
    els.reportError.classList.remove('is-error');
    els.reportDialog.hidden = false;
    document.body.style.overflow = 'hidden';
    els.reportReason.focus();
  }

  function closeReport() {
    els.reportDialog.hidden = true;
    document.body.style.overflow = '';
    reportState = null;
  }

  /* ---------- 随机 ---------- */

  function drawWheel(items) {
    var colors = ['#DCEBE5', '#FCEADB', '#E7E0F2', '#E1EDF4', '#F6EDCE', '#DFEEE8', '#F4E2E3', '#E4E9F6'];
    var parts = [];
    var count = items.length;
    var step = 360 / (count || 1);
    function point(deg, radius) {
      var angle = deg * Math.PI / 180;
      return [160 + radius * Math.cos(angle), 160 + radius * Math.sin(angle)];
    }
    if (count <= 1) parts.push('<circle cx="160" cy="160" r="154" fill="' + colors[0] + '"/>');
    items.forEach(function (item, index) {
      var center = index * step - 90;
      if (count > 1) {
        var from = point(center - step / 2, 154);
        var to = point(center + step / 2, 154);
        parts.push('<path d="M160 160 L' + from.join(' ') + ' A154 154 0 ' + (step > 180 ? 1 : 0) + ' 1 ' + to.join(' ') + ' Z" fill="' + colors[index] + '" stroke="#FFFFFF" stroke-width="1.5"/>');
      }
      var at = point(center, 106);
      var chars = Array.from(item.title.split('：')[0]);
      if (chars.length > 9) chars = chars.slice(0, 8).concat('…');
      var lines = chars.length > 5 ? [chars.slice(0, 5).join(''), chars.slice(5).join('')] : [chars.join('')];
      parts.push('<text x="' + at[0] + '" y="' + at[1] + '" text-anchor="middle" dominant-baseline="central" transform="rotate(' + (index * step) + ' ' + at.join(' ') + ')">');
      lines.forEach(function (line, i) {
        parts.push('<tspan x="' + at[0] + '" y="' + (at[1] + (i - (lines.length - 1) / 2) * 16) + '">' + esc(line) + '</tspan>');
      });
      parts.push('</text>');
    });
    parts.push('<circle cx="160" cy="160" r="154" fill="none" stroke="#FFFFFF" stroke-width="4"/>');
    els.wheelDisc.innerHTML = parts.join('');
    els.wheelDisc.style.transform = 'rotate(0deg)';
  }

  function refreshWheel(list) {
    var key = list.map(function (item) { return item.id; }).join('\0');
    if (key === wheelPoolKey) return;
    wheelPoolKey = key;
    wheelSpinner.cancel();
    var preview = Wheel.createRound(list, state.lastRandomId);
    drawWheel(preview ? preview.items : []);
    els.wheelResult.hidden = true;
    els.wheelHint.textContent = list.length ? '从当前 ' + list.length + ' 件小事里挑。' : '没有匹配的小事，换个筛选看看。';
    els.wheelSpin.disabled = els.randomBtn.disabled = !list.length;
  }

  function setupWheel() {
    drawWheel([]);
    wheelSpinner = Wheel.createSpinner({
      onBusy: function (busy) {
        els.wheelSpin.disabled = els.randomBtn.disabled = busy || !state.loaded || !filtered().length;
        els.wheelSpin.textContent = busy ? '转着呢' : '转一下';
        els.wheelResult.setAttribute('aria-busy', String(busy));
        if (busy) { els.wheelResult.hidden = true; els.wheelHint.textContent = '转着呢…'; }
      },
      animate: function (round) {
        drawWheel(round.items);
        var angle = Wheel.targetAngle(round.index, round.items.length);
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !els.wheelDisc.animate) {
          els.wheelDisc.style.transform = 'rotate(' + angle + 'deg)';
          return Promise.resolve();
        }
        var animation = els.wheelDisc.animate([
          { transform: 'rotate(0deg)' },
          { transform: 'rotate(' + (1440 + angle) + 'deg)' }
        ], { duration: 2800, easing: 'cubic-bezier(0.12, 0.75, 0.17, 1)', fill: 'forwards' });
        wheelAnimation = animation;
        return animation.finished.then(function () {
          if (wheelAnimation !== animation) return;
          els.wheelDisc.style.transform = 'rotate(' + angle + 'deg)';
          wheelAnimation = null;
          animation.cancel();
        });
      },
      onCancel: function () {
        if (wheelAnimation) { wheelAnimation.cancel(); wheelAnimation = null; }
      },
      onResult: function (round) {
        state.lastRandomId = round.item.id;
        els.wheelHint.textContent = '这次转到了';
        els.wheelResultTitle.textContent = round.item.title;
        els.wheelMaxim.textContent = round.item.maxim || '';
        els.wheelCost.textContent = Guide.costLabel(round.item.cost) + (round.item.costNote ? '：' + round.item.costNote : '');
        els.wheelDetail.href = '#/a/' + encodeURIComponent(round.item.id);
        els.wheelResult.hidden = false;
      },
      onEmpty: function () { els.wheelHint.textContent = '没有匹配的小事，换个筛选看看。'; },
      onError: function () { els.wheelHint.textContent = '没能转起来，再转一次试试。'; }
    });
  }

  function pickRandom() {
    if (!state.loaded) return;
    wheelSpinner.start(filtered(), state.lastRandomId);
  }

  /* ---------- 事件绑定 ---------- */

  function bind() {
    els.searchInput.addEventListener('input', function () {
      state.query = els.searchInput.value;
      renderBrowse();
    });

    document.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var group = chip.dataset.filter;
        state[group] = chip.dataset.value;
        document.querySelectorAll('.chip[data-filter="' + group + '"]').forEach(function (c) {
          c.classList.toggle('is-active', c === chip);
        });
        renderBrowse();
      });
    });

    els.wheelSpin.addEventListener('click', pickRandom);
    els.randomBtn.addEventListener('click', function () {
      els.wheelSection.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      pickRandom();
    });
    els.retryBtn.addEventListener('click', loadContent);
    els.clearFilterBtn.addEventListener('click', function () {
      state.query = ''; state.category = ''; state.setting = ''; state.company = '';
      els.searchInput.value = '';
      document.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('is-active', c.dataset.value === '');
      });
      renderBrowse();
    });

    document.addEventListener('click', function (e) {
      var fav = e.target.closest('[data-fav]');
      if (fav) {
        var id = fav.dataset.fav;
        if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
        saveSaved();
        renderBrowse();
        renderSaved();
        if (state.detailItem && state.detailItem.id === id) {
          var on = state.saved.has(id);
          els.detailFav.textContent = on ? '★ 已收着' : '☆ 收着';
          els.detailFav.setAttribute('aria-pressed', String(on));
        }
        return;
      }
      var open = e.target.closest('[data-close-dialog]');
      if (open) closeDetail();
      var closeRep = e.target.closest('[data-close-report]');
      if (closeRep) closeReport();
    });

    els.detailClose.addEventListener('click', closeDetail);
    els.detailFav.addEventListener('click', function () {
      if (!state.detailItem) return;
      var id = state.detailItem.id;
      if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
      saveSaved();
      renderBrowse();
      renderSaved();
      var on = state.saved.has(id);
      els.detailFav.textContent = on ? '★ 已收着' : '☆ 收着';
      els.detailFav.setAttribute('aria-pressed', String(on));
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !els.detailDialog.hidden) {
        e.preventDefault();
        closeDetail();
        return;
      }
      if (e.key === 'Escape' && !els.reportDialog.hidden) {
        e.preventDefault();
        closeReport();
        return;
      }
      var focusables = null;
      if (!els.detailDialog.hidden) {
        focusables = els.detailDialog.querySelectorAll('button, a, [href], input, textarea, [tabindex]:not([tabindex="-1"])');
      } else if (!els.reportDialog.hidden) {
        focusables = els.reportDialog.querySelectorAll('button, a, [href], input, textarea, [tabindex]:not([tabindex="-1"])');
      }
      if (focusables && focusables.length && e.key === 'Tab') {
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    window.addEventListener('hashchange', route);

    // 发布体验
    els.postForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = els.postForm.querySelector('button[type="submit"]');
      if (btn.disabled) return;
      var activityId = els.postActivity.value;
      var nickname = els.postNickname.value.trim();
      var text = els.postText.value.trim();
      var err = els.postError;
      err.classList.remove('is-error');
      err.hidden = true;
      if (!activityId) { showFieldError(err, '请选择你做了哪件事'); return; }
      if (nickname.length < 1 || nickname.length > 20) { showFieldError(err, '昵称需 1–20 字'); return; }
      if (text.length < 1 || text.length > 500) { showFieldError(err, '体验需 1–500 字'); return; }
      btn.disabled = true;
      btn.textContent = '提交中…';
      Community.createPost({ activityId: activityId, nickname: nickname, text: text }).then(function () {
        err.textContent = '已提交，审核通过后就会展示在这里。';
        err.hidden = false;
        els.postText.value = '';
        els.postNickname.value = '';
        btn.textContent = '发布，进入审核';
        btn.disabled = false;
      }).catch(function (ex) {
        showFieldError(err, ex.message || '提交失败，请稍后再试。');
        btn.textContent = '发布，进入审核';
        btn.disabled = false;
      });
    });

    // 举报弹窗
    els.reportForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!reportState) return;
      var btn = els.reportSubmit;
      if (btn.disabled) return;
      var reason = els.reportReason.value.trim();
      var err = els.reportError;
      err.classList.remove('is-error');
      err.hidden = true;
      if (reason.length < 1 || reason.length > 200) { showFieldError(err, '原因需 1–200 字'); return; }
      btn.disabled = true;
      Community.report({
        targetType: reportState.targetType,
        targetId: reportState.targetId,
        reason: reason
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '提交举报';
        closeReport();
        showToast('举报已收到，我们会查看。');
      }).catch(function (ex) {
        btn.disabled = false;
        btn.textContent = '提交举报';
        showFieldError(err, ex.message || '举报提交失败，请稍后再试。');
      });
    });
    els.reportClose.addEventListener('click', closeReport);
    els.reportCancel.addEventListener('click', closeReport);
    els.communityRetryBtn.addEventListener('click', loadAndRenderPosts);
  }

  function showFieldError(el, text) {
    el.textContent = text;
    el.classList.add('is-error');
    el.hidden = false;
  }

  function cacheEls() {
    var map = {
      viewBrowse: 'view-browse', viewCommunity: 'view-community', viewSaved: 'view-saved',
      loadError: 'load-error', browseList: 'browse-list', browseEmpty: 'browse-empty',
      savedList: 'saved-list', savedEmpty: 'saved-empty', resultCount: 'result-count',
      searchInput: 'search-input', randomBtn: 'random-btn', retryBtn: 'retry-btn',
      wheelSection: 'wheel-section', wheelDisc: 'wheel-disc', wheelSpin: 'wheel-spin',
      wheelHint: 'wheel-hint', wheelResult: 'wheel-result', wheelResultTitle: 'wheel-result-title',
      wheelMaxim: 'wheel-maxim', wheelCost: 'wheel-cost', wheelDetail: 'wheel-detail',
      clearFilterBtn: 'clear-filter-btn', detailDialog: 'detail-dialog', detailClose: 'detail-close',
      detailTitle: 'detail-title', detailMaxim: 'detail-maxim', detailSummary: 'detail-summary', detailCost: 'detail-cost', detailCategory: 'detail-category',
      detailSetting: 'detail-setting', detailCompany: 'detail-company', detailBody: 'detail-body',
      detailNeedsList: 'detail-needs-list', detailFav: 'detail-fav',
      communityStatus: 'community-status', communityError: 'community-error',
      communityLoadError: 'community-load-error', communityRetryBtn: 'community-retry-btn',
      postForm: 'post-form', postActivity: 'post-activity',
      postNickname: 'post-nickname', postText: 'post-text', postError: 'post-error',
      communityList: 'community-list', communityEmpty: 'community-empty',
      reportDialog: 'report-dialog', reportClose: 'report-close', reportCancel: 'report-cancel',
      reportTarget: 'report-target', reportReason: 'report-reason',
      reportError: 'report-error', reportForm: 'report-form'
    };
    Object.keys(map).forEach(function (key) { els[key] = $(map[key]); });
    els.reportSubmit = els.reportForm.querySelector('button[type="submit"]');
  }

  cacheEls();
  setupWheel();
  bind();
  loadContent();
  route();
})();
