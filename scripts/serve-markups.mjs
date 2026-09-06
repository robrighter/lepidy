import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "markups");
const port = Number(process.env.LEPIDY_MARKUP_PORT ?? 4174);
const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const candidate = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    if (!(await stat(candidate)).isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": mime.get(path.extname(candidate)) ?? "application/octet-stream" });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Lepidy mockups available at http://127.0.0.1:${port}\n`);
});
