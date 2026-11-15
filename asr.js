// תמלול עברית בתוך המכשיר: דגם zipformer2 של עברית.איי, מורץ עם onnxruntime-web.
// הקובץ לא תלוי בדפדפן: מקבל את ort מבחוץ, כך שאותו קוד נבדק גם ב-Node.

const SR = 16000;
const FRAME_LEN = 400; // 25 אלפיות שנייה
const FRAME_SHIFT = 160; // 10 אלפיות שנייה
const FFT_N = 512;
const N_MEL = 80;
const LOW_FREQ = 20;
const HIGH_FREQ = SR / 2 - 400;
const PREEMPH = 0.97;
const EPS = 1.1920928955078125e-7;
const SUBSAMPLING = 4;
export const SECONDS_PER_FRAME = (FRAME_SHIFT * SUBSAMPLING) / SR; // 0.04
/** מילה שציון הביטחון שלה נמוך מזה מסומנת לבדיקה. */
export const DOUBT_THRESHOLD = -1.0;

const melScale = f => 1127 * Math.log(1 + f / 700);

function buildMelBanks() {
  const nBins = FFT_N / 2;
  const binWidth = SR / FFT_N;
  const melLow = melScale(LOW_FREQ);
  const melHigh = melScale(HIGH_FREQ);
  const delta = (melHigh - melLow) / (N_MEL + 1);
  const banks = [];
  for (let b = 0; b < N_MEL; b++) {
    const left = melLow + b * delta, center = left + delta, right = center + delta;
    let first = -1;
    const w = [];
    for (let i = 0; i < nBins; i++) {
      const mel = melScale(binWidth * i);
      if (mel > left && mel < right) {
        if (first < 0) first = i;
        w.push(mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center));
      }
    }
    banks.push({ first, w: Float64Array.from(w) });
  }
  return banks;
}

function buildWindow() {
  const win = new Float64Array(FRAME_LEN);
  for (let i = 0; i < FRAME_LEN; i++) win[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1)), 0.85);
  return win;
}

function buildFft() {
  const n = FFT_N, levels = Math.log2(n);
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return { rev, cos, sin };
}

let MEL = null, WIN = null, FFT = null;

/** מחזיר מאפייני קול (fbank בסגנון קלדי) לכל הקטע: Float32Array באורך frames*80. */
export function computeFbank(samples) {
  MEL ??= buildMelBanks(); WIN ??= buildWindow(); FFT ??= buildFft();
  const n = samples.length;
  const numFrames = Math.floor((n + FRAME_SHIFT / 2) / FRAME_SHIFT);
  const out = new Float32Array(numFrames * N_MEL);
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N), buf = new Float64Array(FRAME_LEN);
  const power = new Float64Array(FFT_N / 2);
  const { rev, cos, sin } = FFT;
  for (let f = 0; f < numFrames; f++) {
    const start = f * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LEN / 2;
    let mean = 0;
    for (let i = 0; i < FRAME_LEN; i++) {
      let s = start + i;
      while (s < 0 || s >= n) s = s < 0 ? -s - 1 : 2 * n - 1 - s;
      buf[i] = samples[s]; mean += buf[i];
    }
    mean /= FRAME_LEN;
    for (let i = 0; i < FRAME_LEN; i++) buf[i] -= mean;
    for (let i = FRAME_LEN - 1; i > 0; i--) buf[i] -= PREEMPH * buf[i - 1];
    buf[0] -= PREEMPH * buf[0];
    for (let i = 0; i < FFT_N; i++) { const j = rev[i]; re[i] = j < FRAME_LEN ? buf[j] * WIN[j] : 0; im[i] = 0; }
    for (let size = 2; size <= FFT_N; size <<= 1) {
      const half = size >> 1, step = FFT_N / size;
      for (let i = 0; i < FFT_N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] + im[b] * sin[k];
          const ti = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 0; i < FFT_N / 2; i++) power[i] = re[i] * re[i] + im[i] * im[i];
    const row = f * N_MEL;
    for (let b = 0; b < N_MEL; b++) {
      const { first, w } = MEL[b];
      let e = 0;
      for (let i = 0; i < w.length; i++) e += w[i] * power[first + i];
      out[row + b] = Math.log(e < EPS ? EPS : e);
    }
  }
  return { data: out, numFrames };
}

export function parseTokens(text) {
  const table = [];
  for (const line of text.split('\n')) {
    const i = line.lastIndexOf(' ');
    if (i < 0) continue;
    table[Number(line.slice(i + 1))] = line.slice(0, i);
  }
  return table;
}

const PUNCT = /^[\s.,?!:;"'״׳\-–—()…]+$/;

/** מחבר חלקי מילים למילים: טקסט, זמן התחלה, זמן סוף וציון ביטחון. */
export function tokensToWords(tokens) {
  const words = [];
  let cur = null;
  for (const t of tokens) {
    const startsWord = t.text.startsWith('▁');
    const piece = t.text.replace(/▁/g, '');
    if (startsWord || !cur) {
      if (cur) words.push(cur);
      cur = { w: '', s: t.time, last: t.time, p: 0 };
    }
    cur.w += piece;
    cur.last = t.time;
    if (!PUNCT.test(piece) && piece !== '') cur.p = Math.min(cur.p, t.logp);
  }
  if (cur) words.push(cur);
  const clean = words.filter(x => x.w.trim() !== '');
  return clean.map((x, i) => {
    const next = clean[i + 1];
    const e = Math.max(x.s + 0.12, Math.min(next ? next.s : x.last + 0.4, x.last + 0.6));
    return { w: x.w, s: +x.s.toFixed(2), e: +e.toFixed(2), p: +x.p.toFixed(3) };
  });
}

export class HebrewTranscriber {
  /**
   * @param ort       ספריית onnxruntime-web
   * @param models    { encoder, decoder, joiner } כ-ArrayBuffer או נתיב
   * @param tokensTxt תוכן tokens.txt
   * @param options   אפשרויות ל-InferenceSession
   */
  static async create(ort, models, tokensTxt, options = {}) {
    const t = new HebrewTranscriber();
    t.ort = ort;
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...options };
    t.encoder = await ort.InferenceSession.create(models.encoder, opts);
    t.decoder = await ort.InferenceSession.create(models.decoder, opts);
    t.joiner = await ort.InferenceSession.create(models.joiner, opts);
    t.tokens = parseTokens(tokensTxt);
    const meta = t.encoder.inputMetadata;
    t.stateSpecs = t.encoder.inputNames.filter(n => n !== 'x').map(name => {
      const m = meta.find(x => x.name === name);
      return { name, type: m.type, shape: m.shape.map(d => (typeof d === 'number' ? d : 1)) };
    });
    t.T = meta.find(x => x.name === 'x').shape[1];
    t.chunk = 128;
    t.blank = 0; t.unk = 2; t.context = 2;
    return t;
  }

  initStates() {
    const { ort } = this, states = {};
    for (const s of this.stateSpecs) {
      const size = s.shape.reduce((a, b) => a * b, 1);
      states[s.name] = s.type === 'int64'
        ? new ort.Tensor('int64', new BigInt64Array(size), s.shape)
        : new ort.Tensor('float32', new Float32Array(size), s.shape);
    }
    return states;
  }

  async runDecoder(ctx) {
    const y = new this.ort.Tensor('int64', BigInt64Array.from(ctx.map(BigInt)), [1, this.context]);
    return (await this.decoder.run({ y })).decoder_out;
  }

  /**
   * @param samples    Float32Array, מונו, 16,000 דגימות בשנייה, בטווח -1 עד 1
   * @param onProgress פונקציה שמקבלת מספר בין 0 ל-1
   */
  async transcribe(samples, onProgress) {
    const { ort, T, chunk } = this;
    // ריפוד שקט בסוף, כדי שגם המילים האחרונות ייצאו מהדגם
    const tail = Math.round(1.5 * SR);
    let total = samples.length + tail;
    const framesNeeded = n => Math.floor((n + FRAME_SHIFT / 2) / FRAME_SHIFT);
    let frames = framesNeeded(total);
    const chunks = Math.max(1, Math.ceil((frames - T) / chunk) + 1);
    const wantFrames = (chunks - 1) * chunk + T;
    total += (wantFrames - frames) * FRAME_SHIFT;
    const padded = new Float32Array(total);
    padded.set(samples);
    const fb = computeFbank(padded);
    if (fb.numFrames < wantFrames) throw new Error('חישוב מאפייני הקול יצא קצר מהצפוי');

    let states = this.initStates();
    const ctx = [-1, this.blank];
    let decoderOut = await this.runDecoder(ctx);
    const out = [];
    let frameOffset = 0;
    const row = T * N_MEL;
    for (let c = 0; c < chunks; c++) {
      const x = new ort.Tensor('float32', fb.data.subarray(c * chunk * N_MEL, c * chunk * N_MEL + row), [1, T, N_MEL]);
      const res = await this.encoder.run({ x, ...states });
      const enc = res.encoder_out;
      const next = {};
      for (const s of this.stateSpecs) next[s.name] = res['new_' + s.name];
      states = next;
      const [, tOut, dim] = enc.dims;
      for (let t = 0; t < tOut; t++) {
        const e = new ort.Tensor('float32', enc.data.subarray(t * dim, (t + 1) * dim), [1, dim]);
        const logit = (await this.joiner.run({ encoder_out: e, decoder_out: decoderOut })).logit.data;
        let best = 0, max = -Infinity;
        for (let i = 0; i < logit.length; i++) if (logit[i] > max) { max = logit[i]; best = i; }
        if (best !== this.blank && best !== this.unk) {
          // ציון הביטחון מחושב ב"טמפרטורה 2": במבחן על סרטון אמיתי זה המדד שהעלה לראש את הטעויות האמיתיות
          let sum = 0;
          for (let i = 0; i < logit.length; i++) sum += Math.exp((logit[i] - max) / 2);
          out.push({ id: best, text: this.tokens[best] ?? '', time: (frameOffset + t) * SECONDS_PER_FRAME, logp: -Math.log(sum) });
          ctx.shift(); ctx.push(best);
          decoderOut = await this.runDecoder(ctx);
        }
      }
      frameOffset += tOut;
      onProgress?.((c + 1) / chunks);
    }
    return { tokens: out, words: tokensToWords(out) };
  }
}
