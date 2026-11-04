/** Build first, then node tools/verify-ante-auth.mjs. Uses the installed Ante with
 * isolated synthetic OAuth state and a local token server. No model calls or real
 * account access. This optional native integration check is separate from CI. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnteAuth } from "../dist/typescript/src/models/ante-auth.js";

const home = await mkdtemp(join(tmpdir(), "pomerado-ante-fixture-"));
let refreshes = 0;
const tokenServer = createServer((request, response) => {
  refreshes++;
  request.resume();
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    access_token: "fixture-refreshed", refresh_token: "fixture-rotated",
    expires_in: 3600, token_type: "Bearer",
  }));
});
await new Promise((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
const address = tokenServer.address();
assert(address && typeof address === "object");
const directory = join(home, "auth/credentials/oauth/openai");
await mkdir(directory, { recursive: true });
const file = join(directory, "work.json");
await writeFile(file, JSON.stringify({
  token_url: `http://127.0.0.1:${address.port}/token`, client_id: "fixture",
  token_request_encoding: "form", refresh_request_include_scopes: false,
  access_token: "fixture-expired", refresh_token: "fixture-refresh",
  expires_at: "2020-01-01T00:00:00Z", scopes: [],
}), { mode: 0o600 });
const priorHome = process.env.ANTE_HOME;
process.env.ANTE_HOME = home;
const auth = new AnteAuth("oauth:openai/work");
const attempts = [];
try {
  const response = await auth.authorize(async (authorization) => {
    attempts.push(authorization);
    return Response.json({ ok: true }, {
      status: authorization === "Bearer fixture-refreshed" ? 200 : 401,
    });
  });
  assert(response.ok);
  assert.deepEqual(attempts, ["Bearer fixture-expired", "Bearer fixture-refreshed"]);
  assert.equal(refreshes, 1);
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.refresh_token, "fixture-rotated");
  console.log("Native Ante named-account selection, refresh, and rotated-token persistence passed (synthetic local fixture; no model calls).");
} finally {
  await auth.close();
  tokenServer.closeAllConnections();
  await new Promise((resolve) => tokenServer.close(resolve));
  if (priorHome === undefined) delete process.env.ANTE_HOME;
  else process.env.ANTE_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
}
