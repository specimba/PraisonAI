/**
 * r109 (v20) — throttling-tolerant timers for the workflow engine.
 *
 * Background tabs clamp main-thread timers: after ~5 minutes hidden,
 * Chromium's "intensive throttling" fires setInterval/setTimeout chains at
 * most once per minute. The workflow engine's stall watchdog (15s cadence)
 * and the 1.2s auto-resume delay both degrade under that clamp — a stalled
 * stream then takes MINUTES to be detected and resumed, which users saw as
 * pipeline steps sitting "queued" while the platform tab was unfocused.
 *
 * Web Worker timers are exempt from that throttling: the worker keeps the
 * real cadence and posts ticks to the main thread, which runs the (cheap)
 * check logic. All engine state stays on the main thread — the worker is a
 * dumb clock. Falls back to main-thread timers when Workers are unavailable
 * (SSR, sandboxed iframes), so behavior is never worse than before.
 */

type WorkerMsg = { type: "tick"; key: string };

let worker: Worker | null = null;
const tickCallbacks = new Map<string, () => void>();

const WORKER_SOURCE = `
const ids = new Map();
onmessage = (e) => {
  const d = e.data;
  if (d.type === "start") {
    if (ids.has(d.key)) clearInterval(ids.get(d.key));
    ids.set(d.key, setInterval(() => postMessage({ type: "tick", key: d.key }), d.ms));
  } else if (d.type === "stopKey") {
    const id = ids.get(d.key);
    if (id != null) { clearInterval(id); ids.delete(d.key); }
  } else if (d.type === "stopAll") {
    ids.forEach((id) => clearInterval(id));
    ids.clear();
  }
};
`;

function ensureWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
    worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const cb = tickCallbacks.get(e.data?.key);
      if (cb) cb();
    };
    worker.onerror = () => {
      /* let callers' fallbacks own liveness; worker failures only cost cadence */
    };
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * Throttling-tolerant setInterval. Returns true when the worker clock owns
 * the cadence; false means the caller MUST fall back to main-thread
 * setInterval (SSR / no-Worker environments).
 */
export function setWorkerInterval(key: string, ms: number, cb: () => void): boolean {
  const w = ensureWorker();
  if (!w) return false;
  tickCallbacks.set(key, cb);
  w.postMessage({ type: "start", key, ms });
  return true;
}

/** Stop one worker interval. Safe to call for unknown keys. */
export function clearWorkerInterval(key: string): void {
  tickCallbacks.delete(key);
  worker?.postMessage({ type: "stopKey", key });
}

/**
 * Throttling-tolerant setTimeout (one-shot). Returns true when worker-owned;
 * false means the caller MUST fall back to main-thread setTimeout.
 */
export function setWorkerTimeout(key: string, ms: number, cb: () => void): boolean {
  const w = ensureWorker();
  if (!w) return false;
  tickCallbacks.set(key, () => {
    tickCallbacks.delete(key);
    w.postMessage({ type: "stopKey", key });
    cb();
  });
  w.postMessage({ type: "start", key, ms });
  return true;
}
