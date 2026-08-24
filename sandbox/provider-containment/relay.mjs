import { createServer } from "node:http";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const first = await lines[Symbol.asyncIterator]().next();
if (first.done) throw new Error("relay init missing");
lines.close();
const init = JSON.parse(first.value);
if (
  init?.schemaVersion !== 1 ||
  typeof init.token !== "string" ||
  typeof init.providerSecret !== "string"
) {
  throw new Error("relay init invalid");
}
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${init.token}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":"invalid_grant"}');
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true,"provider":"contained"}');
});
server.listen(8080, "0.0.0.0", () => process.stdout.write('{"ready":true}\n'));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
