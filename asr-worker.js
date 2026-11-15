// מנוע התמלול רץ כאן, ברקע, כדי שהמסך לא ייתקע בזמן העבודה.
import * as ort from './vendor/ort/ort.wasm.min.mjs';
import { HebrewTranscriber } from './asr.js';

const base = new URL('./', import.meta.url);
ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
const cores = navigator.hardwareConcurrency || 2;
const threads = self.crossOriginIsolated ? Math.min(4, Math.max(1, Math.floor(cores / 2))) : 1;
ort.env.wasm.numThreads = threads;

const FILES = [
  ['encoder', 'encoder.int8.onnx', 70478964],
  ['decoder', 'decoder.int8.onnx', 1049105],
  ['joiner', 'joiner.int8.onnx', 771805],
];
const TOTAL = FILES.reduce((a, f) => a + f[2], 0);

let loading = null;

async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('הורדת מנוע התמלול נכשלה (' + res.status + ')');
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); size += value.length; onBytes(value.length);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function load(modelBase) {
  loading ??= (async () => {
    const root = new URL(modelBase, base);
    let got = 0;
    const tick = n => { got += n; postMessage({ type: 'model', loaded: Math.min(got, TOTAL), total: TOTAL }); };
    const models = {};
    for (const [key, name] of FILES) models[key] = await fetchBytes(new URL(name, root), tick);
    const tokens = await (await fetch(new URL('tokens.txt', root))).text();
    const t = await HebrewTranscriber.create(ort, models, tokens);
    postMessage({ type: 'ready', threads });
    return t;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data.modelBase);
    if (data.type === 'transcribe') {
      const t = await load(data.modelBase);
      const started = performance.now();
      const res = await t.transcribe(data.samples, p => postMessage({ type: 'progress', id: data.id, p }));
      postMessage({ type: 'result', id: data.id, words: res.words, ms: Math.round(performance.now() - started), threads });
    }
  } catch (err) {
    postMessage({ type: 'error', id: data.id, message: String(err?.message || err) });
  }
};
