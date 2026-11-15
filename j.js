#!/usr/bin/env node
// Small command Jarvis's brain uses to reach the Jarvis service: reminders and texts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const token = fs.readFileSync(path.join(ROOT, 'data/token'), 'utf8').trim();
let port = 4747;
try { port = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).port || port; } catch {}

async function call(method, route, body) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { 'x-jarvis-token': token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
const [cmd, ...rest] = process.argv.slice(2);
let out;
if (cmd === 'remind') {
  const [when, ...words] = rest;
  const text = words.join(' ');
  out = /^\d+(\.\d+)?$/.test(when) ? await call('POST', '/api/remind', { seconds: Number(when), text })
    : await call('POST', '/api/remind', { at: when, text });
} else if (cmd === 'reminders') {
  out = (await call('GET', '/api/state')).reminders.map(r => ({ ...r, when: new Date(r.at).toString() }));
} else if (cmd === 'cancel') {
  out = await call('POST', '/api/cancel', { id: rest[0] });
} else if (cmd === 'text') {
  out = await call('POST', '/api/text', { text: rest.join(' ') });
} else if (cmd === 'usage') {
  out = await call('GET', '/api/usage?days=' + (Number(rest[0]) || 0));
} else if (cmd === 'signins') {
  out = await call('GET', '/api/signins');
} else if (cmd === 'signin') {
  out = await call('POST', '/api/signin', { only: rest });
} else if (cmd === 'history') {
  out = (await call('GET', '/api/history')).items.slice(-(Number(rest[0]) || 20));
} else if (cmd === 'doctor') {
  out = await call('GET', '/api/doctor');
} else if (cmd === 'restart') {
  out = await call('POST', '/api/restart');
} else if (cmd === 'reload') {
  out = await call('POST', '/api/reload');
} else if (cmd === 'undo') {
  out = await call('POST', '/api/undo');
} else if (cmd === 'save' || cmd === 'changes') {
  const git = (...a) => execFileSync('git', ['-C', ROOT, '-c', 'user.name=Jarvis', '-c', 'user.email=jarvis@localhost', ...a], { encoding: 'utf8' }).trim();
  try {
    if (cmd === 'save') { git('add', '-A'); out = { saved: git('commit', '-m', rest.join(' ') || 'Jarvis change', '--allow-empty').split('\n')[0] }; }
    else out = { recent: git('log', '-8', '--format=%h %ad %s', '--date=format:%b %d %H:%M').split('\n') };
  } catch (e) { out = { error: String(e.stderr || e.message).trim().slice(0, 400) }; }
} else if (cmd === 'look' || cmd === 'done') {
  // Look at a page in the owner's real Chrome, in the right Google account's profile.
  // Chrome puts the page in a new tab of that profile's open window, or a new window if it has none.
  // `done` closes only what `look` opened: the tab, or the whole window if look had to make one.
  // The school-managed Chrome profile blocks page reading, so the school account is signed in inside the personal profile.
  const PROFILES = { school: 'Default', personal: 'Default' };
  const osa = (src) => {
    for (let i = 0; ; i++) {
      try { return execFileSync('osascript', ['-e', src], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
      catch (e) { if (i >= 4 || !/-609|-600|-1712|-1719|-1728/.test(String(e.stderr))) throw e; execFileSync('sleep', ['0.5']); }
    }
  };
  const running = () => { try { execFileSync('pgrep', ['-x', 'Google Chrome']); return true; } catch { return false; } };
  // One bulk read per window, so a tab opening or closing mid-read cannot break it.
  const tabs = () => !running() ? [] : osa(`tell application "Google Chrome"
    set o to ""
    set T to character id 9
    repeat with wid in (get id of windows)
      try
        set ids to id of tabs of window id wid
        set urls to URL of tabs of window id wid
        repeat with i from 1 to count of ids
          set o to o & wid & T & (item i of ids) & T & (item i of urls) & linefeed
        end repeat
      end try
    end repeat
    return o
  end tell`).split('\n').filter(Boolean).map(l => { const [w, t, u] = l.split('\t'); return { w, t, u }; });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    if (cmd === 'look') {
      const [which, url] = rest;
      const profile = PROFILES[which];
      if (!profile || !url) throw new Error('usage: look <school|personal> <url>');
      const before = tabs(), oldWins = new Set(before.map(x => x.w)), oldTabs = new Set(before.map(x => x.t));
      execFileSync('open', ['-na', 'Google Chrome', '--args', `--profile-directory=${profile}`, url]);
      let mine;
      const t0 = Date.now();
      while (!mine && Date.now() - t0 < 30000) {
        await wait(250);
        const fresh = tabs().filter(x => !oldTabs.has(x.t));
        mine = fresh.find(x => x.u && new URL(url).host === (() => { try { return new URL(x.u).host; } catch { return ''; } })()) || fresh[0];
      }
      if (!mine) throw new Error('Chrome did not open the page');
      const handle = `${mine.w}:${mine.t}:${oldWins.has(mine.w) ? 'tab' : 'window'}`;
      const ref = `tab id ${mine.t} of window id ${mine.w}`;
      for (let i = 0; i < 60; i++) { await wait(250); try { if (osa(`tell application "Google Chrome" to return loading of ${ref}`) === 'false') break; } catch {} }
      await wait(1000);
      let text, readError;
      try { text = osa(`tell application "Google Chrome" to execute ${ref} javascript "document.body.innerText"`).slice(0, 30000); }
      catch (e) { readError = 'Could not read the page. Chrome needs View > Developer > Allow JavaScript from Apple Events turned on. ' + String(e.stderr || e.message).trim().slice(0, 200); }
      out = { handle, opened: handle.endsWith('window') ? 'new window' : 'new tab in an open window', url: osa(`tell application "Google Chrome" to return URL of ${ref}`), text, readError };
    } else {
      const [w, t, kind] = String(rest[0] || '').split(':');
      if (!w || !t) throw new Error('usage: done <handle from look>');
      osa(kind === 'window' ? `tell application "Google Chrome" to close window id ${Number(w)}`
        : `tell application "Google Chrome" to close tab id ${Number(t)} of window id ${Number(w)}`);
      out = { closed: kind === 'window' ? 'window' : 'tab' };
    }
  } catch (e) { out = { error: String(e.stderr || e.message).trim().slice(0, 400) }; }
} else if (cmd === 'node') {
  const [verb, parent, label, url] = rest;
  out = verb === 'list' ? (await call('GET', '/api/access'))
    : await call('POST', '/api/node', { parent, label, url, remove: verb === 'remove' });
} else {
  out = { usage: 'remind <seconds|"YYYY-MM-DD HH:MM"> <text> | reminders | cancel <id> | text <message> | node add <parent> <label> [url] | node remove <parent> <label> | node list | usage [days-back] | signins | signin [site ...] | look <school|personal> <url> | done <handle> | history [n] | save <what changed> | undo | changes | restart | reload | doctor' };
}
console.log(JSON.stringify(out, null, 2));
