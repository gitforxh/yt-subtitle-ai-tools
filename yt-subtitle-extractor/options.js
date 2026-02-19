async function getStorage(keys) { return chrome.storage.local.get(keys); }
async function setStorage(obj) { return chrome.storage.local.set(obj); }

function setStatus(text, isError = false) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.style.color = isError ? '#b00020' : '#0a7f2e';
}

function toggleProviderSections(provider) {
  const isOpenAI = provider === 'openai';
  const isGemini = provider === 'gemini';
  document.getElementById('openclawSection').classList.toggle('hidden', isOpenAI || isGemini);
  document.getElementById('openaiSection').classList.toggle('hidden', !isOpenAI);
  document.getElementById('geminiSection').classList.toggle('hidden', !isGemini);
}

function setCustomModelVisibility(rowId, visible) {
  document.getElementById(rowId).classList.toggle('hidden', !visible);
}

function applyModelToForm({ model, selectId, customInputId, customRowId, fallbackModel }) {
  const select = document.getElementById(selectId);
  const customInput = document.getElementById(customInputId);
  const value = (model || '').trim();

  if (!value) {
    select.value = fallbackModel;
    customInput.value = '';
    setCustomModelVisibility(customRowId, false);
    return;
  }

  const preset = Array.from(select.options).find((opt) => opt.value === value && opt.value !== '__custom__');
  if (preset) {
    select.value = value;
    customInput.value = '';
    setCustomModelVisibility(customRowId, false);
    return;
  }

  select.value = '__custom__';
  customInput.value = value;
  setCustomModelVisibility(customRowId, true);
}

function getSelectedModel({ selectId, customInputId, fallbackModel }) {
  const selectValue = document.getElementById(selectId).value;
  if (selectValue === '__custom__') {
    return document.getElementById(customInputId).value.trim() || fallbackModel;
  }
  return selectValue || fallbackModel;
}

function normalizeGeminiModelName(name) {
  return String(name || '').replace(/^models\//, '').trim();
}

function isLikelyNewerGemini(a, b) {
  const pa = normalizeGeminiModelName(a).match(/^gemini-(\d+(?:\.\d+)?)(?:-(.*))?$/i);
  const pb = normalizeGeminiModelName(b).match(/^gemini-(\d+(?:\.\d+)?)(?:-(.*))?$/i);
  if (!pa || !pb) return normalizeGeminiModelName(a).localeCompare(normalizeGeminiModelName(b));

  const va = Number(pa[1]);
  const vb = Number(pb[1]);
  if (va !== vb) return vb - va;

  const ra = (pa[2] || '').toLowerCase();
  const rb = (pb[2] || '').toLowerCase();
  const rank = (s) => {
    if (s.includes('pro')) return 0;
    if (s.includes('flash') && s.includes('lite')) return 2;
    if (s.includes('flash')) return 1;
    return 3;
  };
  const diff = rank(ra) - rank(rb);
  if (diff) return diff;
  return normalizeGeminiModelName(a).localeCompare(normalizeGeminiModelName(b));
}

function setGeminiModelOptions(modelIds, preferredModel) {
  const select = document.getElementById('geminiModel');
  const models = Array.from(new Set((modelIds || []).map(normalizeGeminiModelName).filter(Boolean))).sort(isLikelyNewerGemini);

  const current = String(preferredModel || getSelectedModel({
    selectId: 'geminiModel',
    customInputId: 'geminiModelCustom',
    fallbackModel: 'gemini-3-flash'
  }) || '').trim();

  select.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Custom…';
  select.appendChild(custom);

  applyModelToForm({
    model: current,
    selectId: 'geminiModel',
    customInputId: 'geminiModelCustom',
    customRowId: 'geminiModelCustomRow',
    fallbackModel: models[0] || 'gemini-3-flash'
  });
}

async function refreshGeminiModels() {
  const apiKey = document.getElementById('geminiApiKey').value.trim();
  if (!apiKey) {
    setStatus('Enter Gemini API key first, then refresh models.', true);
    return;
  }

  const btn = document.getElementById('refreshGeminiModelsBtn');
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = 'Refreshing...';

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const raw = await res.text();
    if (!res.ok) throw new Error(`ListModels failed: ${res.status} ${raw.slice(0, 180)}`);

    const obj = JSON.parse(raw);
    const models = Array.isArray(obj?.models) ? obj.models : [];
    const ids = models
      .filter((m) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => m?.name)
      .filter(Boolean);

    if (!ids.length) throw new Error('No generateContent models returned by Google for this key/project.');

    setGeminiModelOptions(ids);
    await setStorage({ bridgeConfig: readForm() });
    setStatus(`Gemini models refreshed (${ids.length} found)`);
  } catch (err) {
    setStatus(err?.message || 'Failed to refresh Gemini models', true);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function readForm() {
  const geminiModelsList = Array.from(document.getElementById('geminiModel').options)
    .map((o) => o.value)
    .filter((v) => v && v !== '__custom__');

  return {
    aiProvider: document.getElementById('aiProvider').value || 'openclaw',
    helperUrl: document.getElementById('helperUrl').value.trim() || 'http://127.0.0.1:18794',
    sessionKey: document.getElementById('sessionKey').value.trim() || 'ext-transcript',
    userLanguage: document.getElementById('userLanguage').value.trim() || 'en',
    openaiApiKey: document.getElementById('openaiApiKey').value.trim(),
    openaiModel: getSelectedModel({ selectId: 'openaiModel', customInputId: 'openaiModelCustom', fallbackModel: 'gpt-4o-mini' }),
    geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
    geminiModel: getSelectedModel({ selectId: 'geminiModel', customInputId: 'geminiModelCustom', fallbackModel: 'gemini-3-flash' }),
    geminiModelsList
  };
}

async function load() {
  const data = await getStorage(['bridgeConfig']);
  const c = data.bridgeConfig || {};

  document.getElementById('aiProvider').value = c.aiProvider || 'openclaw';
  document.getElementById('helperUrl').value = c.helperUrl || 'http://127.0.0.1:18794';
  document.getElementById('sessionKey').value = c.sessionKey || 'ext-transcript';
  document.getElementById('userLanguage').value = c.userLanguage || 'en';
  document.getElementById('openaiApiKey').value = c.openaiApiKey || '';
  applyModelToForm({
    model: c.openaiModel || 'gpt-4o-mini',
    selectId: 'openaiModel',
    customInputId: 'openaiModelCustom',
    customRowId: 'openaiModelCustomRow',
    fallbackModel: 'gpt-4o-mini'
  });
  document.getElementById('geminiApiKey').value = c.geminiApiKey || '';
  applyModelToForm({
    model: c.geminiModel || 'gemini-3-flash',
    selectId: 'geminiModel',
    customInputId: 'geminiModelCustom',
    customRowId: 'geminiModelCustomRow',
    fallbackModel: 'gemini-3-flash'
  });
  if (Array.isArray(c.geminiModelsList) && c.geminiModelsList.length) {
    setGeminiModelOptions(c.geminiModelsList, c.geminiModel || '');
  }

  toggleProviderSections(document.getElementById('aiProvider').value);
}

async function save() {
  await setStorage({ bridgeConfig: readForm() });
  setStatus('Saved');
}

async function connect() {
  const config = readForm();
  await setStorage({ bridgeConfig: config });
  const r = await chrome.runtime.sendMessage({ type: 'bridge:connect', config });
  if (!r?.ok) return setStatus(r?.error || 'Connect failed', true);
  setStatus(`Connected (${config.aiProvider || 'openclaw'})`);
}

async function check() {
  const r = await chrome.runtime.sendMessage({ type: 'bridge:status' });
  if (!r?.ok) return setStatus(r?.error || 'Check failed', true);
  const provider = r.config?.aiProvider || 'openclaw';
  if (provider === 'openai') {
    return setStatus(r.connected ? 'OpenAI config looks valid' : 'OpenAI not configured', !r.connected);
  }
  if (provider === 'gemini') {
    return setStatus(r.connected ? 'Gemini config looks valid' : 'Gemini not configured', !r.connected);
  }
  setStatus(r.connected ? 'OpenClaw helper connected' : 'OpenClaw helper not connected', !r.connected);
}

document.getElementById('aiProvider').addEventListener('change', (e) => {
  toggleProviderSections(e.target.value);
});
document.getElementById('openaiModel').addEventListener('change', (e) => {
  const isCustom = e.target.value === '__custom__';
  setCustomModelVisibility('openaiModelCustomRow', isCustom);
  if (!isCustom) {
    document.getElementById('openaiModelCustom').value = '';
  }
});
document.getElementById('geminiModel').addEventListener('change', (e) => {
  const isCustom = e.target.value === '__custom__';
  setCustomModelVisibility('geminiModelCustomRow', isCustom);
  if (!isCustom) {
    document.getElementById('geminiModelCustom').value = '';
  }
});
document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('connectBtn').addEventListener('click', connect);
document.getElementById('checkBtn').addEventListener('click', check);
document.getElementById('refreshGeminiModelsBtn').addEventListener('click', refreshGeminiModels);

load();
