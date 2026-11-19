import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export async function startS3Mock(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const objects = new Map<string, string>();
  const uploads = new Map<string, { key: string; parts: Map<number, string> }>();
  const requests: { method: string; key: string; query: string; status: number }[] = [];
  let failure = { status: 500, remaining: 0 };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname).replace(/^\/[^/]+\//, "");
    const method = req.method!;
    const entry = { method, key, query: url.search, status: 200 };
    requests.push(entry);

    function reply(status: number, body?: string) {
      req.resume();
      entry.status = res.statusCode = status;
      res.end(body);
    }

    if (
      !/^AWS4-HMAC-SHA256 Credential=[^,]+,\s*SignedHeaders=[^,]+,\s*Signature=[a-f0-9]{64}$/.test(
        req.headers.authorization ?? ""
      )
    )
      return reply(403);
    if (failure.remaining > 0) {
      failure.remaining--;
      return reply(failure.status);
    }

    if (method === "POST" && url.searchParams.has("uploads")) {
      const id = randomUUID();
      uploads.set(id, { key, parts: new Map() });
      return reply(
        200,
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`
      );
    }

    const id = url.searchParams.get("uploadId");
    if (id) {
      const upload = uploads.get(id);
      if (!upload || upload.key !== key) return reply(404);
      if (method === "PUT") {
        const number = Number(url.searchParams.get("partNumber"));
        if (!Number.isInteger(number) || number < 1) return reply(400);
        const part = path.join(directory, `${id}-${number}`);
        await pipeline(req, createWriteStream(part));
        upload.parts.set(number, part);
        res.setHeader("ETag", `"part-${number}"`);
        return reply(200);
      }
      if (method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const manifest = Buffer.concat(chunks).toString();
        const numbers = [...manifest.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match) =>
          Number(match[1])
        );
        if (
          !numbers.length ||
          numbers.some(
            (number, index) =>
              !upload.parts.has(number) || (index > 0 && number <= numbers[index - 1])
          )
        )
          return reply(400);
        const target = path.join(directory, randomUUID());
        for (const number of numbers) {
          await pipeline(
            createReadStream(upload.parts.get(number)!),
            createWriteStream(target, { flags: "a" })
          );
        }
        const previous = objects.get(key);
        if (previous) await fs.rm(previous);
        objects.set(key, target);
      } else if (method !== "DELETE") {
        return reply(405);
      }
      for (const part of upload.parts.values()) await fs.rm(part);
      uploads.delete(id);
      return method === "DELETE" ? reply(204) : reply(200, "<CompleteMultipartUploadResult/>");
    }

    const object = objects.get(key);
    if (method === "PUT") {
      const target = path.join(directory, randomUUID());
      await pipeline(req, createWriteStream(target));
      if (object) await fs.rm(object);
      objects.set(key, target);
      return reply(200);
    }
    if (method === "DELETE") {
      if (object) await fs.rm(object);
      objects.delete(key);
      return reply(204);
    }
    if (!object) return reply(404);
    const { size } = await fs.stat(object);
    res.setHeader("ETag", '"mock-etag"');
    res.setHeader("Accept-Ranges", "bytes");
    if (method === "HEAD") {
      res.setHeader("Content-Length", size);
      return reply(200);
    }
    if (method !== "GET") return reply(405);
    let start = 0;
    let end = size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2])) return reply(416);
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return reply(416);
      }
      entry.status = res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    res.setHeader("Content-Length", Math.max(0, end - start + 1));
    if (size === 0) return reply(200);
    await pipeline(createReadStream(object, { start, end }), res);
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    uploads,
    requests,
    failNext(count: number, status: 403 | 500) {
      failure = { remaining: count, status };
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}
