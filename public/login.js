'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const status = $('login-status');

  // 只接受站內網址，避免 ?next= 被拿來導到其他網站
  function nextUrl() {
    const url = new URL(new URLSearchParams(location.search).get('next') || '/', location.origin);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : '/';
  }

  function show(message, kind = '') {
    status.className = kind;
    status.textContent = message;
  }

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `請求失敗（HTTP ${res.status}）`);
    return data;
  }

  // replace：登入頁不留在瀏覽紀錄裡，PWA 按返回不會回到這裡
  function done() {
    show('已登入，正在開啟…', 'ok');
    location.replace(nextUrl());
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('login-form').querySelector('button');
    button.disabled = true;
    try {
      await post('/api/auth/login', { username: $('login-user').value, password: $('login-pass').value });
      done();
    } catch (err) {
      show(err.message, 'error');
      $('login-pass').select();
    } finally {
      button.disabled = false;
    }
  });

  if (window.Passkey && window.Passkey.supported()) {
    $('passkey-panel').hidden = false;
    $('passkey-login').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const options = await post('/api/auth/passkey/options', {});
        const response = await window.Passkey.get(options);
        await post('/api/auth/passkey', { response });
        done();
      } catch (err) {
        show(window.Passkey.message(err), 'error');
      } finally {
        button.disabled = false;
      }
    });
  }
})();
