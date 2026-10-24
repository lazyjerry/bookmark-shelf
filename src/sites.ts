// 網域 → 網站分類名稱。比對時取最長的相符後綴，所以 gist.github.com 會先於 github.com
const SITES: Record<string, string> = {
  'github.com': 'GitHub',
  'gist.github.com': 'GitHub Gist',
  'github.io': 'GitHub Pages',
  'gitlab.com': 'GitLab',
  'threads.net': 'Threads',
  'threads.com': 'Threads',
  'instagram.com': 'Instagram',
  'facebook.com': 'Facebook',
  'fb.com': 'Facebook',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'x.com': 'X',
  'twitter.com': 'X',
  'linkedin.com': 'LinkedIn',
  'reddit.com': 'Reddit',
  'medium.com': 'Medium',
  'dev.to': 'DEV',
  'stackoverflow.com': 'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'npmjs.com': 'npm',
  'notion.so': 'Notion',
  'notion.site': 'Notion',
  'hackmd.io': 'HackMD',
  'wikipedia.org': 'Wikipedia',
  'ptt.cc': 'PTT',
  'dcard.tw': 'Dcard',
  'vocus.cc': '方格子',
  'bilibili.com': 'Bilibili',
  'figma.com': 'Figma',
  'dribbble.com': 'Dribbble',
  'behance.net': 'Behance',
  'huggingface.co': 'Hugging Face',
  'arxiv.org': 'arXiv',
};

/** 依網站給 AI 停用時的預設分類 */
const SITE_CATEGORY: Record<string, string> = {
  GitHub: '開發',
  'GitHub Gist': '開發',
  GitLab: '開發',
  'Stack Overflow': '開發',
  npm: '開發',
  DEV: '開發',
  'Hugging Face': 'AI',
  YouTube: '影音',
  Bilibili: '影音',
  Threads: '社群',
  Instagram: '社群',
  Facebook: '社群',
  X: '社群',
  Reddit: '社群',
  PTT: '社群',
  Dcard: '社群',
  Figma: '設計',
  Dribbble: '設計',
  Behance: '設計',
  arXiv: '研究',
};

export function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

export function siteOf(url: URL): string {
  const host = hostOf(url);
  let best = '';
  for (const domain of Object.keys(SITES)) {
    if ((host === domain || host.endsWith('.' + domain)) && domain.length > best.length) best = domain;
  }
  return best ? SITES[best] : host;
}

export function defaultCategoryOf(site: string): string {
  return SITE_CATEGORY[site] ?? '未分類';
}
