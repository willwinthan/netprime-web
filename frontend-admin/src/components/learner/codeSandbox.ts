/**
 * Runs learner JavaScript in a throw-away iframe with sandbox="allow-scripts" (opaque origin: no access to
 * the app's DOM, storage or token) and a CSP that blocks network requests. Results come back by postMessage;
 * after 3 seconds the iframe is removed.
 */
export interface SandboxResult {
  logs: string[];
  error: string | null;
  durationMs: number;
  /** calculateExp(2) === 500 && calculateExp(3) === 1000 */
  challengePassed: boolean;
  timedOut: boolean;
}

const RUNNER = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'">
</head><body><script>
window.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type !== "run" || typeof data.code !== "string") return;
  var logs = [];
  var show = function (a) { try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch (e) { return String(a); } };
  console.log = function () { logs.push(Array.prototype.map.call(arguments, show).join(" ")); };
  var error = null, challenge = false, start = performance.now();
  try { new Function(data.code)(); } catch (e) { error = e && e.message ? e.message : String(e); }
  var duration = performance.now() - start;
  if (!error) {
    try {
      var fn = new Function(data.code + "\\nreturn typeof calculateExp !== 'undefined' ? calculateExp : null;")();
      challenge = typeof fn === "function" && fn(2) === 500 && fn(3) === 1000;
    } catch (e) { /* The challenge check never reports errors of its own. */ }
  }
  parent.postMessage({ type: "result", id: data.id, logs: logs.slice(0, 500), error: error, durationMs: duration, challengePassed: challenge }, "*");
});
</script></body></html>`;

export function runInSandbox(code: string, timeoutMs = 3000): Promise<SandboxResult> {
  return new Promise(resolve => {
    const id = crypto.randomUUID();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.style.display = "none";
    frame.srcdoc = RUNNER;

    let settled = false;
    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      // Only the frame we created may answer, and only for this run.
      if (event.source !== frame.contentWindow || event.data?.type !== "result" || event.data.id !== id) return;
      finish({
        logs: Array.isArray(event.data.logs) ? event.data.logs.map(String) : [],
        error: typeof event.data.error === "string" ? event.data.error : null,
        durationMs: Number(event.data.durationMs) || 0,
        challengePassed: event.data.challengePassed === true,
        timedOut: false
      });
    };
    const timer = window.setTimeout(() => finish({
      logs: [], error: `โค้ดทำงานนานเกิน ${timeoutMs / 1000} วินาที ระบบหยุดการทำงานแล้ว`, durationMs: timeoutMs, challengePassed: false, timedOut: true
    }), timeoutMs);

    window.addEventListener("message", onMessage);
    frame.onload = () => frame.contentWindow?.postMessage({ type: "run", id, code }, "*");
    document.body.appendChild(frame);
  });
}
