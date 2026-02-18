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

async function callExplain(text) {
  const cfg = await getBridgeConfig();
  const helperUrl = (cfg?.helperUrl || 'http://127.0.0.1:18794').replace(/\/$/, '');
  const sessionKey = cfg?.sessionKey || 'ext-transcript';
  const userLanguage = (cfg?.userLanguage || 'en').trim();

  const res = await fetch(`${helperUrl}/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionKey, userLanguage })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Helper failed: ${res.status} ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data?.ok) throw new Error(data?.error || 'Helper error');
  return Array.isArray(data.items) ? data.items : [];
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

async function callDictionary(text) {
  const q = String(text || '').trim();
  if (!q) return [];

  if (hasJapanese(q)) {
    const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Dictionary failed: ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.slice(0, 5).map((r) => {
      const japanese = Array.isArray(r?.japanese) ? r.japanese[0] : null;
      const senses = Array.isArray(r?.senses) ? r.senses[0] : null;
      return {
        word: japanese?.word || japanese?.reading || q,
        reading: japanese?.reading || '',
        partOfSpeech: Array.isArray(senses?.parts_of_speech) ? senses.parts_of_speech.join(', ') : '',
        meaning: Array.isArray(senses?.english_definitions) ? senses.english_definitions.slice(0, 4).join('; ') : ''
      };
    }).filter(x => x.meaning || x.word);
  }

  const oneWord = q.split(/\s+/)[0];
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(oneWord)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dictionary failed: ${res.status}`);
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : null;
  const meaning = Array.isArray(entry?.meanings) ? entry.meanings[0] : null;
  const def = Array.isArray(meaning?.definitions) ? meaning.definitions[0] : null;
  if (!entry) return [];
  const item = {
    word: entry.word || oneWord,
    reading: entry.phonetic || '',
    partOfSpeech: meaning?.partOfSpeech || '',
    meaning: def?.definition || ''
  };
  return [item].filter(x => x.meaning || x.word);
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
        const items = await callDictionary(msg.text || '');
        sendResponse({ ok: true, items });
        return;
      }
      if (msg?.type === 'ai:explain') {
        const items = await callExplain(msg.text || '');
        sendResponse({ ok: true, items });
        return;
      }
      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || 'Unexpected error' });
    }
  })();
  return true;
});
