async function getStorage(keys){return chrome.storage.local.get(keys)}
async function setStorage(obj){return chrome.storage.local.set(obj)}
function setStatus(t,e=false){const n=document.getElementById('status');n.textContent=t;n.style.color=e?'#b00020':'#0a7f2e'}
function readForm(){return{helperUrl:document.getElementById('helperUrl').value.trim()||'http://127.0.0.1:18794',sessionKey:document.getElementById('sessionKey').value.trim()||'ext-transcript',userLanguage:document.getElementById('userLanguage').value.trim()||'en'}}
async function load(){const d=await getStorage(['bridgeConfig']);const c=d.bridgeConfig||{};document.getElementById('helperUrl').value=c.helperUrl||'http://127.0.0.1:18794';document.getElementById('sessionKey').value=c.sessionKey||'ext-transcript';document.getElementById('userLanguage').value=c.userLanguage||'en'}
async function save(){await setStorage({bridgeConfig:readForm()});setStatus('Saved')}
async function connect(){const config=readForm();await setStorage({bridgeConfig:config});const r=await chrome.runtime.sendMessage({type:'bridge:connect',config});if(!r?.ok)return setStatus(r?.error||'Connect failed',true);setStatus('Connected')}
async function check(){const r=await chrome.runtime.sendMessage({type:'bridge:status'});if(!r?.ok)return setStatus(r?.error||'Check failed',true);setStatus(r.connected?'Connected':'Not connected',!r.connected)}
document.getElementById('saveBtn').addEventListener('click',save)
document.getElementById('connectBtn').addEventListener('click',connect)
document.getElementById('checkBtn').addEventListener('click',check)
load()
