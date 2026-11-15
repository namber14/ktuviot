// קריאת הסרטון, הוצאת הקול, תמונות קטנות, וצריבת הכתוביות. הכול בתוך המכשיר.
import {
  Input, BlobSource, ALL_FORMATS, AudioBufferSink, AudioSampleSink, VideoSampleSink, CanvasSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioSampleSource, Quality,
  canEncodeAudio, canEncodeVideo,
} from 'mediabunny';
import { drawCaption, lineIndexAt, CAPTION_FONT } from './captions.js';

const openInput = file => new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

export class MediaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** פרטי הסרטון: אורך, מידות, והאם יש קול. */
export async function readInfo(file) {
  const input = openInput(file);
  try {
    if (!(await input.canRead())) throw new MediaError('FORMAT', 'לא הצלחתי לקרוא את הקובץ הזה. נסה סרטון בפורמט רגיל של הטלפון.');
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new MediaError('NO_VIDEO', 'בקובץ הזה אין תמונה, רק קול.');
    if (!audio) throw new MediaError('NO_AUDIO', 'בסרטון הזה אין קול, אז אין מה לתמלל.');
    if (!(await video.canDecode())) throw new MediaError('CODEC', 'הדפדפן לא יודע לפתוח את סוג הסרטון הזה.');
    return {
      duration: await input.computeDuration(),
      width: video.displayWidth,
      height: video.displayHeight,
    };
  } finally { input.dispose(); }
}

/** מוציא את הקול כמונו ב-16,000 דגימות בשנייה, מיושר לציר הזמן של הסרטון. */
export async function extractAudio16k(file, onProgress) {
  const input = openInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    const sink = new AudioBufferSink(track);
    let mono = null, rate = 0;
    for await (const { buffer, timestamp } of sink.buffers()) {
      if (!mono) { rate = buffer.sampleRate; mono = new Float32Array(Math.ceil((duration + 1) * rate)); }
      const at = Math.round(timestamp * rate), ch = buffer.numberOfChannels;
      for (let c = 0; c < ch; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          const k = at + i;
          if (k >= 0 && k < mono.length) mono[k] += d[i] / ch;
        }
      }
      onProgress?.(Math.min(1, timestamp / duration));
    }
    if (!mono) throw new MediaError('NO_AUDIO', 'לא הצלחתי לקרוא את הקול בסרטון.');
    const length = Math.ceil(duration * rate);
    if (rate === 16000) return mono.subarray(0, length);
    const ctx = new OfflineAudioContext(1, Math.ceil(duration * 16000), 16000);
    const buf = ctx.createBuffer(1, length, rate);
    buf.copyToChannel(mono.subarray(0, length), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start();
    return (await ctx.startRendering()).getChannelData(0);
  } finally { input.dispose(); }
}

/** תמונות קטנות לאורך הסרטון, לפס החיתוך ולרשימת האחרונים. */
export async function makeThumbs(file, count, duration) {
  const input = openInput(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    const sink = new CanvasSink(track, { width: 96 });
    const times = Array.from({ length: count }, (_, i) => Math.min(duration - 0.05, (duration * (i + 0.5)) / count));
    const out = [];
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (!wrapped) { out.push(null); continue; }
      const c = wrapped.canvas;
      out.push(c.toDataURL ? c.toDataURL('image/jpeg', 0.6) : null);
    }
    return out;
  } finally { input.dispose(); }
}

const even = n => Math.max(2, Math.round(n / 2) * 2);

/**
 * צורב את הכתוביות וחותך: מחזיר קובץ mp4 מוכן.
 * @param ranges  הקטעים שנשארים, כפי שחוזרים מ-keepRanges
 * @param signal  לביטול באמצע
 */
export async function exportVideo(file, project, ranges, onProgress, signal) {
  await document.fonts.load(`700 40px ${CAPTION_FONT}`, 'אב');
  const input = openInput(file);
  let output = null;
  try {
    const vTrack = await input.getPrimaryVideoTrack();
    const aTrack = await input.getPrimaryAudioTrack();
    const scale = Math.min(1, 1080 / Math.min(vTrack.displayWidth, vTrack.displayHeight));
    const W = even(vTrack.displayWidth * scale), H = even(vTrack.displayHeight * scale);
    const quality = new Quality('high');
    if (!(await canEncodeVideo('avc', { width: W, height: H, quality }))) {
      throw new MediaError('ENCODE', 'הטלפון הזה לא מצליח לקודד וידאו בדפדפן. נסה לעדכן את כרום.');
    }
    if (!(await canEncodeAudio('aac'))) {
      const { registerAacEncoder } = await import('./vendor/mediabunny-aac-encoder.min.mjs');
      registerAacEncoder();
    }
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });

    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const vSource = new CanvasSource(canvas, { codec: 'avc', quality, keyFrameInterval: 2 });
    const aSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128e3 }) });
    output.addVideoTrack(vSource);
    output.addAudioTrack(aSource);
    await output.start();

    const total = ranges.reduce((a, r) => a + r.e - r.s, 0) || 1;
    const check = () => { if (signal?.aborted) throw new MediaError('CANCELED', 'בוטל'); };

    const video = (async () => {
      const sink = new VideoSampleSink(vTrack);
      for (const r of ranges) {
        for await (const sample of sink.samples(r.s, r.e)) {
          try {
            check();
            const s = Math.max(sample.timestamp, r.s), e = Math.min(sample.timestamp + (sample.duration || 1 / 30), r.e);
            if (e - s <= 0.001) continue;
            sample.drawWithFit(ctx, { fit: 'fill' });
            const i = lineIndexAt(project.lines, (s + e) / 2);
            if (i >= 0) drawCaption(ctx, W, H, project.lines[i].text);
            const at = r.out + s - r.s;
            await vSource.add(at, e - s);
            onProgress?.(Math.min(1, at / total));
          } finally { sample.close(); }
        }
      }
      vSource.close();
    })();

    const audio = (async () => {
      const sink = new AudioSampleSink(aTrack);
      let outTime = 0;
      for (const r of ranges) {
        for await (const sample of sink.samples(r.s, r.e)) {
          let part = null;
          try {
            check();
            const rate = sample.sampleRate, n = sample.numberOfFrames;
            const from = Math.max(0, Math.round((r.s - sample.timestamp) * rate));
            const to = Math.min(n, Math.round((r.e - sample.timestamp) * rate));
            if (to - from <= 0) continue;
            part = from > 0 || to < n ? sample.trim(from, to) : sample.clone();
            part.setTimestamp(outTime);
            outTime += (to - from) / rate;
            await aSource.add(part);
          } finally { part?.close(); sample.close(); }
        }
      }
      aSource.close();
    })();

    await Promise.all([video, audio]);
    check();
    await output.finalize();
    onProgress?.(1);
    return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), width: W, height: H, duration: total };
  } catch (err) {
    try { if (output && output.state !== 'finalized') await output.cancel(); } catch {}
    throw err;
  } finally { input.dispose(); }
}
