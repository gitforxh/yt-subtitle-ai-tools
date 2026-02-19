async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(obj) {
  return chrome.storage.local.set(obj);
}

async function getBridgeConfig() {
  const data = await getStorage(['bridgeConfig']);
  return data.bridgeConfig || null;
}

const inflightExplainRequests = new Map();

function mergeGrammarIntoItems(parsed) {
  let items = Array.isArray(parsed?.items) ? parsed.items : [];
  const grammar = Array.isArray(parsed?.grammar) ? parsed.grammar : [];
  if (grammar.length) {
    items = [...items, { word: '— Grammar —', reading: '', partOfSpeech: '', meaning: '' }];
    for (const g of grammar) {
      const pattern = String(g?.pattern || '').trim();
      const explanation = String(g?.explanation || '').trim();
      const example = String(g?.example || '').trim();
      items.push({
        word: pattern,
        reading: 'grammar',
        partOfSpeech: 'pattern',
        meaning: `${explanation}${example ? ` Example: ${example}` : ''}`.trim()
      });
    }
  }
  return items;
}

function extractFirstJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

async function callExplainViaOpenClaw(cfg, text, rid, controller) {
  const helperUrl = (cfg?.helperUrl || 'http://127.0.0.1:18794').replace(/\/$/, '');
  const sessionKey = cfg?.sessionKey || 'ext-transcript';
  const userLanguage = (cfg?.userLanguage || 'en').trim();

  inflightExplainRequests.set(rid, { controller, helperUrl, provider: 'openclaw' });

  const res = await fetch(`${helperUrl}/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionKey, userLanguage, requestId: rid }),
    signal: controller.signal
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Helper failed: ${res.status} ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data?.ok) throw new Error(data?.error || 'Helper error');
  return Array.isArray(data.items) ? data.items : [];
}

async function callExplainViaOpenAI(cfg, text, rid, controller) {
  const apiKey = String(cfg?.openaiApiKey || '').trim();
  if (!apiKey) throw new Error('Missing OpenAI API key in settings');

  const model = String(cfg?.openaiModel || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const userLanguage = String(cfg?.userLanguage || 'en').trim() || 'en';
  inflightExplainRequests.set(rid, { controller, provider: 'openai' });

  const prompt = `Task: Explain ONLY the selected text between <text> tags. Treat this as standalone with no prior context. Write meaning/explanation/example in user language (${userLanguage}). Return JSON only with shape: {"requestId":"${rid}","items":[{"word":"...","reading":"...","partOfSpeech":"...","meaning":"..."}],"grammar":[{"pattern":"...","explanation":"...","example":"..."}]}\n\n<text>${text}</text>`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Return strict JSON only. No markdown.' },
        { role: 'user', content: prompt }
      ]
    }),
    signal: controller.signal
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status} ${raw.slice(0, 220)}`);

  const payload = extractFirstJsonObject((() => {
    try {
      const obj = JSON.parse(raw);
      return obj?.choices?.[0]?.message?.content || '';
    } catch (_) {
      return raw;
    }
  })());

  if (!payload || String(payload.requestId || '').trim() !== rid) {
    throw new Error('OpenAI response invalid or requestId mismatch');
  }

  return mergeGrammarIntoItems(payload);
}

async function callExplainViaGemini(cfg, text, rid, controller) {
  const apiKey = String(cfg?.geminiApiKey || '').trim();
  if (!apiKey) throw new Error('Missing Gemini API key in settings');

  const model = String(cfg?.geminiModel || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash';
  const userLanguage = String(cfg?.userLanguage || 'en').trim() || 'en';
  inflightExplainRequests.set(rid, { controller, provider: 'gemini' });

  const prompt = `Task: Explain ONLY the selected text between <text> tags. Treat this as standalone with no prior context. Write meaning/explanation/example in user language (${userLanguage}). Return JSON only with shape: {"requestId":"${rid}","items":[{"word":"...","reading":"...","partOfSpeech":"...","meaning":"..."}],"grammar":[{"pattern":"...","explanation":"...","example":"..."}]}\n\n<text>${text}</text>`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
      },
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }]
    }),
    signal: controller.signal
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`Gemini failed: ${res.status} ${raw.slice(0, 220)}`);

  const payload = extractFirstJsonObject((() => {
    try {
      const obj = JSON.parse(raw);
      const txt = obj?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('\n') || '';
      return txt;
    } catch (_) {
      return raw;
    }
  })());

  if (!payload || String(payload.requestId || '').trim() !== rid) {
    throw new Error('Gemini response invalid or requestId mismatch');
  }

  return mergeGrammarIntoItems(payload);
}

async function callExplain(text, requestId) {
  const cfg = await getBridgeConfig();
  const provider = (cfg?.aiProvider || 'openclaw').toLowerCase();
  const rid = String(requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const controller = new AbortController();

  try {
    if (provider === 'openai') {
      return await callExplainViaOpenAI(cfg, text, rid, controller);
    }
    if (provider === 'gemini') {
      return await callExplainViaGemini(cfg, text, rid, controller);
    }
    return await callExplainViaOpenClaw(cfg, text, rid, controller);
  } finally {
    inflightExplainRequests.delete(rid);
  }
}

async function cancelExplain(requestId) {
  const rid = String(requestId || '').trim();
  if (!rid) return { ok: true };

  const current = inflightExplainRequests.get(rid);
  if (current?.controller) {
    try { current.controller.abort(); } catch (_) {}
  }

  if ((current?.provider || 'openclaw') === 'openclaw') {
    const cfg = await getBridgeConfig();
    const helperUrl = (current?.helperUrl || cfg?.helperUrl || 'http://127.0.0.1:18794').replace(/\/$/, '');
    try {
      await fetch(`${helperUrl}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: rid })
      });
    } catch (_) {
      // best effort
    }
  }

  inflightExplainRequests.delete(rid);
  return { ok: true };
}

async function testBridge(config) {
  const provider = (config?.aiProvider || 'openclaw').toLowerCase();

  if (provider === 'openai') {
    const apiKey = String(config?.openaiApiKey || '').trim();
    if (!apiKey) throw new Error('Missing OpenAI API key');
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) throw new Error(`OpenAI auth failed: ${res.status}`);
    await setStorage({ bridgeConfig: config, bridgeConnected: true });
    return true;
  }

  if (provider === 'gemini') {
    const apiKey = String(config?.geminiApiKey || '').trim();
    if (!apiKey) throw new Error('Missing Gemini API key');
    const model = String(config?.geminiModel || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gemini auth/model failed: ${res.status}`);
    await setStorage({ bridgeConfig: config, bridgeConnected: true });
    return true;
  }

  const helperUrl = (config?.helperUrl || 'http://127.0.0.1:18794').replace(/\/$/, '');
  const res = await fetch(`${helperUrl}/health`);
  if (!res.ok) throw new Error(`Bridge health failed: ${res.status}`);
  await setStorage({ bridgeConfig: config, bridgeConnected: true });
  return true;
}

function hasJapanese(text) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text || '');
}

function tokenizeQuery(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/[\s\n\t,.;:!?()\[\]{}"“”]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const deduped = [];
  const seen = new Set();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }
  return deduped;
}

const dictTokenCache = new Map();
const DICT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_LOOKUPS = 4;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 && i < attempts - 1) {
        const waitMs = 300 * Math.pow(2, i) + Math.floor(Math.random() * 120);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`Dictionary failed: ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const waitMs = 250 * Math.pow(2, i) + Math.floor(Math.random() * 100);
        await sleep(waitMs);
        continue;
      }
    }
  }
  throw lastErr || new Error('Dictionary request failed');
}

function getDictCacheKey(prefix, token) {
  return `${prefix}:${String(token || '').trim().toLowerCase()}`;
}

function getCachedDict(key) {
  const hit = dictTokenCache.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.ts) > DICT_CACHE_TTL_MS) {
    dictTokenCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCachedDict(key, value) {
  dictTokenCache.set(key, { ts: Date.now(), value });
}

async function lookupJapanese(token) {
  const cacheKey = getDictCacheKey('jp', token);
  const cached = getCachedDict(cacheKey);
  if (cached) return cached;

  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(token)}`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  const items = rows.slice(0, 4).map((r) => {
    const japanese = Array.isArray(r?.japanese) ? r.japanese[0] : null;
    const senses = Array.isArray(r?.senses) ? r.senses[0] : null;
    return {
      word: japanese?.word || japanese?.reading || token,
      reading: japanese?.reading || '',
      partOfSpeech: Array.isArray(senses?.parts_of_speech) ? senses.parts_of_speech.join(', ') : '',
      meaning: Array.isArray(senses?.english_definitions) ? senses.english_definitions.slice(0, 4).join('; ') : ''
    };
  }).filter(x => x.meaning || x.word);
  setCachedDict(cacheKey, items);
  return items;
}

async function lookupEnglish(token) {
  const cacheKey = getDictCacheKey('en', token);
  const cached = getCachedDict(cacheKey);
  if (cached) return cached;

  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(token)}`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : null;
  const meaning = Array.isArray(entry?.meanings) ? entry.meanings[0] : null;
  const def = Array.isArray(meaning?.definitions) ? meaning.definitions[0] : null;
  if (!entry) return [];
  const items = [{
    word: entry.word || token,
    reading: entry.phonetic || '',
    partOfSpeech: meaning?.partOfSpeech || '',
    meaning: def?.definition || ''
  }].filter(x => x.meaning || x.word);
  setCachedDict(cacheKey, items);
  return items;
}

async function callDictionary(text) {
  const q = String(text || '').trim();
  if (!q) return { items: [], groups: [] };

  const tokens = tokenizeQuery(q);
  const useTokens = tokens.length > 1 ? tokens : [q];

  const groups = [];
  for (let i = 0; i < useTokens.length; i += MAX_CONCURRENT_LOOKUPS) {
    const batch = useTokens.slice(i, i + MAX_CONCURRENT_LOOKUPS);
    const partial = await Promise.all(batch.map(async (token) => {
      try {
        const items = hasJapanese(token) ? await lookupJapanese(token) : await lookupEnglish(token);
        return { token, items };
      } catch (err) {
        return { token, items: [], error: err?.message || 'Lookup failed' };
      }
    }));
    groups.push(...partial);
  }

  const items = groups.flatMap(g => g.items || []);
  return { items, groups };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'bridge:connect') {
        await testBridge(msg.config || {});
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'bridge:status') {
        const data = await getStorage(['bridgeConnected', 'bridgeConfig']);
        const config = data.bridgeConfig || {};
        const provider = (config.aiProvider || 'openclaw').toLowerCase();

        if (provider === 'openai') {
          const connected = !!String(config.openaiApiKey || '').trim();
          sendResponse({ ok: true, connected, config });
          return;
        }

        if (provider === 'gemini') {
          const connected = !!String(config.geminiApiKey || '').trim();
          sendResponse({ ok: true, connected, config });
          return;
        }

        const helperUrl = (config.helperUrl || 'http://127.0.0.1:18794').replace(/\/$/, '');
        let connected = false;
        try {
          const r = await fetch(`${helperUrl}/health`);
          connected = !!r.ok;
        } catch (_) {
          connected = false;
        }
        sendResponse({ ok: true, connected, config });
        return;
      }
      if (msg?.type === 'dict:lookup') {
        const data = await callDictionary(msg.text || '');
        sendResponse({ ok: true, items: data.items || [], groups: data.groups || [] });
        return;
      }
      if (msg?.type === 'ai:explain') {
        const items = await callExplain(msg.text || '', msg.requestId || '');
        sendResponse({ ok: true, items });
        return;
      }
      if (msg?.type === 'ai:cancel') {
        await cancelExplain(msg.requestId || '');
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || 'Unexpected error' });
    }
  })();
  return true;
});
