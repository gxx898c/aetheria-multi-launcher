// Aetheria game client — หนึ่งโปรเซสต่อหนึ่งจอ (แยก --user-data-dir)
// ต่อยอดจาก Aetheria Online 1.0.4 (ตัวทางการ): เปิดลิงก์เว็บอื่นในเบราว์เซอร์, เข้าสู่ระบบ Google ผ่านเบราว์เซอร์ (preload.cjs),
//   user agent ไม่มีคำว่า Electron, F11/F5/Ctrl+Shift+I
// เพิ่ม: PiP, ซ่อน+ปิดเสียง, เล่นต่อตอนย่อ/ซ่อน, กู้คืนเองเมื่อเกมค้าง/แครช/เน็ตหลุด, จำตำแหน่งหน้าต่าง,
//       เปลี่ยนชื่อระหว่างเปิด, จัดเรียงบนจอที่เลือก, รายงาน RAM/CPU, ลดเฟรมเรตตอนซ่อนเพื่อประหยัด CPU
// ไม่มีคำสั่งล้างข้อมูลเข้าสู่ระบบโดยตั้งใจ — บัญชี Guest อยู่ใน localStorage ของจอนั้น ข้อมูลหายแล้วกู้ไม่ได้
// ไม่มีแถบปุ่มในหน้าต่าง — สั่งงานทั้งหมดจาก web console (server.js) ผ่าน HTTP 127.0.0.1:<lv-control-port>
'use strict';
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), crypto = require('node:crypto');
const { app, BaseWindow, WebContentsView, screen, globalShortcut, powerSaveBlocker, dialog, session, shell, ipcMain } = require('electron');

const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--lv-${name}=`)); return a ? a.slice(name.length + 6) : ''; };
const instance = arg('instance') || '1';
const controlPort = Number(arg('control-port'));
const launcherPort = Number(arg('launcher-port')) || 4322;
const cleanTitle = (t) => (typeof t === 'string' ? t.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60) : '');
let title = cleanTitle(arg('title')) || `Aetheria #${instance}`;
const FPS_CHOICES = [0, 20, 10, 5]; // 0 = ไม่จำกัด (เหมือนเดิม)
let hiddenFps = FPS_CHOICES.includes(Number(arg('hidden-fps'))) ? Number(arg('hidden-fps')) : 0;
// เวอร์ชันโค้ดหน้าต่างเกม — เพิ่มทุกครั้งที่เพิ่ม/เปลี่ยนคำสั่ง ให้ตรงกับ CLIENT_VERSION ใน server.js
// launcher ใช้เทียบว่าจอที่เปิดอยู่ต้องปิด-เปิดใหม่เพื่อใช้โค้ดใหม่หรือไม่
const CLIENT_VERSION = 1;
// ชื่อบนแถบหน้าต่าง/taskbar = ชื่อจอ + เวอร์ชัน (launcher ที่เปิดหน้าต่างนี้ ส่งมาทาง --lv-launcher-version) ไว้เทียบเวลามีปัญหา
// เช่น "Main — Launcher v1.1.0 · build a7de5d4 · client v5" · แถบ PiP ใช้แค่ชื่อจอ (พื้นที่เล็ก)
const launcherVersion = arg('launcher-version').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
const windowTitle = () => `${title} — ${launcherVersion ? 'Launcher ' + launcherVersion + ' · ' : ''}client v${CLIENT_VERSION}`;
const gameUrl = 'https://www.aetheria-online.in.th/play';
const SITE = new URL(gameUrl).host;
const isGameSite = (host) => host === SITE || host === 'aetheria-online.in.th' || host.endsWith('.aetheria-online.in.th');
const gameIcon = path.join(__dirname, 'game.ico');
// ขนาดหน้าต่างเล็กสุดของตัวทางการ (960×540) — หน้าต่างเล็กกว่านี้ย่อภาพ (zoom) ให้ UI เกมยังพอดี
const REF_W = 960, REF_H = 540, PIP_BAR = 24;
const RETRY_MS = 10000, HANG_MS = 30000;

// ให้เกมทำงานต่อเมื่อหน้าต่างถูกย่อ/ซ่อน
for (const flag of ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']) {
  app.commandLine.appendSwitch(flag);
}
// เหมือนตัวทางการ: ตัดคำว่า Electron/ชื่อแอปออกจาก user agent (เว็บอื่น เช่น Google ทำงานดีกว่ากับ Chrome ปกติ)
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|aetheria-[\w-]+|Aetheria ?Online)\/\S+/g, '');

let normalWindow, pipWindow, gameView, pipBar, lastPiPBounds;
let moving = false, hidden = false, userMuted = true, quitting = false, hiddenWindows = [];
let recoveries = 0, recovering = false, retryTimer, lastPong = Date.now();
// loads = จำนวนครั้งที่หน้าเกมโหลดเสร็จ (เพิ่มเมื่อเปิด/รีเฟรช/กู้คืน)
let loads = 0;
const allWindows = () => [normalWindow, pipWindow].filter((w) => w && !w.isDestroyed());
const allContents = () => [gameView?.webContents, pipBar?.webContents].filter((c) => c && !c.isDestroyed());

// RAM/CPU รวมทุกโปรเซสของจอนี้ (browser, GPU, renderer, utility)
function metrics() {
  let mem = 0, cpu = 0;
  for (const m of app.getAppMetrics()) { mem += m.memory.workingSetSize; cpu += m.cpu.percentCPUUsage; }
  return { mem: Math.round(mem / 1024), cpu: Math.round(cpu * 10) / 10 };
}

function state() {
  return {
    ver: CLIENT_VERSION, title, hidden, muted: userMuted, pip: !!pipWindow, recoveries, recovering,
    loads,
    fullscreen: !!normalWindow && !normalWindow.isDestroyed() && normalWindow.isFullScreen(),
    ...metrics(),
  };
}

// --- จำตำแหน่ง/ขนาดหน้าต่าง (เก็บใน InstanceN/lv-window.json) ---
const boundsFile = () => path.join(app.getPath('userData'), 'lv-window.json');
function onScreen(b) {
  return b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width >= 64 && b.height >= 48
    && screen.getAllDisplays().some(({ workArea: a }) =>
      Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= 50 && Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= 50);
}
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch { return {}; }
}
function saveBounds() {
  if (!normalWindow || normalWindow.isDestroyed()) return;
  if (pipWindow && !pipWindow.isDestroyed()) lastPiPBounds = pipWindow.getBounds();
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify({ normal: normalWindow.getNormalBounds(), maximized: normalWindow.isMaximized(), pip: lastPiPBounds }));
  } catch { /* ไม่สำคัญถ้าบันทึกไม่ได้ */ }
}

// ย่อภาพเกมเมื่อหน้าต่างเล็กกว่า 960x540 โดยไม่โหลดเกมใหม่
function layout() {
  const win = pipWindow || normalWindow;
  if (!win || win.isDestroyed() || !gameView) return;
  const bar = pipWindow ? PIP_BAR : 0;
  const [width, height] = win.getContentSize();
  const h = Math.max(1, height - bar);
  // เว้นขอบ 4px ให้ลากย่อ/ขยาย PiP ได้
  if (pipWindow && pipBar) pipBar.setBounds({ x: 4, y: 4, width: Math.max(1, width - 8), height: bar - 4 });
  gameView.setBounds({ x: 0, y: bar, width, height: h });
  gameView.webContents.setZoomFactor(Math.max(0.01, Math.min(1, width / REF_W, h / REF_H)));
}

function applyMute() { allContents().forEach((c) => c.setAudioMuted(hidden || userMuted)); }
function toggleMute() { userMuted = !userMuted; applyMute(); }
function setMute(params) { userMuted = params.get('on') === '1'; applyMute(); }

// ตอนซ่อน: จำกัดเฟรมเรตเกมตาม hiddenFps เพื่อประหยัด CPU (0 = ไม่จำกัด)
// ไม่จำกัด → หน้าต่างที่ซ่อนยังวาดเต็มรีเฟรชเรตจอ (เช่น 144–180 FPS) เพราะ flag กันการพักเบื้องหลัง
function applyFrameRate() {
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed()) return;
  const ms = hidden && hiddenFps ? Math.round(1000 / hiddenFps) : 0;
  wc.executeJavaScript(`window.__lvHiddenMs=${ms}`).catch(() => {});
}
function setFps(params) {
  const v = Number(params.get('v'));
  if (!FPS_CHOICES.includes(v)) throw new Error('invalid fps');
  hiddenFps = v;
  applyFrameRate();
}

function setHidden(hide) {
  if (moving || hide === hidden) return;
  if (hide) {
    hiddenWindows = allWindows().filter((w) => w.isVisible());
    hiddenWindows.forEach((w) => { w.setSkipTaskbar(true); w.hide(); });
  } else {
    hiddenWindows.forEach((w) => { if (!w.isDestroyed()) { w.setSkipTaskbar(false); w.show(); } });
    hiddenWindows = [];
  }
  hidden = hide;
  applyMute();
  applyFrameRate();
}

function focus() {
  setHidden(false);
  const w = pipWindow || normalWindow;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function toggleHidden() { if (hidden) focus(); else setHidden(true); }

function refresh() {
  if (moving || !gameView) return;
  gameView.webContents.reload();
  if (!hidden) gameView.webContents.focus();
}

function setTitle(params) {
  const t = cleanTitle(params.get('t'));
  if (!t) throw new Error('invalid title');
  title = t;
  for (const w of [normalWindow, pipWindow]) if (w && !w.isDestroyed()) w.setTitle(windowTitle());
  if (pipBar) pipBar.webContents.executeJavaScript(`document.getElementById('t').textContent=${JSON.stringify(title + ' · PiP')}`).catch(() => {});
}

function toggleFullscreen() {
  if (moving || hidden) return;
  if (pipWindow) { restoreNormal(); normalWindow.setFullScreen(true); }
  else normalWindow.setFullScreen(!normalWindow.isFullScreen());
}

function togglePiP() {
  if (moving || hidden) return;
  if (pipWindow) restoreNormal();
  else return enterPiP();
}

async function enterPiP() {
  if (pipWindow || moving) return;
  moving = true;
  try {
    const area = screen.getDisplayMatching(normalWindow.getBounds()).workArea;
    if (normalWindow.isFullScreen()) normalWindow.setFullScreen(false);
    const width = Math.min(lastPiPBounds?.width || 360, area.width);
    const height = Math.min(lastPiPBounds?.height || 260, area.height);
    const remembered = onScreen(lastPiPBounds);
    pipWindow = new BaseWindow({
      icon: gameIcon, title: windowTitle(),
      x: remembered ? lastPiPBounds.x : area.x + area.width - width - 16,
      y: remembered ? lastPiPBounds.y : area.y + area.height - height - 16,
      width, height, minWidth: 64, minHeight: 48,
      frame: false, resizable: true, alwaysOnTop: true, show: false, backgroundColor: '#0e1424',
    });
    pipWindow.on('resize', layout);
    pipWindow.on('resized', saveBounds);
    pipWindow.on('moved', saveBounds);
    pipWindow.on('closed', () => { pipWindow = null; if (!moving) app.quit(); });

    pipBar = new WebContentsView();
    pipWindow.contentView.addChildView(pipBar);
    installShortcuts(pipBar.webContents);
    await pipBar.webContents.loadFile(path.join(__dirname, 'pip-bar.html'), { query: { t: title } });

    // ย้าย view เดิมไปหน้าต่าง PiP — เกมไม่โหลดใหม่
    normalWindow.contentView.removeChildView(gameView);
    pipWindow.contentView.addChildView(gameView, 0);
    layout();
    pipWindow.show();
    gameView.webContents.focus();
    normalWindow.hide();
  } catch (error) {
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipWindow.contentView.removeChildView(gameView);
      normalWindow.contentView.addChildView(gameView);
      pipWindow.destroy();
    }
    pipWindow = null; pipBar = null;
    layout();
    normalWindow.show();
    throw error;
  } finally {
    moving = false;
  }
}

function restoreNormal() {
  if (!pipWindow || moving) return;
  moving = true;
  try {
    const old = pipWindow;
    lastPiPBounds = old.getBounds();
    old.contentView.removeChildView(gameView);
    normalWindow.contentView.addChildView(gameView);
    pipWindow = null;
    layout();
    normalWindow.show();
    normalWindow.focus();
    pipBar.webContents.close();
    pipBar = null;
    old.destroy();
    saveBounds();
  } finally {
    moving = false;
  }
}

// รายชื่อจอภาพ ให้ console เลือกจอสำหรับจัดเรียง
function displays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, primary: d.id === primary,
    label: `${d.label || 'จอ ' + (i + 1)} (${d.size.width}×${d.size.height})`,
  }));
}

// จัดหน้าต่างนี้ลงช่องที่ i (จากทั้งหมด n ช่อง) ในตารางเต็มจอภาพ d (ไม่ระบุ/หาไม่เจอ = จอหลัก)
// เลือกจำนวนคอลัมน์ที่ทำให้ภาพเกม (16:9) ใหญ่ที่สุด
async function tile(params) {
  const n = Number(params.get('n')), i = Number(params.get('i'));
  if (!Number.isInteger(n) || !Number.isInteger(i) || n < 1 || n > 50 || i < 0 || i >= n) throw new Error('invalid tile slot');
  if (moving || hidden) return;
  if (pipWindow) restoreNormal();
  if (normalWindow.isFullScreen()) {
    await new Promise((resolve) => { normalWindow.once('leave-full-screen', resolve); normalWindow.setFullScreen(false); setTimeout(resolve, 1000); });
  }
  if (normalWindow.isMinimized()) normalWindow.restore();
  if (normalWindow.isMaximized()) normalWindow.unmaximize();
  const display = screen.getAllDisplays().find((d) => String(d.id) === params.get('d')) || screen.getPrimaryDisplay();
  const area = display.workArea;
  let cols = 1, best = 0;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const scale = Math.min(area.width / c / REF_W, area.height / r / REF_H);
    if (scale > best) { best = scale; cols = c; }
  }
  const rows = Math.ceil(n / cols);
  const col = i % cols, row = Math.floor(i / cols);
  const x = area.x + Math.floor((col * area.width) / cols), y = area.y + Math.floor((row * area.height) / rows);
  normalWindow.setBounds({
    x, y,
    width: area.x + Math.floor(((col + 1) * area.width) / cols) - x,
    height: area.y + Math.floor(((row + 1) * area.height) / rows) - y,
  });
  normalWindow.show();
  saveBounds();
}

// --- กู้คืนอัตโนมัติ: เกมแครช / ค้างเกิน 30 วิ / โหลดไม่สำเร็จ (เน็ตหลุด) ---
// ติดตั้ง shim ก่อนสคริปต์เกมรัน (ผ่าน CDP) เพื่อให้เกมคิดว่าหน้าต่างยังมองเห็นอยู่ — ทำใหม่ทุกครั้งที่ renderer ใหม่
async function loadGame() {
  const wc = gameView.webContents;
  clearTimeout(retryTimer);
  await wc.loadURL('about:blank');
  if (wc.debugger.isAttached()) wc.debugger.detach();
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Page.enable');
  await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: fs.readFileSync(path.join(__dirname, 'visibility-spoof.js'), 'utf8'),
  });
  await wc.loadURL(gameUrl).catch(() => {}); // โหลดไม่สำเร็จ → did-fail-load จัดการลองใหม่
}

function recover(reason) {
  if (quitting || recovering || !gameView || gameView.webContents.isDestroyed()) return;
  recovering = true;
  recoveries++;
  console.log(`[${title}] กู้คืน (${reason}) ครั้งที่ ${recoveries}`);
  setTimeout(() => loadGame().catch(() => scheduleRetry()).finally(() => { recovering = false; }), 3000);
}

function scheduleRetry() {
  if (quitting) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => recover('โหลดไม่สำเร็จ'), RETRY_MS);
}

function watchHealth(wc) {
  wc.on('render-process-gone', (_e, details) => recover('renderer ' + details.reason));
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url.startsWith(gameUrl)) scheduleRetry(); // -3 = ERR_ABORTED (ถูกแทนด้วยการโหลดใหม่)
  });
  // ตรวจเกมค้าง: ถามหน้าเว็บทุก 5 วิ ถ้าไม่ตอบเกิน 30 วิ → ปิด renderer แล้วกู้คืน
  // (event 'unresponsive' ของ Electron จับได้เฉพาะตอนมีคนคลิก/พิมพ์ — จอ AFK ที่ซ่อนอยู่จะไม่มี)
  setInterval(() => {
    if (wc.isDestroyed() || recovering || wc.isLoading()) { lastPong = Date.now(); return; }
    if (Date.now() - lastPong > HANG_MS) {
      lastPong = Date.now();
      wc.forcefullyCrashRenderer(); // → render-process-gone → recover()
      return;
    }
    wc.executeJavaScript('1').then(() => { lastPong = Date.now(); }, () => {});
  }, 5000);
}

// กดปุ่มคีย์บอร์ด 1 ครั้งในหน้าเกม ผ่าน CDP (debugger ที่ต่อไว้แล้วใน loadGame)
// ใช้ได้แม้หน้าต่างไม่ได้โฟกัสหรือซ่อนอยู่ · จำกัดเฉพาะตัวอักษร ตัวเลข และปุ่มพื้นฐาน — ไม่รับโค้ดอิสระ
const NAMED_KEYS = {
  Space: [' ', 'Space', 32], Enter: ['Enter', 'Enter', 13], Escape: ['Escape', 'Escape', 27], Tab: ['Tab', 'Tab', 9],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
};
async function pressKey(params) {
  const k = params.get('k') || '';
  let key, code, vk;
  if (/^[a-z]$/i.test(k)) [key, code, vk] = [k.toLowerCase(), 'Key' + k.toUpperCase(), k.toUpperCase().charCodeAt(0)];
  else if (/^\d$/.test(k)) [key, code, vk] = [k, 'Digit' + k, k.charCodeAt(0)];
  else if (Object.hasOwn(NAMED_KEYS, k)) [key, code, vk] = NAMED_KEYS[k];
  else throw new Error('invalid key');
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error('เกมยังโหลดไม่เสร็จ');
  const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined;
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...base });
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// คลิกซ้าย 1 ครั้งที่ตำแหน่ง (x, y) เป็น CSS px ของหน้าเกม ผ่าน CDP — ใช้ได้แม้หน้าต่างซ่อน/ไม่ได้โฟกัส
// หาปุ่ม/องค์ประกอบในหน้าเกมจาก id (อ่านอย่างเดียว ไม่แก้หน้าเกม) — คืนข้อความ ตำแหน่งกึ่งกลาง (CSS px) และว่ามองเห็นอยู่ไหม
// ไว้ทำ automation ที่คลิกปุ่ม HTML ในเกม (ยังไม่มีคำสั่งที่ใช้ — รอสำรวจหน้าเกม Aetheria)
async function findElement(id) {
  if (!/^[\w-]{1,64}$/.test(id || '')) throw new Error('invalid element id');
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed()) throw new Error('เกมยังไม่พร้อม');
  return wc.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return { found: false };
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    // ไม่ใช้ offsetParent: องค์ประกอบ position:fixed มี offsetParent = null แม้แสดงอยู่ (เคยทำให้ตรวจหน้าประหยัดพลังงานผิด)
    const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
      && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    return { found: true, visible, text: el.textContent.trim().slice(0, 100), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

async function clickAt(params) {
  const x = Number(params.get('x')), y = Number(params.get('y'));
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error('เกมยังโหลดไม่เสร็จ');
  const [w, h] = await wc.executeJavaScript('[innerWidth, innerHeight]');
  if (!(x >= 0 && y >= 0 && x < w && y < h)) throw new Error('ตำแหน่งคลิกอยู่นอกหน้าเกม');
  const send = (type, extra) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra });
  await send('mouseMoved', {});
  await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
  await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
}

let globalHide = false;
function installShortcuts(contents) {
  contents.setIgnoreMenuShortcuts(true);
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const key = input.key.toLowerCase();
    const plain = !input.control && !input.alt && !input.shift && !input.meta;
    const cs = input.control && input.shift && !input.alt;
    let action;
    if (key === 'f5' && plain) action = refresh;
    else if (key === 'f8' || (key === 'g' && cs && !globalHide)) action = toggleHidden;
    else if (key === 'f11' || (key === 'enter' && input.alt && !input.control)) action = toggleFullscreen;
    else if (key === 'p' && cs) action = togglePiP;
    else if (key === 'i' && cs) action = () => gameView.webContents.toggleDevTools(); // เหมือนตัวทางการ (ไว้ดูปัญหา)
    else if (key === 'escape' && (pipWindow || normalWindow.isFullScreen())) action = () => (pipWindow ? restoreNormal() : normalWindow.setFullScreen(false));
    if (!action) return;
    event.preventDefault();
    Promise.resolve(action()).catch(() => {});
  });
}

// Ctrl+Shift+G ซ่อน/เรียกกลับทุกจอ (Lumivara ใช้ Ctrl+Shift+H — แยกคีย์ไม่ให้จองชนกัน): จอแรกที่จองคีย์ได้จะส่งต่อให้ launcher สั่งทุกจอ
// ponytail: ถ้าจอที่จองคีย์ปิดไป จอที่เหลือจะลองจองใหม่ทุก 5 วินาที
function registerGlobalHide() {
  if (globalHide) return;
  globalHide = globalShortcut.register('Control+Shift+G', () => {
    const req = http.request({ host: '127.0.0.1', port: launcherPort, path: '/toggle-all', method: 'POST', headers: { 'X-Aetheria': '1' } });
    req.on('error', toggleHidden); // launcher ปิดอยู่ → ซ่อนเฉพาะจอนี้
    req.end();
  });
}

// "เข้าสู่ระบบด้วย Google" (จากตัวทางการ): Google ไม่ยอมให้ล็อกอินในเบราว์เซอร์ฝังในแอป
// ปุ่ม Google ในเกมเรียก window.aetheriaDesktop.googleLogin() (preload.cjs) → เปิดหน้า /desktop-login ในเบราว์เซอร์ของผู้เล่น
// พร้อมพอร์ต + state ครั้งเดียว → หน้านั้นส่ง token ล็อกอินเกมกลับมาที่ http://127.0.0.1:<port>/done → คืนให้เกม
// แต่ละจอมีเซิร์ฟเวอร์ชั่วคราวของตัวเอง (พอร์ตสุ่ม) — ล็อกอินหลายจอพร้อมกันไม่ปนกัน
const LOGIN_PAGE = new URL('/desktop-login', gameUrl).href;
const LOGIN_WAIT_MS = 5 * 60_000;
const LOGIN_HTML = (ok) => `<body style="background:#0e1424;color:#e5e7eb;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${ok ? 'เข้าสู่ระบบสำเร็จ' : 'เข้าสู่ระบบไม่สำเร็จ'}</h2><p>${ok ? 'กลับไปที่หน้าต่างเกมได้เลย ปิดแท็บนี้ได้' : 'ลองกดเข้าสู่ระบบด้วย Google ในเกมอีกครั้ง'}</p></div></body>`;
let pendingLogin = null;
function googleLogin() {
  if (pendingLogin) {
    shell.openExternal(pendingLogin.url); // กดซ้ำ: เปิดหน้าเดิมอีกครั้ง
    return pendingLogin.promise;
  }
  const loginState = crypto.randomBytes(24).toString('hex');
  let server;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('หมดเวลาเข้าสู่ระบบด้วย Google ลองใหม่อีกครั้ง')), LOGIN_WAIT_MS);
    function finish(err, token) {
      clearTimeout(timer);
      server.close();
      pendingLogin = null;
      focus();
      if (err) reject(err); else resolve(token);
    }
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/done' || u.searchParams.get('state') !== loginState) { res.writeHead(404).end(); return; }
      const token = u.searchParams.get('token') || '';
      const ok = /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_HTML(ok));
      finish(ok ? null : new Error('เข้าสู่ระบบด้วย Google ไม่สำเร็จ'), token);
    });
    server.listen(0, '127.0.0.1', () => {
      const url = `${LOGIN_PAGE}?port=${server.address().port}&state=${loginState}`;
      pendingLogin = { url, promise };
      shell.openExternal(url);
    });
  });
  return promise;
}

const actions = {
  pip: togglePiP, fullscreen: toggleFullscreen, refresh, mute: toggleMute, muteSet: setMute, focus,
  hide: () => setHidden(true), show: focus, toggleHide: toggleHidden, quit: () => app.quit(), tile,
  title: setTitle, fps: setFps, key: pressKey, click: clickAt,
};

function startControlServer() {
  http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    // header พิเศษบังคับ CORS preflight และเช็ค Host กัน DNS rebinding — เว็บอื่นในเบราว์เซอร์สั่งไม่ได้
    if (req.headers['x-aetheria'] !== '1' || !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return send(403, { ok: false });
    if (req.method === 'GET' && req.url === '/state') return send(200, state());
    if (req.method === 'GET' && req.url === '/displays') return send(200, displays());
    if (req.method === 'GET' && /^\/element(\?|$)/.test(req.url)) {
      try {
        return send(200, await findElement(new URL(req.url, 'http://127.0.0.1').searchParams.get('id')));
      } catch (err) {
        return send(400, { ok: false, error: String(err.message || err) });
      }
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const m = url.pathname.match(/^\/action\/(\w+)$/);
    if (req.method !== 'POST' || !m || !Object.hasOwn(actions, m[1])) return send(404, { ok: false, error: 'not found' });
    try {
      await actions[m[1]](url.searchParams);
      send(200, { ok: true, state: state() });
    } catch (err) {
      send(500, { ok: false, error: String(err.message || err) });
    }
  }).on('error', (err) => {
    dialog.showErrorBox(title, `เปิดพอร์ตควบคุม ${controlPort} ไม่ได้ — หน้าเว็บจะคุมจอนี้ไม่ได้: ${err.message}`);
  }).listen(controlPort, '127.0.0.1');
}

async function createApp() {
  const gameSession = session.defaultSession; // เหมือนตัวทางการ — โฟลเดอร์ข้อมูลของตัวทางการใช้เป็นจอหนึ่งได้
  const saved = loadBounds();
  if (onScreen(saved.pip)) lastPiPBounds = saved.pip;
  const normal = onScreen(saved.normal) ? saved.normal : { width: 1280, height: 720 };
  normalWindow = new BaseWindow({
    icon: gameIcon, title: windowTitle(), ...normal, minWidth: 320, minHeight: 240,
    autoHideMenuBar: true, backgroundColor: '#0e1424', show: false,
  });
  normalWindow.setMenu(null);
  if (saved.maximized) normalWindow.maximize();
  if (!process.argv.includes('--lv-pip')) normalWindow.show();
  for (const ev of ['resize', 'enter-full-screen', 'leave-full-screen']) normalWindow.on(ev, layout);
  for (const ev of ['resized', 'moved', 'maximize', 'unmaximize']) normalWindow.on(ev, saveBounds);
  normalWindow.on('close', saveBounds);
  normalWindow.on('closed', () => app.quit());

  gameView = new WebContentsView({ webPreferences: { session: gameSession, backgroundThrottling: false, sandbox: true, preload: path.join(__dirname, 'preload.cjs') } });
  gameView.webContents.setZoomMode?.('isolated'); // Electron 33 (runtime ของ Aetheria) ไม่มี — zoom แยกต่อโปรเซสอยู่แล้ว
  gameView.webContents.setAudioMuted(userMuted); // เปิดจอมาแบบปิดเสียงไว้ก่อน
  installShortcuts(gameView.webContents);
  watchHealth(gameView.webContents);
  normalWindow.contentView.addChildView(gameView);
  layout();

  gameView.webContents.on('page-title-updated', (e) => e.preventDefault());
  gameView.webContents.on('did-finish-load', () => {
    layout();
    applyFrameRate();
    if (gameView.webContents.getURL().startsWith(gameUrl)) loads++;
  });
  // เหมือนตัวทางการ: ลิงก์ไปเว็บอื่น (Discord, หน้าชำระเงิน ฯลฯ) เปิดในเบราว์เซอร์ · หน้าในเว็บเกมเปิดในหน้าต่างนี้
  gameView.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (isGameSite(new URL(url).host)) gameView.webContents.loadURL(url);
      else if (/^https?:/.test(url)) shell.openExternal(url);
    } catch { /* URL เสีย */ }
    return { action: 'deny' };
  });
  gameView.webContents.on('will-navigate', (e, url) => {
    let host = '';
    try { host = new URL(url).host; } catch { /* URL เสีย */ }
    if (isGameSite(host)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  if (process.argv.includes('--lv-pip')) {
    gameView.webContents.once('did-finish-load', () => Promise.resolve(togglePiP()).catch(() => normalWindow.show()));
  }
  await loadGame();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focus);
  app.on('before-quit', () => { quitting = true; clearTimeout(retryTimer); });
  app.whenReady().then(() => {
    powerSaveBlocker.start('prevent-app-suspension');
    startControlServer();
    ipcMain.handle('google-login', () => googleLogin());
    registerGlobalHide();
    setInterval(registerGlobalHide, 5000).unref();
    return createApp();
  }).catch((error) => {
    console.error('เปิดเกมไม่สำเร็จ:', error);
    app.quit();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
