/** A wall-clock deadline, shared by all stages of one request and its parent task. */
export function createRequestDeadline(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const expire = () => controller.abort(new DOMException("订阅源请求超时", "TimeoutError"));
  const timer = timeoutMs > 0 ? setTimeout(expire, timeoutMs) : undefined;
  timer?.unref?.();
  if (timeoutMs <= 0) expire();
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

/** Stop waiting for OS DNS lookup; a late result must never start an HTTP request. */
export function awaitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? signal.reason : error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
