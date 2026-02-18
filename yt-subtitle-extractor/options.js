async function getStorage(keys) { return chrome.storage.local.get(keys); }
async function setStorage(obj) { return chrome.storage.local.set(obj); }

function setStatus(text, isError = false) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.style.color = isError ? '#b00020' : '#0a7f2e';
}

function toggleProviderSections(provider) {
  const isOpenAI = provider === 'openai';
  document.getElementById('openclawSection').classList.toggle('hidden', isOpenAI);
  document.getElementById('openaiSection').classList.toggle('hidden', !isOpenAI);
}

function ensureOpenAIModelOption(model) {
  const select = document.getElementById('openaiModel');
  if (!model) return;
  const exists = Array.from(select.options).some((opt) => opt.value === model);
  if (exists) return;

  const custom = document.createElement('option');
  custom.value = model;
  custom.textContent = `${model} (custom)`;
  select.appendChild(custom);
}

function readForm() {
  return {
    aiProvider: document.getElementById('aiProvider').value || 'openclaw',
    helperUrl: document.getElementById('helperUrl').value.trim() || 'http://127.0.0.1:18794',
    sessionKey: document.getElementById('sessionKey').value.trim() || 'ext-transcript',
    userLanguage: document.getElementById('userLanguage').value.trim() || 'en',
    openaiApiKey: document.getElementById('openaiApiKey').value.trim(),
    openaiModel: document.getElementById('openaiModel').value || 'gpt-4o-mini'
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
  ensureOpenAIModelOption(c.openaiModel);
  document.getElementById('openaiModel').value = c.openaiModel || 'gpt-4o-mini';

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
  setStatus(r.connected ? 'OpenClaw helper connected' : 'OpenClaw helper not connected', !r.connected);
}

document.getElementById('aiProvider').addEventListener('change', (e) => {
  toggleProviderSections(e.target.value);
});
document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('connectBtn').addEventListener('click', connect);
document.getElementById('checkBtn').addEventListener('click', check);

load();
