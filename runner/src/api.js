import http from "http";
import fs from "fs";
import path from "path";

let STATE = {
  startedAt: null,
  tickCount: 0,
  tickMs: 1000,
  lastTickAt: null,
  errorCount: 0,
  agents: {},
  recentEvents: []
};

let META = {
  addresses: null,
  abis: null
};

export function updateState(partial) {
  // Special-case: recentEvents should append into ring buffer
  if (partial && Array.isArray(partial.recentEvents)) {
    const merged = (STATE.recentEvents ?? []).concat(partial.recentEvents);
    // keep last 200
    STATE = { ...STATE, ...partial, recentEvents: merged.slice(-200) };
    return;
  }
  STATE = { ...STATE, ...(partial ?? {}) };
}

export function startApiServer({ port, addresses, abis }) {
  META.addresses = addresses;
  META.abis = abis;

  const dashboardPath = path.join("..", "..", "dashboard", "index.html");

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") {
        const nowMs = Date.now();
        const lastTickAt = Number(STATE.lastTickAt ?? 0);
        const tickMs = Number(STATE.tickMs ?? 1000);
        const stalled = lastTickAt ? (nowMs - lastTickAt) > (tickMs * 5) : true;
        const payload = {
          ok: !stalled,
          stalled,
          tickCount: Number(STATE.tickCount ?? 0),
          lastTickAt,
          errorCount: Number(STATE.errorCount ?? 0)
        };
        res.writeHead(stalled ? 503 : 200, {
          "content-type": "application/json",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify(payload));
        return;
      }
      if (url.pathname === "/state") {
        const now = Math.floor(Date.now() / 1000);
        const startedAt = Number(STATE.startedAt ?? 0);
        const uptimeSeconds = startedAt ? Math.max(0, now - startedAt) : 0;

        const payload = {
          ...STATE,
          uptimeSeconds,
          addresses: META.addresses
        };

        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify(payload));
        return;
      }

      if (url.pathname === "/") {
        const html = fs.readFileSync(dashboardPath, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // fallback
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Server error");
    }
  });

  server.listen(port, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on http://127.0.0.1:${port}`);
  });
}
