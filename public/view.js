'use strict';

// 書籤中轉頁 /b/<share_id>：未登入只能瀏覽與分享；登入時多了返回、編輯與刪除
(() => {
  const $ = (id) => document.getElementById(id);
  const shareId = location.pathname.split('/')[2] || '';
  const shareUrl = `${location.origin}/b/${shareId}`;

  const state = { bookmark: null, owner: false, image: null };

  /** 建立 DOM 元素；使用者資料一律走 textContent，不拼 innerHTML */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
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
    if (res.status === 401) location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `請求失敗（HTTP ${res.status}）`);
    return data;
  }

  function setStatus(el, message, kind = '') {
    el.className = kind;
    el.textContent = message;
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
  const formatDate = (iso) => (iso ? dateFormat.format(new Date(iso)) : '');
  const splitTags = (value) => value.split(/[,，、]/).map((t) => t.trim()).filter(Boolean);
  const monogram = (bookmark) => (bookmark.site || bookmark.host || '?').slice(0, 1).toUpperCase();

  function extraInfo(extra) {
    const parts = [];
    if (typeof extra.stars === 'number') parts.push(`★ ${extra.stars}`);
    if (extra.language) parts.push(extra.language);
    if (extra.author) parts.push(extra.author);
    return parts;
  }

  // 頁面內容
  function render() {
    const b = state.bookmark;
    const card = $('view-card');
    const cover = $('view-cover');
    // 登入時經 /go/ 記錄點擊；未登入沒有 /go/ 的權限，直接開原網址
    const target = state.owner ? `/go/${b.id}` : b.url;

    document.title = `${b.title || b.url}｜書籤收藏櫃`;
    cover.href = target;
    cover.replaceChildren();
    card.classList.toggle('no-image', !b.thumbnail);
    if (b.thumbnail) {
      const img = h('img', { src: b.thumbnail, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => {
        card.classList.add('no-image');
        cover.replaceChildren(h('span', { class: 'view-mono' }, monogram(b)));
      });
      cover.append(img);
    } else {
      cover.append(h('span', { class: 'view-mono' }, monogram(b)));
    }

    $('view-eyebrow').textContent = [b.site, b.category].filter(Boolean).join(' · ').toUpperCase();
    const fav = $('view-fav');
    fav.replaceChildren();
    if (b.favicon) {
      const img = h('img', { class: 'fav', src: b.favicon, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());
      fav.append(img);
    }
    $('view-host').textContent = b.host;
    $('view-title').textContent = b.title || b.url;
    $('view-url').href = target;
    $('view-url').textContent = b.url;
    $('view-summary').textContent = b.summary;
    $('view-tags').replaceChildren(...b.tags.map((tag) => h('span', { class: 'chip' }, `#${tag}`)));
    $('view-note').hidden = !b.note;
    $('view-note').textContent = b.note || '';
    const meta = [`收藏於 ${formatDate(b.created_at)}`];
    if (state.owner) meta.push(`點擊 ${b.click_count}`);
    $('view-meta').textContent = [...meta, ...extraInfo(b.extra)].join(' · ');
    $('view-open').href = target;
    card.hidden = false;
  }

  function showGone(message) {
    $('view-card').hidden = true;
    $('edit').hidden = true;
    $('share').hidden = true;
    setStatus($('view-status'), message, 'warn');
  }

  async function load() {
    try {
      const data = await api(`/api/share/${encodeURIComponent(shareId)}`);
      state.bookmark = data.bookmark;
      state.owner = data.owner;
      setStatus($('view-status'), '');
      if (data.owner) {
        $('viewer-name').textContent = data.viewer.name || 'PRIVATE';
        $('viewer').hidden = false;
        $('back').hidden = false;
        $('edit').hidden = false;
      }
      $('share').hidden = false;
      render();
    } catch (err) {
      showGone(err.message);
    }
  }

  // 返回：從列表另開的分頁沒有上一頁，改關掉分頁回到列表；關不掉（例如直接開網址）就回首頁
  $('back').addEventListener('click', () => {
    if (history.length > 1) {
      history.back();
      return;
    }
    window.close();
    setTimeout(() => location.assign('/'), 200);
  });

  // 通知列表分頁重新載入
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('bookmarks') : null;
  const notifyList = () => channel?.postMessage('changed');

  // 編輯對話框（登入時）
  let vocabulary = null;
  async function fillVocabulary() {
    if (vocabulary) return;
    try {
      vocabulary = await api('/api/overview');
      $('category-options').replaceChildren(...vocabulary.categories.map((item) => h('option', { value: item.name })));
      $('tag-options').replaceChildren(...vocabulary.tags.map((item) => h('option', { value: item.name })));
    } catch {
      // 只是輸入建議，載不到不影響編輯
    }
  }

  $('edit').addEventListener('click', () => {
    const b = state.bookmark;
    $('edit-url').textContent = b.url;
    $('edit-title-input').value = b.title;
    $('edit-summary').value = b.summary;
    $('edit-category').value = b.category;
    $('edit-tags').value = b.tags.join(', ');
    $('edit-thumbnail').value = b.thumbnail;
    $('edit-note').value = b.note;
    setStatus($('edit-status'), '');
    $('edit-dialog').showModal();
    fillVocabulary();
  });

  $('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('edit-form').querySelector('button[type=submit]');
    busy(button, true, '儲存中…');
    try {
      const { bookmark } = await api(`/api/bookmarks/${state.bookmark.id}`, {
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
      state.bookmark = bookmark;
      // 內容改了，分享圖下次打開時重畫
      if (state.image) URL.revokeObjectURL(state.image.url);
      state.image = null;
      render();
      notifyList();
      $('edit-dialog').close();
    } catch (err) {
      setStatus($('edit-status'), err.message, 'error');
    } finally {
      busy(button, false);
    }
  });

  $('edit-delete').addEventListener('click', async () => {
    const b = state.bookmark;
    if (!confirm(`確定要刪除「${b.title}」？`)) return;
    try {
      await api(`/api/bookmarks/${b.id}`, { method: 'DELETE' });
      $('edit-dialog').close();
      notifyList();
      showGone('已刪除這筆書籤');
    } catch (err) {
      setStatus($('edit-status'), err.message, 'error');
    }
  });
  $('edit-close').addEventListener('click', () => $('edit-dialog').close());

  // 分享圖：以 Canvas 自己畫，不用截圖套件。縮圖走同源的 /api/share/<id>/thumbnail，跨站圖片會汙染 Canvas 而無法匯出
  const W = 1080;
  const PAD = 64;
  const CARD_W = W - PAD * 2;
  const INNER = 56;
  const TEXT_W = CARD_W - INNER * 2;
  const C = { paper: '#f5f3ed', card: '#fffefa', navy: '#171e34', coral: '#ed735f', muted: '#707486', line: '#d4d2cc', field: '#bfc0c4', body: '#444a5c', gray: '#e9e7e0' };
  const SANS = 'Arial, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
  const segmenter = 'Segmenter' in Intl ? new Intl.Segmenter('zh-TW', { granularity: 'word' }) : null;

  /** 依寬度斷行：中文逐字、英文以單字為單位；超過 maxLines 時最後一行加刪節號 */
  function wrap(ctx, text, maxWidth, maxLines) {
    const source = text.replace(/\s+/g, ' ').trim();
    const pieces = (segmenter ? Array.from(segmenter.segment(source), (s) => s.segment) : Array.from(source))
      .flatMap((piece) => (ctx.measureText(piece).width > maxWidth ? Array.from(piece) : [piece]));
    const lines = [];
    let line = '';
    for (const piece of pieces) {
      if (line && ctx.measureText(line + piece).width > maxWidth) {
        lines.push(line.trimEnd());
        line = piece.trimStart();
      } else {
        line += piece;
      }
    }
    if (line) lines.push(line);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = Array.from(last).slice(0, -1).join('');
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth ? img : null);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  /** 標籤 chip 排成最多兩列，回傳每個 chip 的位置 */
  function layoutTags(ctx, tags) {
    ctx.font = `700 24px ${SANS}`;
    const chips = [];
    let x = 0;
    let row = 0;
    for (const tag of tags) {
      const label = `#${tag}`;
      const w = Math.min(ctx.measureText(label).width + 32, TEXT_W);
      if (x && x + w > TEXT_W) {
        row += 1;
        x = 0;
      }
      if (row > 1) break;
      chips.push({ label, x, row, w });
      x += w + 12;
    }
    return { chips, height: chips.length ? (chips[chips.length - 1].row + 1) * 62 - 12 : 0 };
  }

  async function drawShareImage(b) {
    const photo = b.thumbnail ? await loadImage(`/api/share/${encodeURIComponent(shareId)}/thumbnail`) : null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // 先量高度：有圖時圖在上方、標題較小；沒圖時改放網站首字圓章，標題放大
    const coverH = photo ? Math.round(CARD_W * 630 / 1200) : 0;
    const titleSize = photo ? 54 : 68;
    ctx.font = `900 ${titleSize}px ${SANS}`;
    const titleLines = wrap(ctx, b.title || b.url, TEXT_W, photo ? 3 : 4);
    ctx.font = `500 30px ${SANS}`;
    const summaryLines = b.summary ? wrap(ctx, b.summary, TEXT_W - 30, photo ? 4 : 7) : [];
    const tags = layoutTags(ctx, b.tags);

    const titleLH = Math.round(titleSize * 1.28);
    const blocks = [
      photo ? 0 : 128 + 40, // 首字圓章
      36 + 26, // eyebrow
      titleLines.length * titleLH,
      summaryLines.length ? 34 + summaryLines.length * 48 : 0,
      tags.height ? 34 + tags.height : 0,
      40 + 2 + 40 + 40 + INNER, // 分隔線、頁尾與卡片下緣留白
    ];
    const cardH = 14 + coverH + INNER + blocks.reduce((sum, n) => sum + n, 0);
    const H = PAD + cardH + PAD + 14;
    canvas.width = W;
    canvas.height = H;

    // 背景方格紙
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(23, 30, 52, .055)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 48) ctx.moveTo(x + 1, 0), ctx.lineTo(x + 1, H);
    for (let y = 0; y <= H; y += 48) ctx.moveTo(0, y + 1), ctx.lineTo(W, y + 1);
    ctx.stroke();

    // 卡片：陰影、底色、coral 頂邊
    const top = PAD;
    ctx.fillStyle = 'rgba(23, 30, 52, .12)';
    ctx.fillRect(PAD + 14, top + 14, CARD_W, cardH);
    ctx.fillStyle = C.card;
    ctx.fillRect(PAD, top, CARD_W, cardH);
    ctx.strokeStyle = C.line;
    ctx.strokeRect(PAD + 1, top + 1, CARD_W - 2, cardH - 2);
    ctx.fillStyle = C.coral;
    ctx.fillRect(PAD, top, CARD_W, 14);

    let y = top + 14;
    if (photo) {
      // object-fit: cover
      const scale = Math.max(CARD_W / photo.naturalWidth, coverH / photo.naturalHeight);
      const sw = CARD_W / scale;
      const sh = coverH / scale;
      ctx.drawImage(photo, (photo.naturalWidth - sw) / 2, (photo.naturalHeight - sh) / 2, sw, sh, PAD, y, CARD_W, coverH);
      ctx.fillStyle = C.line;
      ctx.fillRect(PAD, y + coverH - 2, CARD_W, 2);
      y += coverH;
    }
    y += INNER;
    const left = PAD + INNER;
    ctx.textBaseline = 'top';

    if (!photo) {
      ctx.fillStyle = 'rgba(23, 30, 52, .14)';
      ctx.beginPath();
      ctx.arc(left + 64 + 8, y + 64 + 8, 64, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.coral;
      ctx.beginPath();
      ctx.arc(left + 64, y + 64, 64, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 60px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(monogram(b), left + 64, y + 68);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = C.muted;
      ctx.font = `700 28px ${SANS}`;
      ctx.fillText(b.host, left + 128 + 28, y + 50);
      y += 128 + 40;
    }

    ctx.fillStyle = C.coral;
    ctx.font = '800 26px monospace';
    const eyebrow = [b.site, b.category].filter(Boolean).join(' · ').toUpperCase();
    ctx.fillText(wrap(ctx, eyebrow, TEXT_W, 1)[0] || '', left, y);
    y += 36 + 26;

    ctx.fillStyle = C.navy;
    ctx.font = `900 ${titleSize}px ${SANS}`;
    for (const line of titleLines) {
      ctx.fillText(line, left, y + (titleLH - titleSize) / 2);
      y += titleLH;
    }

    if (summaryLines.length) {
      y += 34;
      ctx.fillStyle = C.coral;
      ctx.fillRect(left, y, 8, summaryLines.length * 48 - 6);
      ctx.fillStyle = C.body;
      ctx.font = `500 30px ${SANS}`;
      summaryLines.forEach((line, i) => ctx.fillText(line, left + 30, y + i * 48 + 6));
      y += summaryLines.length * 48;
    }

    if (tags.height) {
      y += 34;
      ctx.font = `700 24px ${SANS}`;
      for (const chip of tags.chips) {
        const cx = left + chip.x;
        const cy = y + chip.row * 62;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx, cy, chip.w, 50);
        ctx.strokeStyle = C.field;
        ctx.strokeRect(cx + 1, cy + 1, chip.w - 2, 48);
        ctx.fillStyle = C.navy;
        ctx.fillText(wrap(ctx, chip.label, chip.w - 32, 1)[0], cx + 16, cy + 12);
      }
      y += tags.height;
    }

    // 頁尾：站名與網址網域
    y += 40;
    ctx.fillStyle = C.navy;
    ctx.fillRect(left, y, TEXT_W, 2);
    y += 2 + 40;
    drawBrandMark(ctx, left + 20, y + 20, 20);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.navy;
    ctx.font = `800 22px ${SANS}`;
    ctx.fillText('書籤收藏櫃', left + 56, y + 21);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.muted;
    ctx.fillText(wrap(ctx, b.host, TEXT_W - 320, 1)[0] || '', left + TEXT_W, y + 21);
    ctx.textAlign = 'left';

    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('無法產生圖片'))), 'image/png'));
  }

  // 品牌書櫃圖樣：座標與 public/favicon.svg、scripts/generate-icons.py 同一套 32 格系統
  const BOOKS = [[10, 9.5, 2, 6], [12.5, 10.5, 2.5, 5], [15.5, 9, 2, 6.5], [18, 10.5, 2, 5], [20.5, 9.5, 1.5, 6],
    [10, 18.5, 2.5, 6], [13, 19.5, 2, 5], [15.5, 18, 2, 6.5], [18, 19, 2.5, 5.5], [21, 18.5, 1, 6]];
  function drawBrandMark(ctx, cx, cy, r) {
    const u = r / 16;
    const ox = cx - 16 * u;
    const oy = cy - 16 * u;
    const box = (x, y, w, h, fill) => {
      ctx.fillStyle = fill;
      ctx.fillRect(ox + x * u, oy + y * u, w * u, h * u);
    };
    ctx.fillStyle = C.coral;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    box(7.5, 6.5, 17, 20, '#ffffff');
    box(9, 8, 14, 7.5, C.coral);
    box(9, 17, 14, 7.5, C.coral);
    for (const [x, y, w, h] of BOOKS) box(x, y, w, h, '#ffffff');
  }

  function fileName(b) {
    const base = (b.title || b.host || 'bookmark').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
    return `${base || 'bookmark'}.png`;
  }

  async function prepareImage() {
    const preview = $('share-preview');
    const save = $('share-save');
    if (state.image) return;
    save.hidden = true;
    $('share-image').hidden = true;
    preview.replaceChildren(h('p', { class: 'empty' }, '產生中…'));
    try {
      const blob = await drawShareImage(state.bookmark);
      const file = new File([blob], fileName(state.bookmark), { type: 'image/png' });
      state.image = { file, url: URL.createObjectURL(blob) };
      preview.replaceChildren(h('img', { src: state.image.url, alt: `「${state.bookmark.title}」的分享圖` }));
      save.href = state.image.url;
      save.download = file.name;
      save.hidden = false;
      $('share-image').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    } catch (err) {
      preview.replaceChildren(h('p', { class: 'empty' }, `無法產生分享圖：${err.message}`));
    }
  }

  $('share').addEventListener('click', () => {
    $('share-url').value = shareUrl;
    $('share-link').hidden = !navigator.share;
    setStatus($('share-status'), '');
    $('share-dialog').showModal();
    prepareImage();
  });

  $('share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // 非 HTTPS 或權限被擋時，退回選取後複製
      $('share-url').select();
      document.execCommand('copy');
    }
    setStatus($('share-status'), '已複製網址', 'ok');
  });

  // 使用者取消分享時會丟 AbortError，不當成錯誤
  async function nativeShare(data) {
    try {
      await navigator.share(data);
    } catch (err) {
      if (err.name !== 'AbortError') setStatus($('share-status'), `無法分享：${err.message}`, 'error');
    }
  }
  $('share-link').addEventListener('click', () => nativeShare({ title: state.bookmark.title, url: shareUrl }));
  $('share-image').addEventListener('click', () => nativeShare({ files: [state.image.file], title: state.bookmark.title }));
  $('share-close').addEventListener('click', () => $('share-dialog').close());

  load();
})();
