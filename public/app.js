'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 24;
  const EVENT_LABELS = {
    '*': '全部事件',
    'bookmark.created': '新增',
    'bookmark.updated': '更新',
    'bookmark.deleted': '刪除',
    'bookmark.clicked': '點擊',
  };
  const METHOD_LABELS = { POST_JSON: 'POST JSON', POST_FORM: 'POST 表單', GET: 'GET' };
  const FILTER_LABELS = { q: '關鍵字', site: '網站', category: '分類', tag: '標籤' };
  const VIEWS = ['add', 'search', 'settings'];

  const state = {
    filters: { q: '', site: '', category: '', tag: '', sort: 'created' },
    offset: 0,
    draft: null,
    autoSave: false,
    editing: null,
    // 卡片點擊編輯時用 id 找回書籤
    cache: new Map(),
  };

  /** 建立 DOM 元素；使用者資料一律走 textContent，不拼 innerHTML */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    // Session 過期（例如 PWA 開著放了很久）：回登入頁，登入後回到目前畫面
    if (res.status === 401) location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `請求失敗（HTTP ${res.status}）`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function setStatus(el, message, kind = '') {
    el.className = kind;
    el.replaceChildren();
    if (!message) return;
    if (Array.isArray(message)) {
      el.append(message[0], h('ul', {}, message.slice(1).map((m) => h('li', {}, m))));
    } else {
      el.append(message);
    }
  }

  function busy(button, isBusy, label) {
    if (isBusy) {
      button.dataset.label = button.textContent;
      button.textContent = label;
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
    button.disabled = isBusy;
  }

  const dateFormat = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
  function formatDate(iso) {
    return iso ? dateFormat.format(new Date(iso)) : '';
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return '剛剛';
    if (minutes < 60) return `${minutes} 分鐘前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小時前`;
    const days = Math.round(hours / 24);
    return days < 30 ? `${days} 天前` : formatDate(iso);
  }

  function splitTags(value) {
    return value.split(/[,，、]/).map((t) => t.trim()).filter(Boolean);
  }

  function thumbBox(bookmark, link) {
    const fallback = (bookmark.site || bookmark.host || '?').slice(0, 1).toUpperCase();
    const box = link
      ? h('a', { class: 'thumb', href: `/b/${bookmark.share_id}`, target: '_blank', rel: 'noopener', 'aria-hidden': 'true', tabindex: '-1' })
      : h('div', { class: 'thumb' });
    if (bookmark.thumbnail) {
      const img = h('img', { src: bookmark.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.replaceWith(fallback));
      box.append(img);
    } else {
      box.append(fallback);
    }
    return box;
  }

  function favicon(bookmark) {
    if (!bookmark.favicon) return h('span', { class: 'fav' });
    const img = h('img', { class: 'fav', src: bookmark.favicon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => (img.style.visibility = 'hidden'));
    return img;
  }

  function filterButton(type, value, text) {
    return h('button', { type: 'button', class: 'text-btn', onclick: () => applyFilter(type, value) }, text ?? value);
  }

  function extraInfo(extra) {
    const parts = [];
    if (typeof extra.stars === 'number') parts.push(`★ ${extra.stars}`);
    if (extra.language) parts.push(extra.language);
    if (extra.private) parts.push('私有');
    if (extra.author) parts.push(extra.author);
    return parts.join(' · ');
  }

  function bookmarkCard(bookmark) {
    state.cache.set(bookmark.id, bookmark);
    return h('article', { class: 'bm' },
      thumbBox(bookmark, true),
      h('div', { class: 'bm-body' },
        h('div', { class: 'bm-meta' },
          favicon(bookmark),
          filterButton('site', bookmark.site),
          bookmark.category ? ['·', filterButton('category', bookmark.category)] : null,
        ),
        h('h3', {}, h('a', { href: `/b/${bookmark.share_id}`, target: '_blank', rel: 'noopener' }, bookmark.title || bookmark.url)),
        bookmark.summary ? h('p', { class: 'bm-summary' }, bookmark.summary) : null,
        bookmark.note ? h('p', { class: 'bm-note' }, bookmark.note) : null,
        bookmark.tags.length
          ? h('div', { class: 'chips small' }, bookmark.tags.map((tag) => h('button', { type: 'button', class: 'chip', onclick: () => applyFilter('tag', tag) }, `#${tag}`)))
          : null,
        h('div', { class: 'bm-foot' },
          h('span', {}, `${formatDate(bookmark.created_at)} · 點擊 ${bookmark.click_count}`, extraInfo(bookmark.extra) ? ` · ${extraInfo(bookmark.extra)}` : ''),
          h('button', { type: 'button', class: 'text-btn', onclick: () => openEditor(bookmark.id) }, '編輯'),
        ),
      ),
    );
  }

  function miniItem(bookmark, time) {
    state.cache.set(bookmark.id, bookmark);
    return h('li', {},
      favicon(bookmark),
      h('a', { href: `/b/${bookmark.share_id}`, target: '_blank', rel: 'noopener', title: bookmark.title }, bookmark.title || bookmark.url),
      h('small', {}, `${bookmark.site} · ${timeAgo(time)}`),
    );
  }

  function facetChips(container, items, type) {
    container.replaceChildren();
    if (!items.length) {
      container.append(h('p', { class: 'empty' }, '還沒有資料'));
      return;
    }
    for (const item of items) {
      const pressed = state.filters[type] === item.name;
      container.append(
        h('button', { type: 'button', class: 'chip', 'aria-pressed': String(pressed), onclick: () => applyFilter(type, pressed ? '' : item.name) },
          type === 'tag' ? `#${item.name}` : item.name, h('b', {}, item.count)),
      );
    }
  }

  function fillDatalist(id, items) {
    $(id).replaceChildren(...items.map((item) => h('option', { value: item.name })));
  }

  let overview = null;
  async function loadOverview() {
    try {
      overview = await api('/api/overview');
    } catch (err) {
      setStatus($('list-status'), `無法載入總覽：${err.message}`, 'error');
      return;
    }
    $('total-count').textContent = overview.total;
    const recent = $('recent-list');
    recent.replaceChildren(...overview.recent.map((b) => miniItem(b, b.created_at)));
    if (!overview.recent.length) recent.append(h('li', {}, h('p', { class: 'empty' }, '還沒有書籤，從 01 新增第一筆')));
    const clicked = $('clicked-list');
    clicked.replaceChildren(...overview.clicked.map((b) => miniItem(b, b.last_clicked_at)));
    if (!overview.clicked.length) clicked.append(h('li', {}, h('p', { class: 'empty' }, '點開任一書籤後會出現在這裡')));
    renderFacets();
    fillDatalist('category-options', overview.categories);
    fillDatalist('tag-options', overview.tags);
  }

  function renderFacets() {
    if (!overview) return;
    facetChips($('site-chips'), overview.sites, 'site');
    facetChips($('category-chips'), overview.categories, 'category');
    facetChips($('tag-chips'), overview.tags, 'tag');
  }

  function renderActiveFilters() {
    const box = $('active-filters');
    box.replaceChildren();
    for (const type of ['q', 'site', 'category', 'tag']) {
      const value = state.filters[type];
      if (!value) continue;
      box.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', 'aria-label': `移除${FILTER_LABELS[type]}篩選：${value}`, onclick: () => applyFilter(type, '') },
        `${FILTER_LABELS[type]}：${value}`, h('b', {}, '×')));
    }
  }

  async function loadBookmarks(append = false) {
    if (!append) state.offset = 0;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(state.offset) });
    for (const [key, value] of Object.entries(state.filters)) if (value) params.set(key, value);
    const grid = $('bookmark-grid');
    const more = $('load-more');
    try {
      const data = await api(`/api/bookmarks?${params}`);
      if (!append) grid.replaceChildren();
      grid.append(...data.items.map(bookmarkCard));
      state.offset += data.items.length;
      more.hidden = !data.hasMore;
      const filtered = Object.entries(state.filters).some(([k, v]) => k !== 'sort' && v);
      setStatus($('list-status'), !grid.children.length ? (filtered ? '沒有符合條件的書籤' : '還沒有書籤') : '', 'warn');
    } catch (err) {
      setStatus($('list-status'), `無法載入書籤：${err.message}`, 'error');
    }
  }

  function applyFilter(type, value) {
    state.filters[type] = value;
    if (type === 'q') $('search-input').value = value;
    renderActiveFilters();
    renderFacets();
    loadBookmarks();
    // 加上篩選時切到搜尋頁，才看得到分類瀏覽；移除篩選則留在原頁
    if (value && showView('search')) location.hash = 'search';
    $('all').scrollIntoView({ block: 'start' });
  }

  // 分頁：#add 新增與列表、#search 搜尋與列表、#settings 設定；回傳是否真的換頁
  function showView(view) {
    if (!VIEWS.includes(view)) view = 'add';
    const board = document.querySelector('.board');
    if (board.dataset.view === view) return false;
    board.dataset.view = view;
    for (const section of board.querySelectorAll('[data-views]')) {
      section.hidden = !section.dataset.views.split(' ').includes(view);
    }
    for (const link of document.querySelectorAll('.view-nav a')) {
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    return true;
  }

  window.addEventListener('hashchange', () => {
    const board = document.querySelector('.board');
    if (showView(location.hash.slice(1)) && board.getBoundingClientRect().top < 0) board.scrollIntoView({ block: 'start' });
  });

  // 新增書籤
  function showDraft(draft) {
    state.draft = draft;
    $('draft-form').hidden = false;
    $('draft-title').value = draft.title;
    $('draft-summary').value = draft.summary;
    $('draft-category').value = draft.category;
    $('draft-tags').value = draft.tags.join(', ');
    $('draft-thumbnail').value = draft.thumbnail;
    $('draft-note').value = '';
    $('draft-url').href = draft.url;
    $('draft-url').textContent = draft.url;
    $('draft-source').textContent = `${draft.source.extractor}${draft.source.ai ? ' · AI 產生' : ' · 規則產生'}`;
    $('draft-thumb').replaceWith(Object.assign(thumbBox(draft, false), { id: 'draft-thumb' }));
    setStatus($('save-status'), '');
  }

  // 設定頁開啟「直接保存」時：抓到的內容不經確認表單直接保存；失敗時退回確認表單，內容不必重抓
  async function saveNow(draft, status) {
    setStatus(status, '已抓取，保存中…');
    let bookmark;
    try {
      ({ bookmark } = await api('/api/bookmarks', {
        method: 'POST',
        body: {
          url: draft.url, title: draft.title || draft.url, summary: draft.summary, category: draft.category, tags: draft.tags,
          thumbnail: draft.thumbnail, favicon: draft.favicon, note: '', extra: draft.extra,
        },
      }));
    } catch (err) {
      showDraft(draft);
      throw err;
    }
    resetDraft();
    const notes = draft.source.warnings;
    setStatus(status, notes.length ? [`已保存「${bookmark.title}」，但有以下提醒：`, ...notes] : `已保存「${bookmark.title}」`, notes.length ? 'warn' : 'ok');
    status.append(h('button', { type: 'button', class: 'text-btn', onclick: () => openEditor(bookmark.id) }, '編輯'));
    await Promise.all([loadOverview(), loadBookmarks()]);
  }

  $('fetch-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = $('url-input').value.trim();
    const status = $('fetch-status');
    if (!url) {
      setStatus(status, '請輸入網址', 'error');
      $('url-input').focus();
      return;
    }
    const button = event.submitter || $('fetch-form').querySelector('button');
    busy(button, true, '抓取中…');
    setStatus(status, '正在抓取頁面並整理內容，約需數秒');
    try {
      const { draft, duplicateId } = await api('/api/preview', { method: 'POST', body: { url } });
      // 已收藏過的網址照舊停在確認表單，讓使用者看到提醒
      if (state.autoSave && !duplicateId) {
        await saveNow(draft, status);
        return;
      }
      showDraft(draft);
      const notes = [...draft.source.warnings];
      if (duplicateId) {
        setStatus(status, ['這個網址已經收藏過了。', ...notes], 'warn');
        status.append(h('button', { type: 'button', class: 'text-btn', onclick: () => openEditor(duplicateId) }, '開啟既有書籤'));
      } else if (notes.length) {
        setStatus(status, ['已抓取，但有以下提醒：', ...notes], 'warn');
      } else {
        setStatus(status, '已抓取，確認內容後按「保存書籤」', 'ok');
      }
      $('draft-title').focus();
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  $('draft-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.draft) return;
    const title = $('draft-title').value.trim();
    if (!title) {
      setStatus($('save-status'), '標題不能空白', 'error');
      $('draft-title').focus();
      return;
    }
    const button = event.submitter || $('draft-form').querySelector('button[type=submit]');
    busy(button, true, '保存中…');
    try {
      await api('/api/bookmarks', {
        method: 'POST',
        body: {
          url: state.draft.url,
          title,
          summary: $('draft-summary').value,
          category: $('draft-category').value,
          tags: splitTags($('draft-tags').value),
          thumbnail: $('draft-thumbnail').value,
          favicon: state.draft.favicon,
          note: $('draft-note').value,
          extra: state.draft.extra,
        },
      });
      resetDraft();
      setStatus($('fetch-status'), '已保存', 'ok');
      await Promise.all([loadOverview(), loadBookmarks()]);
    } catch (err) {
      setStatus($('save-status'), err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  function resetDraft() {
    state.draft = null;
    $('draft-form').hidden = true;
    $('url-input').value = '';
    setStatus($('fetch-status'), '');
  }
  $('draft-cancel').addEventListener('click', () => {
    resetDraft();
    $('url-input').focus();
  });

  // 搜尋
  let searchTimer = 0;
  function searchNow() {
    clearTimeout(searchTimer);
    state.filters.q = $('search-input').value.trim();
    renderActiveFilters();
    loadBookmarks();
  }
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchNow, 300);
  });
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    searchNow();
  });
  $('sort-select').addEventListener('change', () => {
    state.filters.sort = $('sort-select').value;
    loadBookmarks();
  });
  $('load-more').addEventListener('click', () => loadBookmarks(true));

  // 編輯對話框
  async function openEditor(id) {
    let bookmark = state.cache.get(id);
    if (!bookmark) {
      try {
        bookmark = (await api(`/api/bookmarks/${id}`)).bookmark;
      } catch (err) {
        alert(err.message);
        return;
      }
    }
    state.editing = bookmark;
    $('edit-url').textContent = bookmark.url;
    $('edit-title-input').value = bookmark.title;
    $('edit-summary').value = bookmark.summary;
    $('edit-category').value = bookmark.category;
    $('edit-tags').value = bookmark.tags.join(', ');
    $('edit-thumbnail').value = bookmark.thumbnail;
    $('edit-note').value = bookmark.note;
    setStatus($('edit-status'), '');
    $('edit-dialog').showModal();
  }

  $('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const bookmark = state.editing;
    if (!bookmark) return;
    const button = event.submitter || $('edit-form').querySelector('button[type=submit]');
    busy(button, true, '儲存中…');
    try {
      const { bookmark: updated } = await api(`/api/bookmarks/${bookmark.id}`, {
        method: 'PATCH',
        body: {
          title: $('edit-title-input').value,
          summary: $('edit-summary').value,
          category: $('edit-category').value,
          tags: splitTags($('edit-tags').value),
          thumbnail: $('edit-thumbnail').value,
          note: $('edit-note').value,
        },
      });
      state.cache.set(updated.id, updated);
      $('edit-dialog').close();
      await Promise.all([loadOverview(), loadBookmarks()]);
    } catch (err) {
      setStatus($('edit-status'), err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  $('edit-delete').addEventListener('click', async () => {
    const bookmark = state.editing;
    if (!bookmark || !confirm(`確定要刪除「${bookmark.title}」？`)) return;
    try {
      await api(`/api/bookmarks/${bookmark.id}`, { method: 'DELETE' });
      state.cache.delete(bookmark.id);
      $('edit-dialog').close();
      await Promise.all([loadOverview(), loadBookmarks()]);
    } catch (err) {
      setStatus($('edit-status'), err.message, 'error');
    }
  });
  $('edit-close').addEventListener('click', () => $('edit-dialog').close());

  // Webhook（設定頁）
  function hookItem(hook) {
    const call = async (button, label, fn) => {
      busy(button, true, label);
      try {
        await fn();
      } catch (err) {
        setStatus($('hook-status'), err.message, 'error');
      } finally {
        busy(button, false);
        await loadHooks();
      }
    };
    const status = hook.last_called_at ? `上次：${hook.last_status}（${timeAgo(hook.last_called_at)}）` : '尚未呼叫';
    return h('li', { class: hook.enabled ? '' : 'off' },
      h('div', { class: 'bm-meta' },
        h('strong', {}, hook.name || '未命名'),
        h('span', { class: 'badge' }, EVENT_LABELS[hook.event] ?? hook.event),
        h('span', { class: 'badge plain' }, METHOD_LABELS[hook.method] ?? hook.method),
        hook.has_secret ? h('span', { class: 'badge plain' }, '已簽章') : null,
      ),
      h('p', { class: 'hook-url' }, hook.url),
      h('p', { class: 'hook-status' }, status),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'ghost', onclick: (e) => call(e.currentTarget, '測試中…', async () => {
          const { status } = await api(`/api/webhooks/${hook.id}/test`, { method: 'POST', body: {} });
          setStatus($('hook-status'), `測試結果：${status}`, status.startsWith('HTTP 2') ? 'ok' : 'warn');
        }) }, '測試'),
        h('button', { type: 'button', class: 'ghost', onclick: (e) => call(e.currentTarget, '更新中…', () =>
          api(`/api/webhooks/${hook.id}`, { method: 'PATCH', body: { enabled: !hook.enabled } })) }, hook.enabled ? '停用' : '啟用'),
        h('button', { type: 'button', class: 'danger', onclick: (e) => {
          if (confirm(`確定要刪除 Webhook「${hook.name || hook.url}」？`)) call(e.currentTarget, '刪除中…', () => api(`/api/webhooks/${hook.id}`, { method: 'DELETE' }));
        } }, '刪除'),
      ),
    );
  }

  async function loadHooks() {
    const list = $('hook-list');
    try {
      const { webhooks } = await api('/api/webhooks');
      list.replaceChildren(...webhooks.map(hookItem));
      if (!webhooks.length) list.append(h('li', {}, h('p', { class: 'empty' }, '還沒有 Webhook')));
    } catch (err) {
      setStatus($('hook-status'), `無法載入 Webhook：${err.message}`, 'error');
    }
  }

  $('hook-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('hook-status');
    if (!$('hook-url').checkValidity() || !$('hook-url').value) {
      setStatus(status, '請輸入 http 或 https 開頭的網址', 'error');
      $('hook-url').focus();
      return;
    }
    const button = event.submitter || $('hook-form').querySelector('button');
    busy(button, true, '新增中…');
    try {
      await api('/api/webhooks', {
        method: 'POST',
        body: {
          name: $('hook-name').value,
          event: $('hook-event').value,
          method: $('hook-method').value,
          url: $('hook-url').value,
          secret: $('hook-secret').value,
        },
      });
      $('hook-form').reset();
      setStatus(status, '已新增，可按「測試」確認對方收得到', 'ok');
      await loadHooks();
    } catch (err) {
      setStatus(status, err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  // 個人資料（設定頁）
  function showOwner(name) {
    $('owner-name').textContent = name || 'PRIVATE';
  }

  // 直接保存：新增書籤時抓取完就保存，不顯示確認表單
  function showAutoSave(on) {
    state.autoSave = on;
    $('pref-autosave').checked = on;
    $('add-desc').textContent = on ? '輸入網址，抓取資訊後直接保存' : '輸入網址，抓取資訊後確認再保存';
    $('fetch-form').querySelector('button').textContent = on ? '抓取並保存' : '抓取資訊';
  }

  async function loadSettings() {
    try {
      const settings = await api('/api/settings');
      $('profile-name').value = settings.name;
      showOwner(settings.name);
      showAutoSave(settings.autoSave);
      $('auth-info').replaceChildren('登入帳號為 ', h('b', {}, settings.username || '（未設定）'), '。帳號密碼由環境變數 ',
        h('code', {}, 'AUTH_USER'), '／', h('code', {}, 'AUTH_PASS'), ' 設定，這裡不能修改；變更後到「登入方式」按「登出其他裝置」。');
    } catch (err) {
      setStatus($('profile-status'), `無法載入設定：${err.message}`, 'error');
    }
  }

  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('profile-form').querySelector('button');
    busy(button, true, '儲存中…');
    try {
      const { name } = await api('/api/settings', { method: 'PATCH', body: { name: $('profile-name').value } });
      showOwner(name);
      setStatus($('profile-status'), '已儲存', 'ok');
    } catch (err) {
      setStatus($('profile-status'), err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  $('pref-autosave').addEventListener('change', async (event) => {
    const input = event.currentTarget;
    input.disabled = true;
    try {
      const { autoSave } = await api('/api/settings', { method: 'PATCH', body: { autoSave: input.checked } });
      showAutoSave(autoSave);
      setStatus($('pref-status'), autoSave ? '已開啟，新增書籤時抓取完直接保存' : '已關閉，新增書籤時先確認再保存', 'ok');
    } catch (err) {
      input.checked = !input.checked;
      setStatus($('pref-status'), err.message, 'error');
    } finally {
      input.disabled = false;
    }
  });

  // 通知信（設定頁）
  async function loadMail() {
    try {
      const mail = await api('/api/settings/mail');
      $('mail-from').value = mail.from;
      $('mail-to').value = mail.to.join('\n');
    } catch (err) {
      setStatus($('mail-status'), `無法載入通知信設定：${err.message}`, 'error');
    }
  }

  $('mail-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('mail-form').querySelector('button');
    busy(button, true, '儲存中…');
    try {
      const mail = await api('/api/settings/mail', { method: 'PUT', body: { from: $('mail-from').value, to: $('mail-to').value } });
      $('mail-from').value = mail.from;
      $('mail-to').value = mail.to.join('\n');
      setStatus($('mail-status'), mail.to.length ? `已儲存，新增書籤時會寄給 ${mail.to.length} 個地址` : '已儲存，目前不寄通知信', 'ok');
    } catch (err) {
      setStatus($('mail-status'), err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  $('mail-test').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    busy(button, true, '寄送中…');
    try {
      const { results } = await api('/api/settings/mail/test', { method: 'POST', body: {} });
      const failed = results.filter((r) => !r.status.startsWith('OK'));
      setStatus($('mail-status'), [failed.length ? `${failed.length} 個地址寄送失敗：` : '已寄出，請到收件匣確認：', ...results.map((r) => `${r.to}：${r.status}`)], failed.length ? 'warn' : 'ok');
    } catch (err) {
      setStatus($('mail-status'), err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  // 登入方式（設定頁）：Passkey 與登入中的裝置
  function passkeyItem(passkey) {
    const used = passkey.last_used_at ? `最近使用 ${timeAgo(passkey.last_used_at)}` : '尚未用來登入';
    return h('li', {},
      h('div', { class: 'bm-meta' },
        h('strong', {}, passkey.name),
        h('span', { class: 'badge plain' }, passkey.synced ? '已同步' : '僅此驗證器'),
      ),
      h('p', { class: 'hint' }, `新增於 ${formatDate(passkey.created_at)} · ${used}`),
      h('button', { type: 'button', class: 'danger', onclick: async (e) => {
        if (!confirm(`刪除「${passkey.name}」？刪除後這個 Passkey 就不能登入。`)) return;
        busy(e.currentTarget, true, '刪除中…');
        try {
          const { passkeys } = await api(`/api/settings/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
          renderPasskeys(passkeys);
          setStatus($('session-status'), '已刪除。裝置上的 Passkey 不會自動消失，可到系統的密碼管理一併刪除', 'ok');
        } catch (err) {
          setStatus($('session-status'), err.message, 'error');
          busy(e.currentTarget, false);
        }
      } }, '刪除'),
    );
  }

  function renderPasskeys(passkeys) {
    $('passkey-list').replaceChildren(...passkeys.map(passkeyItem));
    if (!passkeys.length) $('passkey-list').append(h('li', {}, h('p', { class: 'empty' }, '還沒有 Passkey')));
    showAppPasskey(passkeys.length > 0);
  }

  function showSessions(count) {
    $('session-info').textContent = `目前有 ${count} 個登入中的瀏覽器或 App，閒置 30 天後自動登出。程式以 Basic Auth 呼叫不算在內。`;
  }

  async function loadLogin() {
    try {
      const { passkeys, sessions, session } = await api('/api/settings/login');
      renderPasskeys(passkeys);
      showSessions(sessions);
      $('logout').hidden = !session;
    } catch (err) {
      setStatus($('session-status'), `無法載入登入方式：${err.message}`, 'error');
    }
  }

  if (!window.Passkey || !window.Passkey.supported()) {
    $('passkey-hint').textContent = '這個瀏覽器不支援 Passkey，請改用 Safari、Chrome、Edge 或 Firefox 的新版本。';
    $('passkey-form').querySelector('button').disabled = true;
  }

  $('passkey-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('passkey-status');
    const button = event.submitter || $('passkey-form').querySelector('button');
    busy(button, true, '等待驗證…');
    try {
      const options = await api('/api/settings/passkeys/options', { method: 'POST', body: { currentPassword: $('passkey-current').value } });
      const response = await window.Passkey.create(options);
      const { passkeys } = await api('/api/settings/passkeys', { method: 'POST', body: { name: $('passkey-name').value, response } });
      $('passkey-form').reset();
      renderPasskeys(passkeys);
      setStatus(status, '已新增，下次在登入頁按「使用 Passkey 登入」即可', 'ok');
    } catch (err) {
      setStatus(status, window.Passkey.message(err), 'error');
    } finally {
      busy(button, false);
    }
  });

  $('logout-others').addEventListener('click', async (event) => {
    if (!confirm('登出這台裝置以外的所有瀏覽器與 App？')) return;
    const button = event.currentTarget;
    busy(button, true, '登出中…');
    try {
      const { sessions } = await api('/api/settings/sessions', { method: 'DELETE' });
      showSessions(sessions);
      setStatus($('session-status'), '其他裝置已登出', 'ok');
    } catch (err) {
      setStatus($('session-status'), err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  $('logout').addEventListener('click', async (event) => {
    busy(event.currentTarget, true, '登出中…');
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } finally {
      location.replace('/login');
    }
  });

  // 應用程式帳密（設定頁）：密碼只在建立後顯示一次
  function appItem(app) {
    const used = app.last_used_at ? `最近使用 ${timeAgo(app.last_used_at)}` : '尚未使用';
    return h('li', {},
      h('div', { class: 'bm-meta' }, h('strong', {}, app.name), h('code', {}, app.username)),
      h('p', { class: 'hint' }, `建立於 ${formatDate(app.created_at)} · ${used} · 紀錄保留 ${app.log_days} 天／${app.log_limit} 筆`),
      h('div', { class: 'app-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => openAppLogs(app) }, '紀錄'),
        h('button', { type: 'button', class: 'danger', onclick: async (e) => {
          if (!confirm(`刪除「${app.name}」？使用這組帳密的程式會立即無法呼叫，呼叫紀錄也會一併刪除。`)) return;
          // await 之後 e.currentTarget 會變成 null，先存起來
          const button = e.currentTarget;
          busy(button, true, '刪除中…');
          try {
            const { apps } = await api(`/api/settings/apps/${app.id}`, { method: 'DELETE' });
            renderApps(apps);
            setStatus($('app-list-status'), '已刪除', 'ok');
          } catch (err) {
            setStatus($('app-list-status'), err.message, 'error');
            busy(button, false);
          }
        } }, '刪除'),
      ),
    );
  }

  function renderApps(apps) {
    $('app-list').replaceChildren(...apps.map(appItem));
    if (!apps.length) $('app-list').append(h('li', {}, h('p', { class: 'empty' }, '還沒有應用程式帳密')));
  }

  function secretRow(label, value) {
    const button = h('button', { type: 'button', class: 'ghost' }, '複製');
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = '已複製';
      } catch {
        button.textContent = '請手動選取';
      }
    });
    return h('div', { class: 'secret-row' }, h('span', {}, label), h('code', {}, value), button);
  }

  function showAppSecret(app, password) {
    const example = `curl -u '${app.username}:${password}' -H 'Content-Type: application/json' \\\n  -d '{"url":"https://example.com/"}' ${location.origin}/api/bookmarks`;
    $('app-secret').replaceChildren(
      h('strong', {}, '請立即複製保存，離開或重新整理後就看不到密碼'),
      secretRow('帳號', app.username),
      secretRow('密碼', password),
      secretRow('網址', location.origin),
      secretRow('授權碼', btoa(`${app.username}:${password}`)),
      h('p', { class: 'hint' }, '網址與授權碼給 iPhone／Mac 捷徑加入時填寫。授權碼等同密碼，同樣只顯示這一次。'),
      h('pre', {}, example),
    );
    $('app-secret').hidden = false;
  }

  async function loadApps() {
    try {
      const { apps } = await api('/api/settings/apps');
      renderApps(apps);
    } catch (err) {
      setStatus($('app-list-status'), `無法載入應用程式帳密：${err.message}`, 'error');
    }
  }

  // 有 Passkey 且瀏覽器支援時，確認身分可改用 Passkey 代替目前密碼
  function showAppPasskey(available) {
    $('app-verify-passkey').hidden = !(available && Boolean(window.Passkey) && window.Passkey.supported());
  }

  // 按「建立帳密」先展開「確認身分」，確認後才真的建立
  function toggleAppVerify(open) {
    $('app-verify').hidden = !open;
    $('app-submit').hidden = open;
    $('app-current').value = '';
    if (open) $('app-current').focus();
  }

  async function createApp(button, usePasskey) {
    const status = $('app-status');
    if (!usePasskey && !$('app-current').value) {
      setStatus(status, '請輸入目前密碼', 'error');
      $('app-current').focus();
      return;
    }
    busy(button, true, usePasskey ? '等待驗證…' : '建立中…');
    try {
      const body = { name: $('app-name').value, logDays: $('app-new-days').value, logLimit: $('app-new-limit').value };
      // Passkey：跟登入頁一樣先取 challenge 請瀏覽器簽章，簽章跟表單一起送出
      if (usePasskey) body.passkey = await window.Passkey.get(await api('/api/auth/passkey/options', { method: 'POST', body: {} }));
      else body.currentPassword = $('app-current').value;
      const { app, password, apps } = await api('/api/settings/apps', { method: 'POST', body });
      $('app-form').reset();
      toggleAppVerify(false);
      renderApps(apps);
      showAppSecret(app, password);
      setStatus(status, `已建立「${app.name}」`, 'ok');
    } catch (err) {
      setStatus(status, usePasskey ? window.Passkey.message(err) : err.message, 'error');
    } finally {
      busy(button, false);
    }
  }

  // 第一次送出（名稱等欄位已通過瀏覽器驗證）只展開確認身分；密碼欄按 Enter 或「用密碼建立」才送出
  $('app-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('app-verify').hidden) {
      setStatus($('app-status'), '');
      toggleAppVerify(true);
      return;
    }
    createApp($('app-verify-password'), false);
  });
  $('app-verify-passkey').addEventListener('click', (event) => createApp(event.currentTarget, true));
  $('app-verify-cancel').addEventListener('click', () => toggleAppVerify(false));

  // 應用程式帳密的呼叫紀錄與保留設定（對話框）
  const LOG_PAGE = 50;
  const logTimeFormat = new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const appLogs = { app: null, offset: 0 };

  function appLogItem(log) {
    const detail = [logTimeFormat.format(new Date(log.created_at)), log.bookmark_id ? `書籤 #${log.bookmark_id}` : '', log.ip, `${log.duration_ms} ms`];
    return h('li', { class: log.status >= 400 ? 'fail' : '' },
      h('div', { class: 'bm-meta' }, h('span', { class: 'badge plain' }, String(log.status)), h('strong', {}, log.method), h('code', {}, log.path)),
      h('p', { class: 'hint' }, detail.filter(Boolean).join(' · ')),
      log.user_agent ? h('p', { class: 'hint log-ua' }, log.user_agent) : null,
    );
  }

  async function loadAppLogs(reset) {
    if (reset) {
      appLogs.offset = 0;
      $('app-log-list').replaceChildren();
    }
    const more = $('app-log-more');
    busy(more, true, '載入中…');
    try {
      const { logs, total } = await api(`/api/settings/apps/${appLogs.app.id}/logs?limit=${LOG_PAGE}&offset=${appLogs.offset}`);
      appLogs.offset += logs.length;
      $('app-log-list').append(...logs.map(appLogItem));
      $('app-log-summary').textContent = total ? `共 ${total} 筆紀錄，最新的在最上面` : '還沒有呼叫紀錄';
      more.hidden = appLogs.offset >= total;
    } catch (err) {
      setStatus($('app-dialog-status'), `無法載入紀錄：${err.message}`, 'error');
    } finally {
      busy(more, false);
    }
  }

  function openAppLogs(app) {
    appLogs.app = app;
    $('app-dialog-title').textContent = `${app.name} 的呼叫紀錄`;
    $('app-dialog-user').textContent = app.username;
    $('app-log-days').value = app.log_days;
    $('app-log-limit').value = app.log_limit;
    setStatus($('app-dialog-status'), '');
    $('app-log-summary').textContent = '';
    $('app-dialog').showModal();
    loadAppLogs(true);
  }

  $('app-retention-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('app-retention-form').querySelector('button[type=submit]');
    busy(button, true, '儲存中…');
    try {
      const { app, apps } = await api(`/api/settings/apps/${appLogs.app.id}`, {
        method: 'PATCH',
        body: { logDays: $('app-log-days').value, logLimit: $('app-log-limit').value },
      });
      appLogs.app = app;
      renderApps(apps);
      setStatus($('app-dialog-status'), `已儲存，保留 ${app.log_days} 天、最多 ${app.log_limit} 筆`, 'ok');
      loadAppLogs(true);
    } catch (err) {
      setStatus($('app-dialog-status'), err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  $('app-log-more').addEventListener('click', () => loadAppLogs(false));
  $('app-dialog-close').addEventListener('click', () => $('app-dialog').close());

  // 從中轉頁開新分頁點擊後回到本頁，更新「最近點擊」
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadOverview();
  });

  // 中轉頁（另一個分頁）編輯或刪除書籤後通知這裡重新載入
  if ('BroadcastChannel' in window) {
    new BroadcastChannel('bookmarks').addEventListener('message', () => Promise.all([loadOverview(), loadBookmarks()]));
  }

  // PWA 分享目標：其他 App 分享過來的網址（Android 常放在 text 裡）直接帶入並抓取
  function handleSharedUrl() {
    const params = new URLSearchParams(location.search);
    const shared = params.get('url') || (params.get('text') || '').match(/https?:\/\/\S+/)?.[0];
    if (!shared) return;
    history.replaceState(null, '', '/');
    showView('add');
    $('url-input').value = shared;
    $('fetch-form').requestSubmit();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service Worker 註冊失敗', err));
  }

  showView(location.hash.slice(1));
  loadOverview();
  loadBookmarks();
  // Webhook 介面暫時隱藏，恢復時加回 loadHooks()
  const settingsLoaded = loadSettings();
  loadMail();
  loadLogin();
  loadApps();
  // 分享進來的網址要等設定載入，才知道要不要直接保存
  settingsLoaded.then(handleSharedUrl);
})();
