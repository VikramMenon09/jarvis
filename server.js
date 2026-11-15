// Jarvis: a local, always-on personal agent.
// - Brain: the Claude Code CLI already signed in on this Mac (run headless).
// - Hands: shell + files + a dedicated Chrome profile (Playwright MCP) that stays signed in.
// - Ears: a console at http://127.0.0.1:<port> and the owner's own iMessage thread.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SELFTEST = process.argv.includes('--selftest');   // start, prove it boots, exit: used before Jarvis restarts itself
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const config = {
  port: 4747,
  owner_handles: [],          // your own phone number / Apple ID email, e.g. ["+15551234567"]
  poll_seconds: 3,
  claude_bin: 'claude',
  model: '',                  // empty = Claude Code's default
  timeout_minutes: 15,
  own_account: false,         // true once Messages on this Mac is signed in to Jarvis's own Apple ID
  ...readJson(path.join(ROOT, 'config.json'), {}),
};
const STATE_FILE = path.join(DATA, 'state.json');
const state = { session: null, lastRowId: null, reminders: [], nodes: [], ...readJson(STATE_FILE, {}) };
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const TOKEN_FILE = path.join(DATA, 'token');
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

// Keep the Mac from idle-sleeping while Jarvis runs (it still sleeps when the lid closes).
spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {});
const log = (...a) => console.log(new Date().toISOString(), ...a);
const notices = [];           // things the console should show (reminders fired, texts handled)
const notice = (kind, text) => { notices.push({ n: notices.length + 1, kind, text, at: Date.now() }); };

/* ---------------- brain ---------------- */
const MCP_FILE = path.join(DATA, 'mcp.json');
fs.writeFileSync(MCP_FILE, JSON.stringify({
  mcpServers: {
    browser: {
      command: process.execPath,
      // Fallback only. The owner chose their real Chrome (see `j.js look`); this separate browser starts only if it is used.
      args: [path.join(ROOT, 'node_modules/@playwright/mcp/cli.js'), '--browser', 'chrome', '--user-data-dir', path.join(DATA, 'browser-profile')],
    },
  },
}, null, 2));

const CHROME_ARGS = ['--user-data-dir=' + path.join(DATA, 'browser-profile'), '--remote-debugging-port=9333', '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check'];
const browserUp = () => fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false);
// Chrome started in the background has no window, and the browser tools need at least one tab to work in.
const ensureTab = async () => {
  try {
    const tabs = await fetch('http://127.0.0.1:9333/json/list', { signal: AbortSignal.timeout(1500) }).then(r => r.json());
    if (!tabs.some(t => t.type === 'page')) await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(3000) });
  } catch {}
  return true;
};
async function ensureBrowser() {
  if (await browserUp()) return ensureTab();
  execFile('/usr/bin/open', ['-gna', 'Google Chrome', '--args', ...CHROME_ARGS], () => {});   // -g: opens behind what you are doing
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); if (await browserUp()) return ensureTab(); }
  return false;
}
// Connectors from the owner's Claude account that Jarvis may use directly (faster and steadier than a browser).
const CONNECTORS = config.connectors || ['Gmail', 'Google_Calendar', 'Google_Drive', 'Google_Docs', 'Canva'];
let chain = Promise.resolve();          // one job at a time: there is one browser and one conversation
let working = null;
// Cheapest model that can do the job: quick asks go to the small model, ordinary work to the middle one,
// heavy thinking to the top one. A model that is out of its depth answers ESCALATE and the next tier takes over.
const TIERS = config.models || ['haiku', 'sonnet', 'opus'];
function pickTier(text) {
  if (/\b(yourself|your (own )?(code|ui|look|design|interface|screen|voice|prompt|app|web|settings|behaviou?r))\b/i.test(text)) return TIERS.length - 1;   // changing itself gets the best model
  if (text.length > 400 || /\b(research|analy[sz]e|compare|strategy|essay|debug|refactor|in depth|study guide|step[- ]by[- ]step plan|write (a|an|my|the)|build (a|an|me))\b/i.test(text)) return 2;
  if (text.length < 90 && /^(hi|hey|hello|thanks|thank you|ok|yes|no|yep|nope)\b|\b(what time|what day|the date|remind me|reminder|timer|open|launch|play|pause|volume|cancel)\b/i.test(text)) return 0;
  return 1;
}
const HISTORY = path.join(DATA, 'history.jsonl');
// Self-changes are applied by the service, not left to the model to remember: every request that touched Jarvis's
// own files is recorded, the screen is refreshed, and the service restarts only if the new code is proven to boot.
const git = (...a) => new Promise(r => execFile('git', ['-C', ROOT, '-c', 'user.name=Jarvis', '-c', 'user.email=jarvis@localhost', ...a], (e, so, se) => r({ ok: !e, out: (so || '').trim(), err: (se || '').trim() })));
async function bootCheck() {
  const run = args => new Promise(r => execFile(process.execPath, args, { cwd: ROOT, timeout: 20000 }, (e, so, se) => r(e ? (se || e.message).trim().slice(0, 600) : '')));
  return await run(['--check', 'server.js']) || await run(['--check', 'j.js']) || await run(['server.js', '--selftest']);
}
async function applyFiles(files) {
  if (files.some(f => f === 'server.js' || f === 'j.js')) {
    const problem = await bootCheck();
    if (problem) { await git('revert', '--no-edit', 'HEAD'); return '\n\nMy change to my own service did not start cleanly, so I put it back. The problem was: ' + problem.slice(0, 200); }
    chain.then(() => setTimeout(() => { log('restarting to apply a self-change'); process.exit(0); }, 1500));
  }
  if (files.includes('app.html')) notice('reload', '');
  return '';
}
async function applySelfChanges(label) {
  const st = await git('status', '--porcelain');
  if (!st.ok || !st.out) return '';
  const files = st.out.split('\n').map(l => l.trim().split(/\s+/).slice(1).join(' ').replace(/^"|"$/g, ''));
  await git('add', '-A'); await git('commit', '-m', 'Jarvis: ' + label.replace(/\s+/g, ' ').slice(0, 70));
  log('self-change recorded:', files.join(', '));
  return applyFiles(files);
}
function ask(text, channel) {
  const job = chain.then(async () => {
    let tier = pickTier(text), reply = await runClaude(text, channel, tier);
    while (/^\s*ESCALATE\b/.test(reply) && tier < TIERS.length - 1) reply = await runClaude(text, channel, ++tier);
    reply += await applySelfChanges(text).catch(() => '');
    fs.appendFile(HISTORY, JSON.stringify({ at: Date.now(), channel, text, reply, model: TIERS[tier] }) + '\n', () => {});
    return reply;
  });
  chain = job.catch(() => {});
  return job;
}
async function runClaude(text, channel, tier) {
  return new Promise((resolve) => {
    const system = fs.readFileSync(path.join(ROOT, 'prompt.md'), 'utf8')
      .replaceAll('{{ROOT}}', ROOT).replaceAll('{{NODE}}', process.execPath)
      + (tier < TIERS.length - 1 ? '\n\nYou are the fast, low-cost tier. If this request needs deeper reasoning, long writing or careful multi-step judgement than you can do well, reply with exactly the single word ESCALATE and nothing else, before doing any work. Otherwise just do it.' : '');
    const args = ['-p', '--output-format', 'json',
      '--append-system-prompt', system,
      '--mcp-config', MCP_FILE,
      '--allowedTools', ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill', 'mcp__browser', 'mcp__scrapling', ...CONNECTORS.map(c => 'mcp__claude_ai_' + c)].join(',')];
    args.push('--model', config.model || TIERS[tier]);
    if (state.session) args.push('--resume', state.session);
    working = { channel, text, since: Date.now(), model: config.model || TIERS[tier] };
    const child = spawn(config.claude_bin, args, { cwd: os.homedir(), env: { ...process.env, JARVIS_TOKEN: TOKEN } });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), config.timeout_minutes * 60_000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); working = null; resolve(`I couldn't start my brain (${e.message}).`); });
    child.on('close', code => {
      clearTimeout(timer); working = null;
      try {
        const r = JSON.parse(out.trim().split('\n').pop());
        if (r.session_id) { state.session = r.session_id; save(); }
        if (r.is_error && /No conversation found|session/i.test(String(r.result || '')) && state.session) { state.session = null; save(); }
        resolve(String(r.result || '').trim() || 'Done.');
      } catch {
        log('claude failed', code, err.slice(0, 500), out.slice(0, 500));
        if (state.session && /No conversation found/i.test(err + out)) { state.session = null; save(); }
        resolve(code === null ? 'That took too long, so I stopped. Try a smaller ask.' : `Something went wrong on my side (${(err || out).trim().slice(0, 200) || 'exit ' + code}).`);
      }
    });
    child.stdin.end(`[${channel === 'text' ? 'sent by text message from the owner; reply in plain text, a few short sentences' : 'typed in the console by the owner'}]\n${text}`);
  });
}

/* ---------------- iMessage ---------------- */
const CHAT_DB = path.join(os.homedir(), 'Library/Messages/chat.db');
const handles = config.owner_handles.map(h => String(h).toLowerCase().trim()).filter(Boolean);
const sentByMe = new Map();   // texts Jarvis sent, so it never answers itself
let imessage = handles.length ? 'starting' : 'off: add your number to config.json';
const recentSeen = new Map();

function sqlite(sql) {
  return new Promise((res, rej) => execFile('/usr/bin/sqlite3', ['-readonly', '-json', CHAT_DB, sql],
    { maxBuffer: 64 * 1024 * 1024 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so.trim() ? JSON.parse(so) : [])));
}
// Newer macOS keeps message text inside an archived attributedBody blob.
function decodeBody(hex) {
  if (!hex) return '';
  const b = Buffer.from(hex, 'hex');
  let i = b.indexOf('NSString');
  if (i < 0) return '';
  i = b.indexOf(0x2b, i + 8);
  if (i < 0) return '';
  i++;
  let len = b[i++];
  if (len === 0x81) { len = b.readUInt16LE(i); i += 2; } else if (len === 0x82) { len = b.readUInt32LE(i); i += 4; }
  return b.subarray(i, i + len).toString('utf8');
}
function sendText(text, chat = state.lastChat) {
  if (!handles.length) return Promise.resolve(false);
  const script = `on run argv
tell application "Messages"
set svc to 1st account whose service type = iMessage
if (item 3 of argv) is not "" then
try
send (item 1 of argv) to chat id (item 3 of argv)
return "chat"
end try
end if
send (item 1 of argv) to participant (item 2 of argv) of svc
return "participant"
end tell
end run`;
  const body = text.trim().slice(0, 3000);
  sentByMe.set(body, Date.now());
  return new Promise(res => execFile('/usr/bin/osascript', ['-e', script, body, config.owner_handles[0], chat || ''],
    (e, so, se) => { if (e) log('send failed', se || e.message); else log('sent via', so.trim(), chat || ''); res(!e); }));
}
async function poll() {
  try {
    if (state.lastRowId == null) {
      const r = await sqlite('select coalesce(max(ROWID),0) as m from message');
      state.lastRowId = r[0].m; save();
    }
    const rows = await sqlite(`select m.ROWID as id, m.is_from_me as me, m.text as text, hex(m.attributedBody) as body, c.chat_identifier as chat, c.guid as guid
      from message m join chat_message_join j on j.message_id = m.ROWID join chat c on c.ROWID = j.chat_id
      where m.ROWID > ${Number(state.lastRowId)} order by m.ROWID limit 50`);
    imessage = 'on';
    for (const r of rows) {
      state.lastRowId = r.id;
      if (!handles.includes(String(r.chat).toLowerCase())) continue;     // only the thread with yourself
      const text = (r.text || decodeBody(r.body) || '').trim();
      if (!text) continue;
      if (config.own_account && r.me) continue;                         // Jarvis's own account: only what the owner sends in counts
      if (Date.now() - (sentByMe.get(text) || 0) < 120_000) continue;    // skip Jarvis's own replies
      const now = Date.now();
      if (now - (recentSeen.get(text) || 0) < 15_000) continue;          // self-texts arrive twice
      recentSeen.set(text, now);
      if (/^\d{8,}:[\w-]{30,}$/.test(text)) continue;                 // looks like a secret token, never a request
      log('text in:', text.slice(0, 80));
      notice('text', text);
      state.lastChat = r.guid;
      ask(text, 'text').then(reply => { notice('reply', reply); return sendText(reply, r.guid); });
    }
    if (rows.length) save();
  } catch (e) {
    imessage = /authorization denied|unable to open/i.test(e.message) ? 'blocked: grant Full Disk Access to node' : 'error: ' + e.message.slice(0, 80);
  }
}
if (handles.length && !SELFTEST) setInterval(poll, Math.max(2, config.poll_seconds) * 1000);

/* ---------------- Telegram: Jarvis as its own contact ---------------- */
let TG = '', pairCode = null, pairMisses = 0;
let telegram = 'off';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tg = (method, params, ms = 15000) => fetch(`https://api.telegram.org/bot${TG}/${method}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(ms) }).then(r => r.json());
async function tgSend(text) {
  if (!TG || !state.tgChat) return false;
  try { for (let i = 0; i < text.length; i += 4000) await tg('sendMessage', { chat_id: state.tgChat, text: text.slice(i, i + 4000) }); return true; }
  catch (e) { log('telegram send failed', e.message); return false; }
}
async function tgLoop() {
  for (;;) {
    try {
      if (!TG) { TG = String(readJson(path.join(ROOT, 'config.json'), {}).telegram_token || '').trim(); if (!TG) { telegram = 'off'; await sleep(5000); continue; } }
      if (state.tgChat) telegram = 'on';
      else { if (!pairCode) pairCode = String(crypto.randomInt(100000, 999999)); telegram = `send ${pairCode} to your Jarvis bot`; }
      const r = await tg('getUpdates', { offset: state.tgOffset || 0, timeout: 50, allowed_updates: ['message'] }, 65000);
      if (!r.ok) { telegram = 'error: ' + (r.description || 'check the token'); if (r.error_code === 401 || r.error_code === 404) TG = ''; await sleep(5000); continue; }
      for (const u of r.result) {
        state.tgOffset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.text || m.chat.type !== 'private') continue;
        const text = m.text.trim();
        if (!state.tgChat) {                                   // not paired yet: only the code shown in the Jarvis app counts
          if (text === pairCode) { state.tgChat = m.chat.id; pairCode = null; telegram = 'on'; await tgSend('Paired. I answer only to you now.'); }
          else if (!text.startsWith('/') && ++pairMisses >= 5) { pairCode = null; pairMisses = 0; }
          continue;
        }
        if (m.chat.id !== state.tgChat || text.startsWith('/start')) continue;   // strangers are ignored
        log('telegram in:', text.slice(0, 80));
        notice('text', text);
        const typing = setInterval(() => tg('sendChatAction', { chat_id: state.tgChat, action: 'typing' }).catch(() => {}), 4000);
        tg('sendChatAction', { chat_id: state.tgChat, action: 'typing' }).catch(() => {});
        ask(text, 'text').then(reply => { clearInterval(typing); notice('reply', reply); return tgSend(reply); });
      }
      if (r.result.length) save();
    } catch { await sleep(3000); }
  }
}
if (!SELFTEST) tgLoop();
// Reminders and proactive texts go to the Messages thread first; Telegram is only the backup if that send fails.
const notifyOwner = async text => (await sendText(text)) || tgSend(text);

/* ---------------- reminders ---------------- */
if (!SELFTEST) setInterval(() => {
  const now = Date.now();
  const due = state.reminders.filter(r => r.at <= now);
  if (!due.length) return;
  state.reminders = state.reminders.filter(r => r.at > now); save();
  for (const r of due) { notice('reminder', r.text); notifyOwner('Reminder: ' + r.text); }
}, 1000);

/* ---------------- access web: everything Jarvis can reach ---------------- */
const PROFILE = path.join(DATA, 'browser-profile');
const STARTER_SITES = [['Instagram', 'instagram.com', 'https://www.instagram.com/direct/inbox/'], ['TikTok', 'tiktok.com', 'https://www.tiktok.com/messages'],
  ['Gmail', 'google.com', 'https://mail.google.com'], ['Google Calendar', 'google.com', 'https://calendar.google.com'], ['Google Drive', 'google.com', 'https://drive.google.com'],
  ['YouTube', 'youtube.com', 'https://www.youtube.com'], ['X', 'x.com', 'https://x.com'], ['Snapchat', 'snapchat.com', 'https://web.snapchat.com'],
  ['Discord', 'discord.com', 'https://discord.com/app'], ['WhatsApp', 'whatsapp.com', 'https://web.whatsapp.com'], ['LinkedIn', 'linkedin.com', 'https://www.linkedin.com'],
  ['Reddit', 'reddit.com', 'https://www.reddit.com'], ['Spotify', 'spotify.com', 'https://open.spotify.com'],
  ['ChatGPT', 'chatgpt.com', 'https://chatgpt.com'], ['Grok', 'grok.com', 'https://grok.com'], ['Claude', 'claude.ai', 'https://claude.ai'], ['Gemini', 'google.com', 'https://gemini.google.com'],
  ...(config.sites || []).map(s => [s.name, new URL(s.url).hostname.split('.').slice(-2).join('.'), s.url, s.profile])];
const AI_SITES = new Set(['ChatGPT', 'Grok', 'Claude', 'Gemini']);
let cookieDomains = new Set(), cookieAt = 0;
// A visit leaves cookies too, so "signed in" means the site's own login cookie is present (names only; values stay encrypted).
const LOGIN_COOKIE = { 'instagram.com': /^sessionid$/, 'tiktok.com': /^(sessionid|sid_tt)$/, 'google.com': /^(SID|__Secure-1PSID)$/, 'youtube.com': /^LOGIN_INFO$/,
  'x.com': /^auth_token$/, 'linkedin.com': /^li_at$/, 'reddit.com': /^reddit_session$/, 'spotify.com': /^sp_dc$/, 'chatgpt.com': /^__Secure-next-auth\.session-token/,
  'grok.com': /^sso$/, 'claude.ai': /^sessionKey/ };
let cookieNames = new Map();
const signedIn = dom => { const names = cookieNames.get(dom); return !!names && (LOGIN_COOKIE[dom] ? [...names].some(n => LOGIN_COOKIE[dom].test(n)) : true); };
// Sign-ins live in the owner's real Chrome, across all of its profiles (personal, school and so on).
const REAL_CHROME = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const chromeProfiles = () => { try { return Object.keys(JSON.parse(fs.readFileSync(path.join(REAL_CHROME, 'Local State'), 'utf8')).profile.info_cache); } catch { return ['Default']; } };
async function refreshCookies() {
  if (Date.now() - cookieAt < 30_000) return;
  cookieAt = Date.now();
  const names = new Map();
  for (const prof of chromeProfiles()) {
    const src = [path.join(REAL_CHROME, prof, 'Cookies'), path.join(REAL_CHROME, prof, 'Network/Cookies')].find(f => fs.existsSync(f));
    if (!src) continue;
    const tmp = path.join(DATA, 'cookies.copy');
    try { fs.copyFileSync(src, tmp); } catch { continue; }
    await new Promise(res => execFile('/usr/bin/sqlite3', ['-readonly', '-json', tmp, 'select distinct host_key as h, name as n from cookies'], { maxBuffer: 64e6 }, (e, so) => {
      try { for (const r of !e && so.trim() ? JSON.parse(so) : []) { const d = r.h.replace(/^\./, '').split('.').slice(-2).join('.'); if (!names.has(d)) names.set(d, new Set()); names.get(d).add(r.n); } } catch {}
      fs.rm(tmp, () => res());
    }));
  }
  if (names.size) { cookieNames = names; cookieDomains = new Set(names.keys()); }
}
// App usage from macOS's own Screen Time records.
let usageCache = { at: 0, days: 0, rows: [] };
function usage(days = 0) {
  if (Date.now() - usageCache.at < 60_000 && usageCache.days === days) return Promise.resolve(usageCache.rows);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const since = Math.floor(start.getTime() / 1000) - days * 86400 - 978307200;
  const db = path.join(os.homedir(), 'Library/Application Support/Knowledge/knowledgeC.db');
  const sql = `select ZVALUESTRING as app, cast(sum(ZENDDATE - ZSTARTDATE) as int) as secs from ZOBJECT where ZSTREAMNAME = '/app/usage' and ZSTARTDATE > ${since} group by 1 having secs > 60 order by 2 desc limit 25`;
  return new Promise(res => execFile('/usr/bin/sqlite3', ['-readonly', '-json', db, sql], (e, so) => {
    let rows = [];
    try { rows = e || !so.trim() ? [] : JSON.parse(so).map(r => ({ app: String(r.app).split('.').pop().replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()), bundle: r.app, minutes: Math.round(r.secs / 60) })); } catch {}
    usageCache = { at: Date.now(), days, rows }; res(rows);
  }));
}
const span = m => m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
let signIns = [];
let openers = new Map();
async function accessTree() {
  await refreshCookies();
  const home = os.homedir();
  const appsIn = d => { try { return fs.readdirSync(d).filter(n => n.endsWith('.app')).map(n => n.slice(0, -4)); } catch { return []; } };
  const installed = [...new Set([...appsIn('/Applications'), ...appsIn(path.join(home, 'Applications'))])].filter(n => n !== 'Jarvis' && !/URL Handler|Uninstall|Updater/i.test(n)).sort((a, b) => a.localeCompare(b));
  const isAi = n => /chatgpt|claude|grok|codex|gemini|copilot|perplexity/i.test(n);
  const app = n => ({ label: n, open: ['-a', n] });
  const chrome = (url, prof) => ['-na', 'Google Chrome', '--args', '--profile-directory=' + (prof || 'Default'), url];
  const site = ([name, dom, url, prof]) => signedIn(dom) ? { label: name, open: chrome(url, prof) } : { label: name, sub: 'not signed in', dim: true, open: chrome(url, prof) };
  const known = new Set(STARTER_SITES.map(s => s[1]));
  const others = [...cookieDomains].filter(d => !known.has(d) && !/google|gstatic|doubleclick|youtube|facebook|fbcdn|cdn|analytics|tiktokv|byteoversea/.test(d)).sort().slice(0, 60).map(d => ({ label: d, open: chrome('https://' + d) }));
  const files = [['Home', home], ['Desktop', path.join(home, 'Desktop')], ['Documents', path.join(home, 'Documents')], ['Downloads', path.join(home, 'Downloads')],
    ['iCloud Drive', path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs')], ['Jarvis memory', path.join(DATA, 'memory.md')], ['Jarvis folder', ROOT]]
    .filter(f => fs.existsSync(f[1])).map(([label, p]) => ({ label, open: [p] }));
  const groups = [
    { label: 'Files', items: files },
    { label: 'Mac', items: ['Messages', 'Calendar', 'Reminders', 'Mail', 'Notes', 'Contacts', 'Photos', 'Music', 'Safari', 'Finder', 'System Settings'].map(app) },
    { label: 'Other AIs', items: [...installed.filter(isAi).map(app), ...STARTER_SITES.filter(s => AI_SITES.has(s[0])).map(site)] },
    { label: 'Accounts', items: STARTER_SITES.filter(s => !AI_SITES.has(s[0])).map(site) },
    { label: 'Apps', items: installed.filter(n => !isAi(n)).map(app) },
    { label: 'Usage today', items: (await usage(0)).slice(0, 10).map(u => ({ label: u.app, sub: span(u.minutes) })) },
    { label: 'iPhone', items: [{ label: 'Telegram', sub: telegram === 'on' ? 'on' : telegram === 'off' ? 'not set up' : 'pairing', dim: telegram !== 'on', open: ['https://web.telegram.org'] }, { label: 'Texts', sub: imessage, dim: imessage !== 'on', open: ['-a', 'Messages'] },
      { label: 'Reminders', sub: state.reminders.length + ' waiting', open: ['-a', 'Messages'] }] },
  ];
  signIns = STARTER_SITES.filter(s => !signedIn(s[1])).map(s => ({ label: s[0], url: s[2], prof: s[3] || 'Default' }));
  // Branches Jarvis or the owner added (for example the accounts signed in on a site) hang off the node they name.
  const all = [];
  const walk = (n, f) => { f(n); (n.children || n.items || []).forEach(c => walk(c, f)); };
  groups.forEach(g => walk(g, n => all.push(n)));
  for (const extra of state.nodes) {
    const parent = all.find(n => n.label.toLowerCase() === String(extra.parent).toLowerCase());
    const host = parent || groups.find(g => g.label === 'Accounts');
    const child = { label: extra.label, open: extra.url ? chrome(extra.url) : (host.open || null) };
    const list = host.items || (host.children = host.children || []);
    if (!list.some(c => c.label.toLowerCase() === child.label.toLowerCase())) { list.push(child); all.push(child); if (host.dim) { host.dim = false; delete host.sub; } }
  }
  openers = new Map();
  let seq = 0;
  groups.forEach(g => g.items.forEach(it => walk(it, n => { if (n.open) { n.id = 'n' + (seq++); openers.set(n.id, n.open); } delete n.open; })));
  return { groups: groups.filter(g => g.items.length) };
}

/* ---------------- http (this Mac only) ---------------- */
const page = () => fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8').replace('{{TOKEN}}', TOKEN);
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return json(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page());
  }
  if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  // Every API call needs the secret token, so other websites open in a browser cannot command Jarvis.
  const given = Buffer.from(String(req.headers['x-jarvis-token'] || ''));
  if (given.length !== TOKEN.length || !crypto.timingSafeEqual(given, Buffer.from(TOKEN))) return json(res, 401, { error: 'unauthorized' });
  let body = {};
  if (req.method === 'POST') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) return json(res, 413, {}); }
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'bad json' }); }
  }
  const route = req.method + ' ' + url.pathname;
  if (route === 'GET /api/state') {
    const since = Number(url.searchParams.get('since') || 0);
    return json(res, 200, { imessage, telegram, voice: String(readJson(path.join(ROOT, 'config.json'), {}).voice || ''), working, reminders: state.reminders, notices: notices.filter(n => n.n > since), last: notices.length });
  }
  if (route === 'POST /api/ask') {
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { error: 'empty' });
    return json(res, 200, { reply: await ask(text, 'console') });
  }
  if (route === 'GET /api/access') return json(res, 200, await accessTree());
  if (route === 'POST /api/open') {
    const args = openers.get(String(body.id));          // only things in the web can be opened, never an arbitrary path
    if (!args) return json(res, 404, { error: 'unknown' });
    execFile('/usr/bin/open', args, () => {});
    return json(res, 200, { ok: true });
  }
  if (route === 'GET /api/history') {
    let lines = [];
    try { lines = fs.readFileSync(HISTORY, 'utf8').trim().split('\n').slice(-150).map(l => JSON.parse(l)); } catch {}
    return json(res, 200, { items: lines });
  }
  if (route === 'GET /api/usage') return json(res, 200, { days: Number(url.searchParams.get('days') || 0), apps: await usage(Number(url.searchParams.get('days') || 0)) });
  if (route === 'GET /api/signins') {
    await accessTree();
    const missing = new Set(signIns.map(x => x.label));
    return json(res, 200, { signed_in: STARTER_SITES.map(x => x[0]).filter(n => !missing.has(n)), not_signed_in: [...missing], added_by_owner: state.nodes.map(n => n.parent + ' > ' + n.label) });
  }
  if (route === 'POST /api/signin') {
    await accessTree();
    const want = (body.only || []).map(x => String(x).toLowerCase());
    const list = signIns.filter(s => !want.length || want.includes(s.label.toLowerCase()));
    for (const prof of new Set(list.map(s => s.prof))) execFile('/usr/bin/open', ['-na', 'Google Chrome', '--args', '--profile-directory=' + prof, ...list.filter(s => s.prof === prof).map(s => s.url)], () => {});
    return json(res, 200, { opened: list.map(s => s.label) });
  }
  if (route === 'GET /api/debug/threads') {
    const rows = await sqlite(`select m.ROWID as id, m.is_from_me as me, c.chat_identifier as chat, c.guid as guid, coalesce(m.destination_caller_id,'') as caller, coalesce(m.service,'') as service from message m join chat_message_join j on j.message_id = m.ROWID join chat c on c.ROWID = j.chat_id where lower(c.chat_identifier) in (${handles.map(h => "'" + h.replace(/'/g, '') + "'").join(',')}) order by m.ROWID desc limit 16`).catch(e => [{ error: e.message }]);
    return json(res, 200, rows);
  }
  if (route === 'GET /api/doctor') {
    const osa = (script, ms = 30000) => new Promise(r => execFile('/usr/bin/osascript', ['-e', script], { timeout: ms }, (e, so, se) => {
      if (!e) return r('ok');
      const m = String(se || e.message);
      r(e.killed ? 'waiting: macOS is showing a prompt on the Mac. Click Allow, then check again'
        : /-1743|Not authori[sz]ed/i.test(m) ? 'denied: turn it on in System Settings > Privacy & Security > Automation > node'
        : /-25211|-1719|assistive/i.test(m) ? 'off: turn on node in System Settings > Privacy & Security > Accessibility'
        : 'error: ' + m.trim().slice(0, 120));
    }));
    const out = {};
    out['Files and Messages (Full Disk Access)'] = await sqlite('select 1 as ok').then(() => 'ok', e => 'off: add node in System Settings > Privacy & Security > Full Disk Access');
    out['App usage (Screen Time data)'] = (await usage(0)).length ? 'ok' : 'no data readable';
    for (const [app, script] of [['Messages', 'count of accounts'], ['Calendar', 'count of calendars'], ['Reminders', 'count of lists'], ['Notes', 'count of folders'], ['Contacts', 'count of people'], ['Finder', 'count of windows'], ['System Events', 'count of processes']])
      out['Control ' + app] = await osa(`tell application "${app}" to ${script}`);
    out['Click and type in any app (Accessibility)'] = await osa('tell application "System Events" to tell process "Finder" to count of menu bar items of menu bar 1');
    out['Control Google Chrome'] = await osa('tell application "Google Chrome" to count of windows');
    out['Read pages in Chrome'] = await osa('tell application "Google Chrome" to execute active tab of front window javascript "1"').then(r =>
      /JavaScript|Apple ?Events/i.test(r) ? 'off: in Chrome choose View > Developer > Allow JavaScript from Apple Events, once in each Chrome profile' : r);
    out['Chrome profiles seen'] = chromeProfiles().join(', ');
    out['Texts (Messages thread)'] = imessage; out['Telegram backup'] = telegram;
    out['Connectors allowed'] = CONNECTORS.join(', ');
    return json(res, 200, out);
  }
  if (route === 'POST /api/undo') {
    const last = await git('log', '-1', '--name-only', '--format=%s');
    const [subject, ...files] = last.out.split('\n').filter(Boolean);
    const r = await git('revert', '--no-edit', 'HEAD');
    if (!r.ok) return json(res, 200, { undone: false, problem: r.err.slice(0, 300) });
    return json(res, 200, { undone: subject, files, note: (await applyFiles(files)) || 'Applied.' });
  }
  if (route === 'POST /api/reload') { notice('reload', ''); return json(res, 200, { ok: true }); }
  if (route === 'POST /api/restart') {
    // Never restart into broken code: check syntax, then boot a throwaway copy, and only then restart once the current reply is out.
    const problem = await bootCheck();
    if (problem) return json(res, 200, { restarted: false, problem });
    chain.then(() => setTimeout(() => { log('restarting on request'); process.exit(0); }, 1500));
    return json(res, 200, { restarted: true, note: 'Restarting right after this reply is delivered.' });
  }
  if (route === 'POST /api/node') {
    const parent = String(body.parent || '').trim(), label = String(body.label || '').trim().slice(0, 60);
    if (!parent || !label) return json(res, 400, { error: 'need parent and label' });
    let url = '';
    if (body.url) { try { const u = new URL(String(body.url)); if (u.protocol === 'https:' || u.protocol === 'http:') url = u.href; } catch {} }
    state.nodes = state.nodes.filter(n => !(n.parent.toLowerCase() === parent.toLowerCase() && n.label.toLowerCase() === label.toLowerCase()));
    if (!body.remove) state.nodes.push({ parent, label, url });
    save(); cookieAt = 0;
    return json(res, 200, { ok: true, nodes: state.nodes });
  }
  if (route === 'POST /api/reset') { state.session = null; save(); return json(res, 200, { ok: true }); }
  if (route === 'POST /api/remind') {
    const at = body.at ? Date.parse(body.at) : Date.now() + Number(body.seconds) * 1000;
    const text = String(body.text || '').trim();
    if (!text || !Number.isFinite(at)) return json(res, 400, { error: 'need text and seconds or at' });
    const r = { id: crypto.randomBytes(3).toString('hex'), at, text };
    state.reminders.push(r); save();
    return json(res, 200, { ...r, when: new Date(at).toString() });
  }
  if (route === 'POST /api/cancel') {
    const before = state.reminders.length;
    state.reminders = state.reminders.filter(r => r.id !== body.id); save();
    return json(res, 200, { cancelled: before - state.reminders.length });
  }
  if (route === 'POST /api/text') return json(res, 200, { sent: await notifyOwner(String(body.text || '')) });
  return json(res, 404, { error: 'not found' });
});
server.requestTimeout = 0; server.headersTimeout = 0; server.timeout = 0;
if (SELFTEST) setTimeout(() => process.exit(0), 700);
server.listen(SELFTEST ? 0 : config.port, '127.0.0.1', () => log(`Jarvis is up at http://127.0.0.1:${config.port}  (texting: ${imessage})`));
