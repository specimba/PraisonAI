// E2E stall harness (r75 companion to the runtime-tunable stall watchdog):
// a fake OpenAI-compatible endpoint whose /v1/chat/completions ACCEPTS the
// connection and then NEVER responds — the exact "stream stalls silently"
// failure mode the runner's watchdog + auto-resume chain exists for.
//
// Usage:  bun scripts/hang-server.ts [port]        (default 4319)
// Modes:  POST /v1/chat/completions         → hangs forever (default)
//         POST /v1/chat/completions?hang=ms → 504 after ms (bounded test)
//         GET  /health                      → 200 "hanging ok"
//
// Pair with localStorage "praison-stall-timeout-ms" = 20000 and a custom
// provider pointed at http://localhost:4319/v1 to watch the runner:
// stall → watchdog abort → auto-resume 1/3 → stall → … → manual-resume card.
// r155: call log now appends via node:fs/promises — Bun.write dropped its
// { append: true } option in current bun-types, and silent truncation would
// destroy the forensic call log this file exists to keep.
import { appendFile } from "node:fs/promises";

// r202: minimal local ambient — keeps `tsc --noEmit --incremental false`
// (the qa:tsc fresh gate) at ZERO errors without pulling @types/bun into the
// Next app's type graph. Same pattern as scripts/qa-syntax-sweep.ts; this
// file's single Bun API surface is Bun.serve below.
declare const Bun: {
  serve(options: {
    port: number;
    idleTimeout?: number;
    fetch(req: Request): Response | Promise<Response>;
  }): unknown;
};

const port = Number(process.argv[2] ?? 4319);

// v5 (18:23 round): CORS everywhere — the browser-direct lane fetches this
// origin straight from the page (localhost:3000 ≠ localhost:4319), so without
// ACAO the browser refuses the preflight/response and the lane dies before
// the stream can hang. Echo requested headers for credentialed safety.
const corsHeaders = (req: Request): Record<string, string> => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    req.headers.get("access-control-request-headers") ?? "*",
  "Access-Control-Max-Age": "86400",
});

Bun.serve({
  port,
  idleTimeout: 255, // bun max (seconds) — keep sockets alive while hanging
  fetch(req) {
    // v6 (19:23 round): file-backed call log — daemonized stdout is /dev/null,
    // so forensic proof of WHO dialed us must land in a file. Browser-direct
    // lane fetches carry the browser UA; server relay carries a Node/Bun UA.
    const CALL_LOG = "/home/z/my-project/ops/hang-server-calls.log";
    const logCall = (note: string) =>
      appendFile(
        CALL_LOG,
        `${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname} ` +
          `ua=${(req.headers.get("user-agent") ?? "?").slice(0, 80)} ${note}\n`
      ).catch(() => {});
    if (req.method === "OPTIONS") {
      void logCall("preflight");
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      void logCall("health");
      return new Response("hanging ok", { headers: corsHeaders(req) });
    }
    const hangMs = Number(url.searchParams.get("hang") ?? 0);
    if (hangMs > 0) {
      void logCall(`bounded-hang=${hangMs}ms`);
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({ error: { message: "upstream timeout (hang-server)" } }),
                { status: 504, headers: { "Content-Type": "application/json", ...corsHeaders(req) } }
              )
            ),
          hangMs
        )
      );
    }
    void req
      .text()
      .catch(() => "")
      .then((body) => {
        let model = "?";
        try {
          model = String(JSON.parse(body)?.model ?? "?");
        } catch {}
        return logCall(`HANG model=${model}`);
      });
    return new Promise(() => {}); // hang forever — the whole point
  },
});

console.log(
  `hang-server on :${port} — POST /v1/chat/completions hangs forever; ?hang=ms → 504 after ms; /health → 200`
);
