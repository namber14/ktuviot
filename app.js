// כתוביות מהירות: המסכים והזרימה. הכול רץ בתוך הטלפון, בלי שרת.
import * as store from './store.js';
import * as cap from './captions.js';
import { readInfo, extractAudio16k, makeThumbs, exportVideo } from './media.js';

const MODEL_BASE = 'models/';
const app = document.getElementById('app');
const layer = document.getElementById('layer');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  back: svg('<path d="M9 6l6 6-6 6"/>'),
  go: svg('<path d="M15 6l-6 6 6 6"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>'),
  pencil: svg('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'),
  scissors: svg('<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5L20 18M8 15.5L20 6"/>'),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'),
  share: svg('<circle cx="6" cy="12" r="2.5"/><circle cx="17" cy="6" r="2.5"/><circle cx="17" cy="18" r="2.5"/><path d="M8.2 10.9l6.6-3.7M8.2 13.1l6.6 3.7"/>'),
};

const S = {
  view: 'home', projects: [], dict: [],
  engine: { state: 'idle', pct: 0, threads: 1 },
  p: null, file: null, url: null, sel: -1, now: -1, ranges: [],
  busy: null, result: null,
};
window.__kt = S; // לבדיקות

// ---------- מנוע התמלול ----------
let worker = null, jobId = 0;
const jobs = new Map();

function startEngine() {
  if (worker) return;
  worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'model') setEngine({ state: 'loading', pct: data.loaded / data.total });
    else if (data.type === 'ready') setEngine({ state: 'ready', pct: 1, threads: data.threads });
    else if (data.type === 'progress') jobs.get(data.id)?.onProgress?.(data.p);
    else if (data.type === 'result') { jobs.get(data.id)?.resolve(data); jobs.delete(data.id); }
    else if (data.type === 'error') {
      const job = jobs.get(data.id);
      if (job) { job.reject(new Error(data.message)); jobs.delete(data.id); }
      setEngine({ state: 'error', message: data.message });
    }
  };
  worker.onerror = e => setEngine({ state: 'error', message: e.message || 'מנוע התמלול לא עלה' });
  worker.postMessage({ type: 'load', modelBase: MODEL_BASE });
}

function setEngine(patch) {
  S.engine = { ...S.engine, ...patch };
  const el = document.getElementById('engine');
  if (el) el.innerHTML = engineHtml();
  if (S.busy?.stage === 'asr' && S.engine.state === 'loading') {
    setBusy({ title: 'מוריד את מנוע התמלול', detail: 'פעם אחת בלבד, 72 מגה. אחר כך הוא נשאר בטלפון.', pct: S.engine.pct });
  }
}

function transcribe(samples, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ type: 'transcribe', id, samples, modelBase: MODEL_BASE }, [samples.buffer]);
  });
}

// ---------- עזרים ----------
const seconds = ms => (ms / 1000).toFixed(ms < 10000 ? 1 : 0);
const megs = bytes => (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0);

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (days === 0) return 'היום';
  if (days === 1) return 'אתמול';
  return `${d.getDate()}.${d.getMonth() + 1}`;
}

async function wake() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

let toastTimer = null;
function toast(text, action) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button" data-act="toast-action">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  toast.action = action?.run ?? null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toast.action = null; }, action ? 9000 : 5000);
}

function setBusy(patch) {
  S.busy = { ...(S.busy ?? {}), ...patch };
  const b = S.busy;
  let el = document.getElementById('busy');
  if (!el) {
    layer.insertAdjacentHTML('beforeend', `<div id="busy" class="cover" role="status" aria-live="polite">
      <div class="busybox"><h2></h2><p></p><div class="bar"><i></i></div><b class="pct"></b>
      <button type="button" class="ghost" data-act="busy-cancel" hidden>ביטול</button></div></div>`);
    el = document.getElementById('busy');
  }
  el.querySelector('h2').textContent = b.title ?? '';
  el.querySelector('p').textContent = b.detail ?? '';
  const known = typeof b.pct === 'number';
  el.querySelector('.bar').classList.toggle('wait', !known);
  el.querySelector('.bar i').style.width = known ? Math.round(b.pct * 100) + '%' : '';
  el.querySelector('.pct').textContent = known ? Math.round(b.pct * 100) + '%' : '';
  el.querySelector('[data-act="busy-cancel"]').hidden = !b.cancel;
}
function clearBusy() { S.busy = null; document.getElementById('busy')?.remove(); }

function showError(err) {
  console.error(err);
  const msg = err?.code ? err.message : (err?.message || 'משהו השתבש.');
  layer.insertAdjacentHTML('beforeend', `<div class="cover" id="err" role="alertdialog" aria-labelledby="err-t">
    <div class="busybox"><h2 id="err-t">זה לא הצליח</h2><p>${esc(msg)}</p>
    <button type="button" class="solid" data-act="err-close">הבנתי</button></div></div>`);
}

// ---------- מסך הפתיחה ----------
function engineHtml() {
  const e = S.engine;
  if (e.state === 'loading') return `<span>מכין את מנוע התמלול · <bdi>${Math.round(e.pct * 100)}%</bdi></span>`;
  if (e.state === 'error') return `<span>מנוע התמלול לא נטען. <button type="button" class="link" data-act="engine-retry">לנסות שוב</button></span>`;
  return '';
}

function renderHome() {
  const rows = S.projects.map(p => `
    <div class="row">
      <button type="button" class="rowmain" data-act="open" data-id="${p.id}">
        <span class="th"${p.thumbs?.[0] ? ` style="background-image:url(${p.thumbs[0]})"` : ''}></span>
        <span class="meta"><b>${esc(p.name)}</b><small><bdi>${cap.formatTime(cap.totalKept(cap.keepRanges(p)))}</bdi> · ${dayLabel(p.updatedAt)}</small></span>
        ${I.go}
      </button>
      <button type="button" class="icon" data-act="delete" data-id="${p.id}" aria-label="מחיקת ${esc(p.name)}">${I.trash}</button>
    </div>`).join('');
  app.innerHTML = `<div class="screen home">
    <header class="bar"><h1>כתוביות מהירות</h1>
      <button type="button" class="icon" data-act="dict" aria-label="המילון שלי">${I.gear}</button></header>
    <main class="hero">
      <button type="button" class="plus" data-act="pick" aria-label="סרטון חדש">${I.plus}</button>
      <b>סרטון חדש</b><span>מהגלריה או מהמצלמה</span>
      <p id="engine" class="engine">${engineHtml()}</p>
    </main>
    <section class="recent"><h2>אחרונים</h2>
      ${rows || ''}<p class="empty">${rows ? 'כל סרטון שתערוך יחכה כאן.' : 'עוד אין סרטונים. כל סרטון שתערוך יחכה כאן, לתיקון או לשמירה חוזרת.'}</p>
    </section>
    <input type="file" id="pick" accept="video/*" hidden>
  </div>`;
}

async function goHome() {
  closeEditor();
  S.view = 'home';
  S.projects = await store.listProjects();
  renderHome();
}

// ---------- סרטון חדש ----------
async function startNew(file) {
  const lock = await wake();
  try {
    setBusy({ title: 'קורא את הסרטון', detail: '', pct: null, stage: 'read', cancel: null });
    const info = await readInfo(file);
    setBusy({ title: 'מוציא את הקול מהסרטון', pct: 0, stage: 'audio' });
    const t0 = performance.now();
    const samples = await extractAudio16k(file, pct => setBusy({ pct }));
    const audioMs = Math.round(performance.now() - t0);
    const thumbsReady = makeThumbs(file, 10, info.duration).catch(() => []);
    const ready = S.engine.state === 'ready';
    setBusy({ title: ready ? 'כותב כתוביות' : 'מכין את מנוע התמלול', detail: '', pct: ready ? 0 : null, stage: 'asr' });
    const res = await transcribe(samples.slice(), pct => setBusy({ title: 'כותב כתוביות', detail: '', pct }));
    const fixed = cap.applyDictionary(res.words, S.dict);
    const lines = cap.buildLines(fixed.words);
    if (!lines.length) throw Object.assign(new Error('לא שמעתי דיבור בסרטון הזה, אז אין כתוביות לכתוב.'), { code: 'SILENT' });
    setBusy({ title: 'עוד רגע', pct: null, stage: 'save' });
    const p = {
      id: 'p' + Date.now().toString(36),
      name: lines[0].text.split(' ').slice(0, 4).map(cap.bare).join(' '),
      createdAt: Date.now(), updatedAt: Date.now(),
      duration: info.duration, width: info.width, height: info.height,
      lines, trim: { s: 0, e: info.duration },
      thumbs: (await thumbsReady).filter(Boolean),
      stats: { audioMs, asrMs: res.ms, threads: res.threads, fixes: fixed.fixes },
    };
    await store.putFile(p.id, file);
    await store.saveProject(p);
    await store.prune();
    openProject(p, file);
    toast(`הכתוביות מוכנות. התמלול לקח ${seconds(res.ms)} שניות${fixed.fixes ? `, ו־${fixed.fixes} מילים תוקנו מהמילון` : ''}.`);
  } catch (err) { showError(err); } finally { clearBusy(); lock?.release?.(); }
}

// ---------- מסך העריכה ----------
let video = null, raf = 0, saveTimer = 0;

function closeEditor() {
  cancelAnimationFrame(raf);
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); video = null; }
  if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
  S.p = null; S.file = null; S.sel = -1; S.now = -1;
}

function persist() {
  clearTimeout(saveTimer);
  const p = S.p;
  saveTimer = setTimeout(() => p && store.saveProject(p), 250);
}

function openProject(p, file) {
  closeEditor();
  S.p = p; S.file = file; S.url = URL.createObjectURL(file);
  S.view = 'edit'; S.sel = -1; S.now = -1;
  S.ranges = cap.keepRanges(p);
  renderEdit();
}

function doubtsCount() { return S.p.lines.reduce((a, l) => a + (l.cut ? 0 : l.doubts.length), 0); }

function lineHtml(l, i) {
  const words = l.text.split(' ');
  const text = words.map((w, k) => (l.doubts.includes(k) ? `<mark>${esc(w)}</mark>` : esc(w))).join(' ');
  const sel = i === S.sel;
  return `<div class="line${sel ? ' sel' : ''}${i === S.now ? ' now' : ''}${l.cut ? ' cut' : ''}" data-i="${i}" role="listitem">
    <button type="button" class="ltext" data-act="select" data-i="${i}">${text}</button>
    ${sel ? `<div class="acts">
      <button type="button" data-act="edit" data-i="${i}">${I.pencil}תיקון</button>
      <button type="button" data-act="cut" data-i="${i}">${I.scissors}${l.cut ? 'להחזיר את הקטע' : 'לחתוך את הקטע'}</button>
    </div>` : ''}
  </div>`;
}

function renderLines() {
  const box = app.querySelector('.lines');
  if (!box) return;
  const n = doubtsCount();
  box.innerHTML = `<p class="doubts">${n ? `<bdi>${n}</bdi> ${n === 1 ? 'מילה מסומנת' : 'מילים מסומנות'} לבדיקה. נוגעים בשורה כדי לתקן.` : 'נוגעים בשורה כדי לתקן או לחתוך אותה.'}</p>`
    + S.p.lines.map(lineHtml).join('');
}

function renderStrip() {
  const strip = app.querySelector('.strip');
  if (!strip) return;
  const p = S.p, pct = t => (t / p.duration) * 100;
  const shades = [];
  if (p.trim.s > 0) shades.push([0, p.trim.s]);
  if (p.trim.e < p.duration) shades.push([p.trim.e, p.duration]);
  p.lines.forEach((l, i) => { if (l.cut) { const s = cap.lineSlot(p.lines, i, p.duration); shades.push([Math.max(s.s, p.trim.s), Math.min(s.e, p.trim.e)]); } });
  strip.querySelector('.shades').innerHTML = shades.filter(([a, b]) => b > a)
    .map(([a, b]) => `<i style="left:${pct(a)}%;width:${pct(b - a)}%"></i>`).join('');
  strip.querySelector('.hs').style.left = pct(p.trim.s) + '%';
  strip.querySelector('.he').style.left = pct(p.trim.e) + '%';
  const sug = cap.suggestTrim(p.lines, p.duration);
  const trimmed = p.trim.s > 0 || p.trim.e < p.duration;
  const note = app.querySelector('.trimnote');
  const saved = sug ? sug.s + (p.duration - sug.e) : 0;
  note.innerHTML = `${trimmed
    ? '<button type="button" class="link" data-act="trim-reset">הקצוות נחתכו · לבטל</button>'
    : sug ? `<button type="button" class="link" data-act="trim-suggest">הצעה: לחתוך <bdi>${saved.toFixed(1)}</bdi> שניות ריקות בקצוות</button>` : '<span>גוררים את הקצוות כדי לחתוך</span>'}
    <bdi>${cap.formatTime(cap.totalKept(S.ranges))}</bdi>`;
}

function changed() {
  S.ranges = cap.keepRanges(S.p);
  renderLines(); renderStrip(); sync(true); persist();
}

function layoutCaption() {
  const stage = app.querySelector('.stage');
  if (!stage || !S.p) return;
  // הסרטון ממלא את הרוחב. סרטון עומד גבוה מהחלון, אז מזיזים אותו כך שהפנים והכתובית נשארים בתמונה.
  const box = stage.getBoundingClientRect(), ar = S.p.width / S.p.height;
  const st = cap.CAPTION_STYLE, w = box.width, h = w / ar;
  const top = h <= box.height ? (box.height - h) / 2 : Math.min(0, Math.max(box.height - h, box.height * 0.88 - h * st.centerY));
  const v = stage.querySelector('video');
  v.style.top = top + 'px'; v.style.height = h + 'px';
  const c = stage.querySelector('.cap'), fs = w * st.sizeRatio;
  c.style.width = w * st.maxWidth + 'px';
  c.style.left = (w * (1 - st.maxWidth)) / 2 + 'px';
  c.style.top = top + h * st.centerY + 'px';
  c.style.fontSize = fs + 'px';
  c.style.webkitTextStrokeWidth = fs * st.strokeRatio + 'px';
}

function sync(force) {
  if (!video || !S.p) return;
  const p = S.p, ranges = S.ranges;
  let t = video.currentTime;
  if (ranges.length && !ranges.some(r => t >= r.s - 0.02 && t < r.e)) {
    const next = ranges.find(r => r.s > t);
    if (next) { video.currentTime = next.s; t = next.s; }
    else { video.pause(); video.currentTime = ranges[0].s; t = ranges[0].s; }
  }
  const i = cap.lineIndexAt(p.lines, t);
  const capEl = app.querySelector('.cap');
  const text = i >= 0 ? p.lines[i].text : '';
  if (capEl.textContent !== text) capEl.textContent = text;
  if (i !== S.now || force) {
    S.now = i;
    app.querySelectorAll('.line.now').forEach(el => el.classList.remove('now'));
    const el = i >= 0 ? app.querySelector(`.line[data-i="${i}"]`) : null;
    if (el) { el.classList.add('now'); if (!video.paused && S.sel < 0) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  const out = cap.toOutputTime(ranges, t);
  app.querySelector('.time bdi').textContent = `${cap.formatTime(Math.max(0, out))} / ${cap.formatTime(cap.totalKept(ranges))}`;
  app.querySelector('.playhead').style.left = (t / p.duration) * 100 + '%';
  app.querySelector('.playbtn').hidden = !video.paused;
}

function loop() { sync(); if (video && !video.paused) raf = requestAnimationFrame(loop); }

function renderEdit() {
  const p = S.p;
  const thumbs = (p.thumbs?.length ? p.thumbs : []).map(t => `<img src="${t}" alt="">`).join('');
  app.innerHTML = `<div class="screen edit">
    <header class="bar">
      <button type="button" class="icon" data-act="home" aria-label="חזרה">${I.back}</button>
      <h1>${esc(p.name)}</h1><span class="time"><bdi>0:00 / 0:00</bdi></span>
    </header>
    <div class="stage">
      <video playsinline preload="auto" src="${S.url}"></video>
      <div class="cap" dir="rtl"></div>
      <button type="button" class="playbtn" data-act="play" aria-label="ניגון">${I.play}</button>
    </div>
    <div class="lines" role="list"></div>
    <footer class="foot">
      <div class="strip" dir="ltr">
        <div class="thumbs">${thumbs}</div><div class="shades"></div>
        <i class="playhead"></i>
        <button type="button" class="handle hs" data-h="s" aria-label="תחילת הסרטון"></button>
        <button type="button" class="handle he" data-h="e" aria-label="סוף הסרטון"></button>
      </div>
      <div class="trimnote"></div>
      <button type="button" class="save" data-act="export">שמירה לגלריה</button>
    </footer>
  </div>`;
  video = app.querySelector('video');
  video.addEventListener('loadedmetadata', () => { layoutCaption(); sync(true); });
  video.addEventListener('play', () => { cancelAnimationFrame(raf); loop(); });
  video.addEventListener('pause', () => sync());
  video.addEventListener('seeked', () => sync());
  video.addEventListener('click', togglePlay);
  bindStrip(app.querySelector('.strip'));
  renderLines(); renderStrip(); layoutCaption();
  document.fonts.load(`700 20px ${cap.CAPTION_FONT}`, 'אב');
}

function togglePlay() {
  if (!video) return;
  if (video.paused) { if (S.sel >= 0) { S.sel = -1; renderLines(); } video.play().catch(() => {}); }
  else video.pause();
}

function bindStrip(strip) {
  let drag = null;
  const timeAt = x => { const r = strip.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)) * S.p.duration; };
  strip.addEventListener('pointerdown', e => {
    const h = e.target.closest('.handle');
    drag = h ? h.dataset.h : 'seek';
    strip.setPointerCapture(e.pointerId);
    move(e);
  });
  const move = e => {
    if (!drag) return;
    const t = timeAt(e.clientX), p = S.p;
    if (drag === 'seek') { video.currentTime = t; return; }
    if (drag === 's') p.trim.s = Math.max(0, Math.min(t, p.trim.e - 0.5));
    else p.trim.e = Math.min(p.duration, Math.max(t, p.trim.s + 0.5));
    S.ranges = cap.keepRanges(p);
    renderStrip();
    video.currentTime = drag === 's' ? p.trim.s : Math.max(p.trim.s, p.trim.e - 0.05);
  };
  strip.addEventListener('pointermove', move);
  const end = () => { if (drag && drag !== 'seek') { changed(); } drag = null; };
  strip.addEventListener('pointerup', end);
  strip.addEventListener('pointercancel', end);
}

// ---------- תיקון שורה ----------
function openEdit(i) {
  video?.pause();
  document.getElementById('toast').hidden = true;
  const l = S.p.lines[i];
  layer.insertAdjacentHTML('beforeend', `<div class="cover sheetwrap" id="sheet">
    <form class="sheet" data-i="${i}">
      <label for="edit-text">תיקון השורה</label>
      <textarea id="edit-text" rows="2" dir="rtl" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(l.text)}</textarea>
      <div class="sheetrow">
        <button type="button" class="ghost" data-act="sheet-close">ביטול</button>
        <button type="submit" class="solid">שמירה</button>
      </div>
    </form></div>`);
  const ta = document.getElementById('edit-text');
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

function submitEdit(form) {
  const i = Number(form.dataset.i), l = S.p.lines[i];
  const before = l.text, after = form.querySelector('textarea').value.replace(/\s+/g, ' ').trim();
  document.getElementById('sheet')?.remove();
  cap.editLine(l, after);
  changed();
  const learned = before !== l.text ? cap.diffPhrase(before, l.text) : null;
  if (learned && !S.dict.some(d => d.from === learned.from)) {
    toast(`לזכור לתמיד? "${learned.from}" ← "${learned.to}"`, {
      label: 'לזכור',
      run: async () => { S.dict = [...S.dict, learned]; await store.setDict(S.dict); toast('נשמר במילון. בפעם הבאה זה ייכתב נכון לבד.'); },
    });
  }
}

// ---------- שמירה: צריבה ותוצאה ----------
let abort = null;

async function doExport() {
  if (!S.ranges.length) { toast('לא נשאר מה לשמור. החזר קטע אחד לפחות.'); return; }
  video?.pause();
  const lock = await wake();
  abort = new AbortController();
  setBusy({ title: 'צורב את הכתוביות על הסרטון', detail: 'אפשר להשאיר את המסך פתוח. זה נעשה בתוך הטלפון.', pct: 0, stage: 'export', cancel: () => abort.abort() });
  const t0 = performance.now();
  try {
    const res = await exportVideo(S.file, S.p, S.ranges, pct => setBusy({ pct }), abort.signal);
    const ms = Math.round(performance.now() - t0);
    S.p.stats = { ...S.p.stats, exportMs: ms };
    persist();
    S.result = { ...res, ms, url: URL.createObjectURL(res.blob), name: `${S.p.name} - כתוביות.mp4` };
    renderResult();
  } catch (err) { if (err?.code !== 'CANCELED') showError(err); } finally { clearBusy(); lock?.release?.(); abort = null; }
}

function renderResult() {
  const r = S.result;
  const file = new File([r.blob], r.name, { type: 'video/mp4' });
  const canShare = !!navigator.canShare?.({ files: [file] });
  layer.insertAdjacentHTML('beforeend', `<div class="cover result" id="result">
    <header class="bar"><button type="button" class="icon" data-act="result-close" aria-label="חזרה לעריכה">${I.back}</button><h1>הסרטון מוכן</h1><span></span></header>
    <div class="rvid"><video controls playsinline src="${r.url}"></video></div>
    <div class="rfoot">
      <p><bdi>${cap.formatTime(r.duration)}</bdi> · <bdi>${megs(r.blob.size)}</bdi> מגה · הצריבה לקחה <bdi>${seconds(r.ms)}</bdi> שניות</p>
      <a class="save" href="${r.url}" download="${esc(r.name)}" data-act="saved">שמירה לגלריה</a>
      ${canShare ? `<button type="button" class="ghost wide" data-act="share">${I.share}שיתוף לוואטסאפ ולרשתות</button>` : ''}
      <small>הסרטון נשמר בתיקיית ההורדות של הטלפון, ומשם הוא מופיע גם בגלריה.</small>
    </div></div>`);
}

function closeResult() {
  document.getElementById('result')?.remove();
  if (S.result) { URL.revokeObjectURL(S.result.url); S.result = null; }
}

// ---------- המילון ----------
function renderDict() {
  const rows = S.dict.map((d, i) => `<div class="row"><span class="meta"><b>${esc(d.to)}</b><small>במקום: ${esc(d.from)}</small></span>
    <button type="button" class="icon" data-act="dict-del" data-i="${i}" aria-label="מחיקת ${esc(d.to)} מהמילון">${I.trash}</button></div>`).join('');
  const e = S.engine;
  app.innerHTML = `<div class="screen dict">
    <header class="bar"><button type="button" class="icon" data-act="home" aria-label="חזרה">${I.back}</button><h1>המילון שלי</h1><span></span></header>
    <main class="dictbody">
      <p class="lead">מילים שתיקנת וביקשת לזכור. בכל סרטון חדש הן נכתבות נכון לבד.</p>
      ${rows || '<p class="empty">המילון עוד ריק. כשתתקן מילה בסרטון, אשאל אם לזכור אותה לתמיד.</p>'}
      <p class="about">מנוע התמלול: ${e.state === 'ready' ? `מוכן, עובד על <bdi>${e.threads}</bdi> ${e.threads === 1 ? 'ליבה' : 'ליבות'}` : e.state === 'error' ? 'לא נטען' : 'בהכנה'}. שום דבר לא יוצא מהטלפון.</p>
      <p class="about">דגם התמלול בעברית פותח על ידי יעקב קולני ומופץ על ידי עברית.איי, ברישיון קריאייטיב קומונס ייחוס 4.0.</p>
    </main></div>`;
}

// ---------- אירועים ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, i = Number(el.dataset.i);
  if (act === 'pick') document.getElementById('pick').click();
  else if (act === 'dict') { S.view = 'dict'; renderDict(); }
  else if (act === 'home') goHome();
  else if (act === 'engine-retry') { worker?.terminate(); worker = null; setEngine({ state: 'idle', pct: 0 }); startEngine(); }
  else if (act === 'open') {
    const p = await store.getProject(el.dataset.id), file = await store.getFile(el.dataset.id);
    if (!p || !file) { toast('הסרטון הזה כבר לא שמור בטלפון.'); return; }
    openProject(p, file);
  }
  else if (act === 'delete') {
    const id = el.dataset.id, p = await store.getProject(id), file = await store.getFile(id);
    await store.deleteProject(id);
    S.projects = await store.listProjects(); renderHome();
    toast('הסרטון נמחק מהרשימה.', { label: 'ביטול', run: async () => { await store.putFile(id, file); await store.saveProject(p); S.projects = await store.listProjects(); if (S.view === 'home') renderHome(); } });
  }
  else if (act === 'play') togglePlay();
  else if (act === 'select') {
    const l = S.p.lines[i];
    S.sel = S.sel === i ? -1 : i;
    video.pause();
    if (!l.cut) video.currentTime = Math.max(l.s, S.ranges[0]?.s ?? 0);
    renderLines(); sync(true);
  }
  else if (act === 'edit') openEdit(i);
  else if (act === 'cut') { const l = S.p.lines[i]; l.cut = !l.cut; changed(); }
  else if (act === 'trim-suggest') { const s = cap.suggestTrim(S.p.lines, S.p.duration); if (s) { S.p.trim = s; changed(); video.currentTime = s.s; } }
  else if (act === 'trim-reset') { S.p.trim = { s: 0, e: S.p.duration }; changed(); }
  else if (act === 'export') doExport();
  else if (act === 'busy-cancel') S.busy?.cancel?.();
  else if (act === 'err-close') document.getElementById('err')?.remove();
  else if (act === 'sheet-close') document.getElementById('sheet')?.remove();
  else if (act === 'result-close') closeResult();
  else if (act === 'saved') toast('הסרטון נשמר בתיקיית ההורדות.');
  else if (act === 'share') {
    const r = S.result;
    try { await navigator.share({ files: [new File([r.blob], r.name, { type: 'video/mp4' })] }); } catch {}
  }
  else if (act === 'toast-action') { const run = toast.action; document.getElementById('toast').hidden = true; toast.action = null; await run?.(); }
  else if (act === 'dict-del') {
    const removed = S.dict[i];
    S.dict = S.dict.filter((_, k) => k !== i); await store.setDict(S.dict); renderDict();
    toast('נמחק מהמילון.', { label: 'ביטול', run: async () => { S.dict = [...S.dict, removed]; await store.setDict(S.dict); if (S.view === 'dict') renderDict(); } });
  }
});

document.addEventListener('change', e => {
  if (e.target.id !== 'pick') return;
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) startNew(file);
});

document.addEventListener('submit', e => {
  if (!e.target.classList.contains('sheet')) return;
  e.preventDefault();
  submitEdit(e.target);
});

window.addEventListener('resize', layoutCaption);

// ---------- עלייה ----------
async function boot() {
  S.dict = await store.getDict();
  S.projects = await store.listProjects();
  renderHome();
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      // ריבוי ליבות לתמלול דורש שהדף ייטען דרך ה-service worker. בביקור הראשון טוענים פעם אחת מחדש.
      if (!crossOriginIsolated && !sessionStorage.getItem('kt-isolated-try')) {
        sessionStorage.setItem('kt-isolated-try', '1');
        if (!navigator.serviceWorker.controller) {
          await Promise.race([
            new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
            new Promise(r => setTimeout(r, 3000)),
          ]);
        }
        location.reload();
        return;
      }
    } catch (err) { console.warn('service worker', err); }
  }
  startEngine();
}
boot();
