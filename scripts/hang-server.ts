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
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    const url = new URL(req.url);
    if (url.pathname === "/health")
      return new Response("hanging ok", { headers: corsHeaders(req) });
    const hangMs = Number(url.searchParams.get("hang") ?? 0);
    if (hangMs > 0) {
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
    return new Promise(() => {}); // hang forever — the whole point
  },
});

console.log(
  `hang-server on :${port} — POST /v1/chat/completions hangs forever; ?hang=ms → 504 after ms; /health → 200`
);
