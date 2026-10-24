'use strict';

// Passkey（WebAuthn）：伺服器給的 JSON 選項與瀏覽器的 ArrayBuffer 互轉。登入頁與設定頁共用。
// 不用 PublicKeyCredential.parseCreationOptionsFromJSON，舊一點的 Safari 沒有
window.Passkey = (() => {
  function toBuffer(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0)).buffer;
  }

  function toBase64Url(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const descriptors = (list) => (list || []).map((item) => ({ ...item, id: toBuffer(item.id) }));

  function supported() {
    return typeof window.PublicKeyCredential === 'function' && Boolean(navigator.credentials);
  }

  function common(credential) {
    return {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  async function create(options) {
    const credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: toBuffer(options.challenge),
        user: { ...options.user, id: toBuffer(options.user.id) },
        excludeCredentials: descriptors(options.excludeCredentials),
      },
    });
    const { response } = credential;
    return {
      ...common(credential),
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        attestationObject: toBase64Url(response.attestationObject),
        transports: response.getTransports ? response.getTransports() : [],
      },
    };
  }

  async function get(options) {
    const credential = await navigator.credentials.get({
      publicKey: { ...options, challenge: toBuffer(options.challenge), allowCredentials: descriptors(options.allowCredentials) },
    });
    const { response } = credential;
    return {
      ...common(credential),
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        authenticatorData: toBase64Url(response.authenticatorData),
        signature: toBase64Url(response.signature),
        userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
      },
    };
  }

  /** 瀏覽器丟出的錯誤轉成看得懂的說明；伺服器的錯誤訊息照原樣 */
  function message(err) {
    if (err.name === 'NotAllowedError') return '已取消，或這台裝置沒有可用的 Passkey';
    if (err.name === 'InvalidStateError') return '這個驗證器已經註冊過了';
    if (err.name === 'SecurityError') return '目前的網址不能使用 Passkey（需要 HTTPS 或 localhost）';
    return err.message;
  }

  return { supported, create, get, message };
})();
