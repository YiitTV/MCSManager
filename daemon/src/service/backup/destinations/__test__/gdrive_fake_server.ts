// In-process fake of the Google token endpoint and the Drive v3 REST API (test helper).
import crypto from "crypto";
import http from "http";
import { AddressInfo } from "net";

export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType?: string;
  data: Buffer;
  size: number;
  trashed: boolean;
  appProperties?: Record<string, string>;
}

interface Session {
  file: FakeFile;
  total: number;
  chunks: Buffer[];
  received: number;
  discard: boolean;
}

export class FakeGoogle {
  server!: http.Server;
  base = "";
  files = new Map<string, FakeFile>();
  sessions = new Map<string, Session>();
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  tokenCalls = 0;
  tokenForms: URLSearchParams[] = [];
  tokenMode: "ok" | "invalid_grant" | "invalid_client" | "500" = "ok";
  expiresIn = 3600;
  tokenDelayMs = 0;
  /** Reject access tokens other than the current one with 401. */
  validToken = "";
  rejectNextWith: { status: number; reason?: string; method?: string } | undefined;
  /** Chunk PUTs (1-based count) to fail with 503 BEFORE storing. */
  failChunkBefore = new Set<number>();
  /** Chunk PUTs to fail with 503 AFTER storing. */
  failChunkAfter = new Set<number>();
  chunkPuts = 0;
  chunkRanges: string[] = [];
  statusQueries = 0;
  locationOverride: string | undefined;
  discardUploads = false;
  deleted: string[] = [];
  private seq = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        const body = Buffer.concat(parts);
        this.handle(req, res, body);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  endpoints() {
    return {
      tokenUrl: `${this.base}/token`,
      apiBase: `${this.base}/drive/v3`,
      uploadBase: `${this.base}/upload/drive/v3`
    };
  }

  private send(res: http.ServerResponse, status: number, body?: unknown, headers = {}) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(payload);
  }

  private err(res: http.ServerResponse, status: number, reason?: string) {
    this.send(res, status, { error: { code: status, errors: [{ reason }], status: reason } });
  }

  private newId(): string {
    return `id${++this.seq}${crypto.randomBytes(4).toString("hex")}`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
    const url = new URL(req.url ?? "/", this.base);
    const method = req.method ?? "GET";
    this.requests.push({
      method,
      url: req.url ?? "",
      headers: req.headers,
      body: body.length < 4096 ? body.toString("utf8") : ""
    });

    if (url.pathname === "/token") {
      this.tokenCalls++;
      this.tokenForms.push(new URLSearchParams(body.toString("utf8")));
      const reply = () => {
        if (this.tokenMode === "invalid_grant")
          return this.send(res, 400, { error: "invalid_grant" });
        if (this.tokenMode === "invalid_client")
          return this.send(res, 401, { error: "invalid_client" });
        if (this.tokenMode === "500") return this.send(res, 500, { error: "boom" });
        this.validToken = `tok-${this.tokenCalls}`;
        this.send(res, 200, {
          access_token: this.validToken,
          expires_in: this.expiresIn,
          token_type: "Bearer"
        });
      };
      if (this.tokenDelayMs) setTimeout(reply, this.tokenDelayMs);
      else reply();
      return;
    }

    if (req.headers.authorization !== `Bearer ${this.validToken}`) {
      return this.err(res, 401, "authError");
    }
    if (
      this.rejectNextWith &&
      (!this.rejectNextWith.method || this.rejectNextWith.method === method)
    ) {
      const r = this.rejectNextWith;
      this.rejectNextWith = undefined;
      return this.err(res, r.status, r.reason);
    }

    // Resumable session PUT
    const sess = url.pathname.match(/^\/upload\/session\/([^/]+)$/);
    if (sess) return this.handleSession(sess[1], method, req, res, body);

    // Upload initiation
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(body.toString("utf8"));
      const file: FakeFile = {
        id: this.newId(),
        name: meta.name,
        parents: meta.parents ?? [],
        data: Buffer.alloc(0),
        size: 0,
        trashed: false,
        appProperties: meta.appProperties
      };
      const sid = this.newId();
      this.sessions.set(sid, {
        file,
        total: Number(req.headers["x-upload-content-length"]),
        chunks: [],
        received: 0,
        discard: this.discardUploads
      });
      const location = this.locationOverride ?? `${this.base}/upload/session/${sid}`;
      return this.send(res, 200, undefined, { Location: location });
    }

    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const m = q.match(
        /^name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and mimeType = '([^']+)' and trashed = false$/
      );
      if (!m) return this.err(res, 400, "invalidQuery");
      const unesc = (s: string) => s.replace(/\\(.)/g, "$1");
      const files = [...this.files.values()].filter(
        (f) =>
          f.name === unesc(m[1]) &&
          f.parents.includes(unesc(m[2])) &&
          f.mimeType === m[3] &&
          !f.trashed
      );
      return this.send(res, 200, { files: files.slice(0, 1).map((f) => ({ id: f.id })) });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(body.toString("utf8"));
      const file: FakeFile = {
        id: this.newId(),
        name: meta.name,
        parents: meta.parents ?? [],
        mimeType: meta.mimeType,
        data: Buffer.alloc(0),
        size: 0,
        trashed: false
      };
      this.files.set(file.id, file);
      return this.send(res, 200, { id: file.id });
    }

    const fm = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fm) {
      const file = this.files.get(fm[1]);
      if (method === "DELETE") {
        this.deleted.push(fm[1]);
        if (!file) return this.err(res, 404, "notFound");
        this.files.delete(fm[1]);
        res.writeHead(204);
        return res.end();
      }
      if (method === "GET") {
        if (!file) return this.err(res, 404, "notFound");
        if (url.searchParams.get("alt") === "media") {
          res.writeHead(200, { "Content-Length": file.data.length });
          return res.end(file.data);
        }
        return this.send(res, 200, { id: file.id, size: String(file.size), trashed: file.trashed });
      }
    }
    this.err(res, 404, "notFound");
  }

  private handleSession(
    sid: string,
    method: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer
  ) {
    const s = this.sessions.get(sid);
    if (!s) return this.err(res, 404, "notFound");
    if (method === "DELETE") {
      this.sessions.delete(sid);
      res.writeHead(499);
      return res.end();
    }
    const cr = String(req.headers["content-range"] ?? "");
    const finish = () => {
      s.file.data = s.discard ? Buffer.alloc(0) : Buffer.concat(s.chunks);
      s.file.size = s.received;
      this.files.set(s.file.id, s.file);
      this.sessions.delete(sid);
      this.send(res, 200, { id: s.file.id, size: String(s.file.size) });
    };
    const incomplete = () => {
      const headers: Record<string, string> = {};
      if (s.received > 0) headers.Range = `bytes=0-${s.received - 1}`;
      res.writeHead(308, headers);
      res.end();
    };
    if (cr.startsWith("bytes */")) {
      this.statusQueries++;
      if (s.total === 0 || s.received === s.total) return finish();
      return incomplete();
    }
    const m = cr.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!m) return this.err(res, 400, "badContentRange");
    this.chunkPuts++;
    this.chunkRanges.push(`${m[1]}-${m[2]}`);
    if (this.failChunkBefore.has(this.chunkPuts)) return this.err(res, 503, "backendError");
    if (Number(m[1]) !== s.received) return this.err(res, 400, "offsetMismatch");
    if (!s.discard) s.chunks.push(Buffer.from(body));
    s.received += body.length;
    if (this.failChunkAfter.has(this.chunkPuts)) return this.err(res, 503, "backendError");
    if (s.received === s.total) return finish();
    incomplete();
  }
}
