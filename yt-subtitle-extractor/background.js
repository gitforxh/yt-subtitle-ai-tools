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

async function callExplain(text, requestId) {
  const cfg = await getBridgeConfig();
  const helperUrl = (cfg?.helperUrl || 'http://127.0.0.1:18794').replace(/\/$/, '');
  const sessionKey = cfg?.sessionKey || 'ext-transcript';
  const userLanguage = (cfg?.userLanguage || 'en').trim();

  const rid = String(requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const controller = new AbortController();
  inflightExplainRequests.set(rid, { controller, helperUrl });

  try {
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

  inflightExplainRequests.delete(rid);
  return { ok: true };
}

async function testBridge(config) {
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
        sendResponse({ ok: true, connected: !!data.bridgeConnected, config: data.bridgeConfig || null });
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
