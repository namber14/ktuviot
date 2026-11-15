// לוגיקה של כתוביות: חלוקה לשורות, מילון תיקונים, חיתוכים וציור הכתובית.
// קובץ טהור (בלי דפדפן), כדי שאפשר יהיה לבדוק אותו לבד.

export const DOUBT_THRESHOLD = -1.0;

const SENT_END = /[.?!…]["״']?$/;
const SOFT_END = /[,;:]$/;
const EDGE_PUNCT = /^[\s.,?!:;"'״׳()…\-–]+|[\s.,?!:;"'״׳()…\-–]+$/g;

export const bare = w => w.replace(EDGE_PUNCT, '');
const trailing = w => (w.match(/[\s.,?!:;"'״׳()…\-–]+$/) || [''])[0];
const splitWords = text => text.trim().split(/\s+/).filter(Boolean);

let nextId = 1;
const newId = () => 'l' + Date.now().toString(36) + (nextId++).toString(36);

/** מילים עם זמנים ← שורות כתוביות קצרות, שנשברות לפי פיסוק והפסקות דיבור. */
const MAX_WORDS = 6, MAX_CHARS = 30, GAP = 0.7;
const chars = g => g.reduce((a, x) => a + x.w.length + 1, 0) - 1;

/** מחלק קטע ארוך לחלקים באורך דומה, כדי שלא תישאר שורה של מילה בודדת. */
function splitBalanced(group) {
  const total = chars(group);
  if (group.length <= MAX_WORDS && total <= MAX_CHARS) return [group];
  const k = Math.max(Math.ceil(total / 28), Math.ceil(group.length / MAX_WORDS));
  const target = total / k, parts = [];
  let cur = [], acc = 0;
  for (const w of group) {
    const next = acc + w.w.length + (cur.length ? 1 : 0);
    if (cur.length && parts.length < k - 1 && Math.abs(acc - target) <= Math.abs(next - target)) {
      parts.push(cur); cur = [w]; acc = w.w.length;
    } else { cur.push(w); acc = next; }
  }
  if (cur.length) parts.push(cur);
  return parts;
}

export function buildLines(words) {
  // שלב 1: קטעים לפי הפסקות דיבור, סוף משפט, ופסיק אחרי קטע שכבר עומד בפני עצמו
  const clauses = [];
  let cur = [];
  const flush = () => { if (cur.length) { clauses.push(cur); cur = []; } };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.s - prev.e > GAP) flush();
    cur.push(w);
    if (SENT_END.test(w.w)) flush();
    else if (SOFT_END.test(w.w) && cur.length >= 3 && chars(cur) >= 12) flush();
  }
  flush();
  // שלב 2: קטע ארוך מתחלק באיזון; קטע קצרצר שממשיך את אותו משפט מתחבר לקודם
  const groups = [];
  for (const part of clauses.flatMap(splitBalanced)) {
    const prev = groups[groups.length - 1];
    const tiny = part.length === 1 || (part.length === 2 && chars(part) < 10);
    if (prev && tiny && !SENT_END.test(prev[prev.length - 1].w) && part[0].s - prev[prev.length - 1].e <= GAP
      && prev.length + part.length <= MAX_WORDS + 1 && chars(prev) + chars(part) + 1 <= MAX_CHARS + 4) {
      prev.push(...part);
    } else groups.push([...part]);
  }
  return groups.map(g => ({
    id: newId(),
    text: g.map(x => x.w).join(' '),
    s: g[0].s,
    e: g[g.length - 1].e,
    cut: false,
    doubts: g.map((x, i) => (x.p < DOUBT_THRESHOLD ? i : -1)).filter(i => i >= 0),
  }));
}

/** מחיל את המילון על רצף המילים, לפני החלוקה לשורות. מחזיר מילים חדשות וכמה תיקונים בוצעו. */
export function applyDictionary(words, dict) {
  let out = words.map(w => ({ ...w }));
  let fixes = 0;
  for (const entry of dict) {
    const from = splitWords(entry.from).map(bare), to = splitWords(entry.to);
    if (!from.length || !to.length) continue;
    const res = [];
    for (let i = 0; i < out.length; i++) {
      let hit = i + from.length <= out.length;
      for (let k = 0; hit && k < from.length; k++) if (bare(out[i + k].w) !== from[k]) hit = false;
      if (!hit) { res.push(out[i]); continue; }
      const first = out[i], last = out[i + from.length - 1];
      const tail = trailing(last.w), span = last.e - first.s;
      to.forEach((t, k) => res.push({
        w: k === to.length - 1 ? t + tail : t,
        s: +(first.s + (span * k) / to.length).toFixed(2),
        e: +(first.s + (span * (k + 1)) / to.length).toFixed(2),
        p: 0,
      }));
      i += from.length - 1;
      fixes++;
    }
    out = res;
  }
  return { words: out, fixes };
}

/** מה השתנה בין הטקסט הישן לחדש: מחזיר { from, to } לשמירה במילון, או null אם אין מה ללמוד. */
export function diffPhrase(oldText, newText) {
  const a = splitWords(oldText), b = splitWords(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const from = a.slice(start, endA).map((w, i, arr) => (i === arr.length - 1 ? bare(w) : w)).join(' ').trim();
  const to = b.slice(start, endB).map((w, i, arr) => (i === arr.length - 1 ? bare(w) : w)).join(' ').trim();
  if (!bare(from) || !bare(to) || from === to) return null;
  if (splitWords(from).length > 4 || splitWords(to).length > 4) return null;
  return { from, to };
}

/** עד מתי השורה מוצגת: עד השורה הבאה אם היא קרובה, כדי שהכתוביות לא יהבהבו. */
export function displayEnd(lines, i) {
  const line = lines[i];
  let next = null;
  for (let k = i + 1; k < lines.length; k++) if (!lines[k].cut) { next = lines[k]; break; }
  return next && next.s - line.e < 1.2 ? next.s : line.e + 0.6;
}

/** איזו שורה מוצגת בזמן t (בזמן של הסרטון המקורי). */
export function lineIndexAt(lines, t) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.cut || !l.text.trim()) continue;
    if (t >= l.s - 0.05 && t < displayEnd(lines, i)) return i;
  }
  return -1;
}

/** הקטע בסרטון ששייך לשורה: מאמצע הרווח שלפניה עד אמצע הרווח שאחריה. */
export function lineSlot(lines, i, duration) {
  const prev = lines[i - 1], next = lines[i + 1], l = lines[i];
  return {
    s: prev ? (prev.e + l.s) / 2 : 0,
    e: next ? (l.e + next.s) / 2 : duration,
  };
}

/** הקטעים שנשארים בסרטון אחרי חיתוך הקצוות והשורות שסומנו לחיתוך. */
export function keepRanges(project) {
  const { lines, duration } = project;
  const trim = project.trim ?? { s: 0, e: duration };
  let ranges = [{ s: Math.max(0, trim.s), e: Math.min(duration, trim.e) }];
  lines.forEach((l, i) => {
    if (!l.cut) return;
    const slot = lineSlot(lines, i, duration);
    ranges = ranges.flatMap(r => {
      if (slot.e <= r.s || slot.s >= r.e) return [r];
      const parts = [];
      if (slot.s > r.s) parts.push({ s: r.s, e: slot.s });
      if (slot.e < r.e) parts.push({ s: slot.e, e: r.e });
      return parts;
    });
  });
  ranges = ranges.filter(r => r.e - r.s > 0.08);
  let out = 0;
  return ranges.map(r => { const x = { ...r, out }; out += r.e - r.s; return x; });
}

export const totalKept = ranges => ranges.reduce((a, r) => a + r.e - r.s, 0);

/** זמן בסרטון המקורי ← זמן בסרטון החתוך (או -1 אם הרגע נחתך). */
export function toOutputTime(ranges, t) {
  for (const r of ranges) if (t >= r.s && t < r.e) return r.out + t - r.s;
  return -1;
}

/** הצעה לחיתוך הקצוות: השניות הריקות לפני המילה הראשונה ואחרי האחרונה. */
export function suggestTrim(lines, duration) {
  const live = lines.filter(l => l.text.trim());
  if (!live.length) return null;
  const s = Math.max(0, live[0].s - 0.3), e = Math.min(duration, live[live.length - 1].e + 0.5);
  if (s < 0.5 && duration - e < 0.5) return null;
  return { s: s < 0.5 ? 0 : +s.toFixed(2), e: duration - e < 0.5 ? duration : +e.toFixed(2) };
}

/** מעדכן שורה אחרי שהמשתמש תיקן אותה. */
export function editLine(line, newText) {
  line.text = splitWords(newText).join(' ');
  line.doubts = [];
  return line;
}

// ---- ציור הכתובית: כמו בקולנוע, לבן עם מסגרת כהה ----

export const CAPTION_FONT = 'Arimo';
export const CAPTION_STYLE = {
  sizeRatio: 0.058,     // גודל האות ביחס לרוחב הסרטון
  strokeRatio: 0.2,     // עובי המסגרת ביחס לגודל האות
  centerY: 0.74,        // גובה מרכז הכתובית: מעל האזור שכפתורי הרשתות מסתירים
  maxWidth: 0.86,
  lineHeight: 1.22,
  fill: '#FFFFFF',
  stroke: '#0B0F1A',
};

/** שובר טקסט לעד שתי שורות מאוזנות שנכנסות ברוחב. */
export function wrapCaption(text, measure, maxWidth) {
  if (measure(text) <= maxWidth) return [text];
  const words = splitWords(text);
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const wa = measure(a), wb = measure(b), worst = Math.max(wa, wb);
    if (!best || worst < best.worst) best = { lines: [a, b], worst };
  }
  return best ? best.lines : [text];
}

export function drawCaption(ctx, width, height, text) {
  if (!text) return;
  const st = CAPTION_STYLE;
  let size = Math.round(width * st.sizeRatio);
  const max = width * st.maxWidth;
  ctx.save();
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const setFont = () => { ctx.font = `700 ${size}px ${CAPTION_FONT}, Arial, sans-serif`; };
  setFont();
  let rows = wrapCaption(text, t => ctx.measureText(t).width, max);
  while (rows.some(r => ctx.measureText(r).width > max) && size > 14) { size -= 2; setFont(); rows = wrapCaption(text, t => ctx.measureText(t).width, max); }
  const lh = size * st.lineHeight;
  const top = height * st.centerY - ((rows.length - 1) * lh) / 2;
  ctx.lineWidth = size * st.strokeRatio;
  ctx.strokeStyle = st.stroke;
  ctx.fillStyle = st.fill;
  rows.forEach((r, i) => ctx.strokeText(r, width / 2, top + i * lh));
  rows.forEach((r, i) => ctx.fillText(r, width / 2, top + i * lh));
  ctx.restore();
}

export function formatTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
