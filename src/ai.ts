export interface AiInput {
  url: string;
  site: string;
  title: string;
  description: string;
  keywords: string[];
  text: string;
  categories: string[];
  tags: string[];
  instructions?: string;
}

export interface AiOutput {
  title: string;
  summary: string;
  category: string;
  tags: string[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    category: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'category', 'tags'],
};

const SYSTEM_PROMPT = `你是書籤整理助理。根據使用者提供的網頁資訊，只輸出 JSON 物件，欄位如下：
- title：簡潔標題，40 字內。原標題已清楚就沿用；去掉網站名稱後綴與多餘符號，專有名詞保留原文。
- summary：繁體中文摘要，2 到 3 句、120 字內，說明這個頁面是什麼、對讀者有什麼用。資訊不足時只寫能確定的部分，不要編造。
- category：一個大類名稱，2 到 4 字，例如：開發、AI、設計、工具、新聞、學習、影音、社群、商業、生活。優先從「既有分類」挑最接近的，都不適合才新增，不要用過細的主題當分類。
- tags：3 到 6 個標籤，以名詞為主，不加 #。優先沿用「既有標籤」，技術名詞保留原文。
- 一律使用台灣用語，例如：資料庫、軟體、網路、影片、程式、伺服器、資訊；不要用數據庫、軟件、網絡、視頻、程序、服務器、信息。`;

export function aiEnabled(env: Env): boolean {
  return Boolean(env.AI) && env.AI_ENABLED !== 'false';
}

function buildUserPrompt(input: AiInput): string {
  return [
    `網址：${input.url}`,
    `網站：${input.site}`,
    `原始標題：${input.title || '（無）'}`,
    `描述：${input.description || '（無）'}`,
    input.keywords.length ? `頁面關鍵字：${input.keywords.join('、')}` : '',
    `內文摘錄：${input.text.slice(0, 2_500) || '（無）'}`,
    `既有分類：${input.categories.join('、') || '（尚無）'}`,
    `既有標籤：${input.tags.join('、') || '（尚無）'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function parseOutput(raw: unknown): AiOutput {
  let value = raw;
  if (typeof value === 'string') {
    // 部分模型會包 ```json 區塊
    const match = value.match(/\{[\s\S]*\}/);
    value = JSON.parse(match ? match[0] : value);
  }
  const obj = (value ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    title: str(obj.title),
    summary: str(obj.summary),
    category: str(obj.category),
    tags: Array.isArray(obj.tags) ? obj.tags.map(str).filter(Boolean) : [],
  };
}

/** 用 Workers AI 產生標題、摘要、分類與標籤。失敗時丟出錯誤，由呼叫端退回規則結果 */
export async function aiEnrich(env: Env, input: AiInput): Promise<AiOutput> {
  const system = input.instructions ? `${SYSTEM_PROMPT}\n\n額外規則：\n${input.instructions}` : SYSTEM_PROMPT;
  const result = await env.AI.run(env.AI_MODEL as keyof AiModels, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    max_tokens: 600,
    temperature: 0.2,
  });
  return parseOutput((result as { response?: unknown }).response);
}
