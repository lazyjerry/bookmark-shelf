// 新增書籤時寄通知信。走 Email Routing 的 send_email binding：只能寄給帳號裡已驗證的收件地址，寄件地址需在啟用 Email Routing 的網域下
import { getSettings, putSettings } from './settings';
import type { Bookmark } from './types';

export const MAX_RECIPIENTS = 10;

const EMAIL_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export interface MailSettings {
  from: string;
  to: string[];
}

export interface MailResult {
  to: string;
  status: string;
}

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

export async function loadMailSettings(db: D1Database): Promise<MailSettings> {
  const stored = await getSettings(db, ['mail_from', 'mail_to']);
  return { from: stored.mail_from ?? '', to: stored.mail_to ? stored.mail_to.split(',') : [] };
}

export async function saveMailSettings(db: D1Database, mail: MailSettings): Promise<void> {
  await putSettings(db, { mail_from: mail.from, mail_to: mail.to.join(',') });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function compose(bookmark: Bookmark, appUrl: string, test: boolean) {
  const subject = `${test ? '[測試] ' : ''}新增書籤：${bookmark.title}`.slice(0, 200);
  const meta = [bookmark.site, bookmark.category, bookmark.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join(' · ');
  const intro = test ? '這是書籤收藏櫃的測試信，內容為最新一筆書籤。' : '書籤收藏櫃新增了一筆書籤。';

  const text = [
    intro,
    '',
    bookmark.title,
    bookmark.url,
    meta,
    '',
    bookmark.summary,
    bookmark.note ? `\n備註：${bookmark.note}` : '',
    '',
    `開啟書籤收藏櫃：${appUrl}`,
  ].join('\n');

  // 版面比照網站的書籤卡（public/app.css）：紙色底、coral 頂邊卡片、等寬字 eyebrow 與 badge。信件不吃 class 與 CSS 變數，樣式一律 inline、用 table 排版
  const e = escapeHtml;
  const font = `Arial,'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif`;
  const mono = `font-family:Menlo,Consolas,monospace`;
  const eyebrow = (label: string) => `<p style="margin:0 0 10px;color:#ed735f;${mono};font-size:11px;font-weight:800;letter-spacing:.22em">${label}</p>`;
  const badge = (label: string, plain = false) =>
    `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 8px;${plain ? 'color:#555a6d;background:#e9e7e0' : 'color:#ffffff;background:#ed735f'};${mono};font-size:11px;font-weight:800;line-height:1.2;letter-spacing:.04em">${e(label)}</span>`;
  const chip = (tag: string) =>
    `<span style="display:inline-block;margin:0 8px 8px 0;padding:5px 10px;color:#171e34;background:#ffffff;border:1px solid #bfc0c4;font-size:13px;font-weight:700">#${e(tag)}</span>`;
  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${e(href)}" style="display:inline-block;margin:0 10px 10px 0;padding:13px 20px;${primary ? 'color:#ffffff;background:#171e34;border:1px solid #171e34' : 'color:#171e34;background:#ffffff;border:1px solid #bfc0c4'};font-size:14px;font-weight:800;text-decoration:none">${label}</a>`;

  const html = `<!doctype html>
<html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f3ed;color:#171e34;font-family:${font}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(bookmark.summary.slice(0, 120))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f3ed"><tr><td align="center" style="padding:28px 16px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td style="padding:0 0 14px;border-bottom:1px solid #d4d2cc">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="color:#171e34;font-size:14px;font-weight:800;letter-spacing:.1em"><img src="${e(appUrl)}/icons/brand-mark.png" alt="" width="30" height="30" style="display:inline-block;width:30px;height:30px;margin-right:10px;vertical-align:middle;border:0">書籤收藏櫃</td>
    <td align="right" style="color:#707486;${mono};font-size:10px;font-weight:700;letter-spacing:.12em"><span style="display:inline-block;width:8px;height:8px;margin-right:6px;background:${test ? '#ae7418' : '#398a70'};border-radius:50%"></span>${test ? 'TEST MAIL' : 'NEW BOOKMARK'}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:24px 0 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fffefa;border:1px solid #d4d2cc;border-top:7px solid #ed735f;box-shadow:7px 7px 0 rgba(23,30,52,.12)"><tr><td style="padding:28px">
    <p style="margin:0 0 22px;color:#707486;font-size:14px;line-height:1.6">${e(intro)}</p>
    ${bookmark.thumbnail ? `<a href="${e(bookmark.url)}" style="display:block;margin:0 0 22px;text-decoration:none"><img src="${e(bookmark.thumbnail)}" alt="" width="542" style="display:block;width:100%;max-width:542px;height:auto;border:1px solid #d4d2cc;background:#e9e7e0"></a>` : ''}
    <div style="margin:0 0 8px">${badge(bookmark.site || bookmark.host)}${bookmark.category ? badge(bookmark.category, true) : ''}</div>
    ${eyebrow('TITLE · 標題')}
    <h1 style="margin:0 0 10px;color:#171e34;font-size:28px;font-weight:900;line-height:1.3;letter-spacing:-.02em;overflow-wrap:anywhere"><a href="${e(bookmark.url)}" style="color:#171e34;text-decoration:none">${e(bookmark.title || bookmark.url)}</a></h1>
    <p style="margin:0 0 24px;color:#707486;${mono};font-size:12px;line-height:1.5;word-break:break-all"><a href="${e(bookmark.url)}" style="color:#707486;text-decoration:none">${e(bookmark.url)}</a></p>
    ${bookmark.summary ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="padding:18px 20px;background:#f8f7f2;border:1px solid #d4d2cc;border-left:5px solid #ed735f">
      ${eyebrow('SUMMARY · 摘要')}
      <p style="margin:0;color:#171e34;font-size:16px;line-height:1.85;white-space:pre-wrap">${e(bookmark.summary)}</p>
    </td></tr></table>` : ''}
    ${bookmark.note ? `<p style="margin:0 0 20px;padding:10px 12px;color:#555a6d;background:#faf6ea;border-left:3px solid #ae7418;font-size:13px;line-height:1.6;white-space:pre-wrap">備註：${e(bookmark.note)}</p>` : ''}
    ${bookmark.tags.length ? `<div style="margin:0 0 14px">${bookmark.tags.map(chip).join('')}</div>` : ''}
    <div style="margin:8px 0 0">${button(bookmark.url, '開啟網頁', true)}${button(appUrl, '開啟書籤收藏櫃', false)}</div>
  </td></tr></table>
</td></tr>
<tr><td style="padding:36px 0 0"><div style="padding:18px 0 0;border-top:2px solid #171e34;color:#707486;${mono};font-size:10px;line-height:1.7;letter-spacing:.08em">書籤收藏櫃 · CLOUDFLARE WORKERS · D1 · WORKERS AI<br>你的信箱在書籤收藏櫃的通知信收件人清單中，所以收到這封信。</div></td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}

/** 逐一寄給每個收件地址，某個地址未驗證不影響其他人。回傳每個地址的結果 */
export async function sendBookmarkMail(env: Env, bookmark: Bookmark, appUrl: string, test = false): Promise<MailResult[]> {
  const mail = await loadMailSettings(env.DB);
  if (!mail.from || !mail.to.length) return [];
  const message = compose(bookmark, appUrl, test);
  return Promise.all(
    mail.to.map(async (to) => {
      try {
        const { messageId } = await env.EMAIL.send({ from: { email: mail.from, name: '書籤收藏櫃' }, to, ...message });
        return { to, status: `OK ${messageId}` };
      } catch (err) {
        const code = (err as { code?: string }).code;
        return { to, status: `ERROR ${code ? `${code} ` : ''}${err instanceof Error ? err.message : String(err)}` };
      }
    }),
  );
}
