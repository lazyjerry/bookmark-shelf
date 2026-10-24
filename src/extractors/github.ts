import { readTextCapped } from '../crawler';
import type { DomainExtractor } from './types';

// github.com 第一層不是使用者／組織的保留路徑
const RESERVED = new Set([
  'about', 'apps', 'codespaces', 'collections', 'enterprise', 'explore', 'features', 'issues', 'login',
  'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'search', 'settings', 'sponsors',
  'topics', 'trending', 'users',
]);

interface Repo {
  full_name: string;
  description: string | null;
  topics?: string[];
  stargazers_count: number;
  language: string | null;
  private: boolean;
  archived: boolean;
  pushed_at: string;
  license: { spdx_id: string } | null;
  owner: { avatar_url: string };
}

function stripMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|-]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * GitHub repository：改用 GitHub API 取描述、topics 與 README。
 * 設定 GITHUB_TOKEN（需 repo 讀取權限）後可讀 Private Repo。
 */
export const github: DomainExtractor = {
  name: 'GitHub',

  match(url) {
    const parts = url.pathname.split('/').filter(Boolean);
    return url.hostname === 'github.com' && parts.length === 2 && !RESERVED.has(parts[0].toLowerCase());
  },

  async extract({ url, env }) {
    const [owner, name] = url.pathname.split('/').filter(Boolean);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'BookmarkShelf',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

    const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers, signal: AbortSignal.timeout(8_000) });
    if (res.status === 404) {
      return {
        title: `${owner}/${name}`,
        category: '開發',
        warnings: [
          env.GITHUB_TOKEN
            ? 'GitHub API 找不到這個 repo，可能是 GITHUB_TOKEN 沒有存取權限'
            : 'GitHub API 讀不到這個 repo；若是 Private Repo，請設定 GITHUB_TOKEN',
        ],
      };
    }
    // 其他錯誤（例如未帶 token 時的 rate limit）交回通用爬蟲處理公開頁面
    if (!res.ok) return null;
    const repo = (await res.json()) as Repo;

    let readme = '';
    const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${name}/readme`, {
      headers: { ...headers, Accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(8_000),
    });
    if (readmeRes.ok) readme = stripMarkdown(await readTextCapped(readmeRes, 60_000)).slice(0, 4_000);
    else await readmeRes.body?.cancel();

    const instructions = [
      '這是 GitHub repository。摘要說明它解決什麼問題、主要功能與使用的技術；README 不足時只根據描述，不要編造。',
    ];
    if (repo.private) instructions.push('這是 Private Repo，摘要開頭加上「〔私有 repo〕」。');

    return {
      title: repo.full_name,
      description: repo.description ?? '',
      // 私有 repo 沒有公開的社群預覽圖，改用擁有者頭像
      image: repo.private ? repo.owner.avatar_url : `https://opengraph.githubassets.com/1/${repo.full_name}`,
      favicon: 'https://github.com/favicon.ico',
      text: readme,
      tags: repo.topics ?? [],
      category: '開發',
      aiInstructions: instructions.join('\n'),
      extra: {
        stars: repo.stargazers_count,
        language: repo.language,
        license: repo.license?.spdx_id ?? null,
        private: repo.private,
        archived: repo.archived,
        pushed_at: repo.pushed_at,
      },
    };
  },
};
