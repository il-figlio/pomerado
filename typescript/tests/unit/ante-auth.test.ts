import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AnteAuth } from "../../src/models/ante-auth.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// Scripted Ante implements only the auth handshake: no model or account access.
const fakeAnte = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-fake-ante-"));
  directories.push(directory);
  const binary = join(directory, "ante");
  const homeLog = join(directory, "home");
  await writeFile(binary, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const home=process.env.ANTE_HOME;
writeFileSync(${JSON.stringify(homeLog)},home);
const catalog=JSON.parse(readFileSync(home+'/catalog.json','utf8'));
const provider=catalog.providers['pomerado-auth'];
const send=event=>process.stdout.write(JSON.stringify({event})+'\\n');
let chain=Promise.resolve();
createInterface({input:process.stdin}).on('line',line=>{chain=chain.then(async()=>{
 const {op}=JSON.parse(line);
 if(op.StartSession){if(op.StartSession.tools.length||!op.StartSession.no_skills||op.StartSession.save_session)throw Error('Unsafe auth session');send({SessionStart:{}});}
 if(op.UserInput){
  let response=await fetch(provider.base_url+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer fixture-'+provider.credential},body:'{}'});
  if(response.status===401)response=await fetch(provider.base_url+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer fixture-refreshed'},body:'{}'});
  await response.text();send({TurnEnd:{status:response.ok?'Completed':{Error:{}}}});
 }
 if(op==='Shutdown')process.exit(0);
});});
`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { binary, homeLog };
};

it("pins a named account through Ante, retries its rejected token, and removes its temporary home", async () => {
  const { binary, homeLog } = await fakeAnte();
  const auth = new AnteAuth("oauth:openai/work", binary);
  const attempts: string[] = [];
  let home: string | undefined;
  try {
    const result = await auth.authorize(async (authorization) => {
      attempts.push(authorization);
      return Response.json({ ok: true }, { status: attempts.length === 1 ? 401 : 200 });
    });
    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["Bearer fixture-oauth:openai/work", "Bearer fixture-refreshed"]);
    home = await readFile(homeLog, "utf8");
    expect(await readdir(home)).toContain("auth");
  } finally { await auth.close(); }
  await expect(readdir(home!)).rejects.toThrow();
});

it("serializes authorization handshakes and fails closed after shutdown", async () => {
  const { binary } = await fakeAnte();
  const auth = new AnteAuth("oauth:openai", binary);
  try {
    const results = await Promise.all([1, 2, 3].map((n) => auth.authorize(async () => Response.json(n))));
    expect(await Promise.all(results.map((r) => r.json()))).toEqual([1, 2, 3]);
  } finally { await auth.close(); }
  await expect(auth.authorize(async () => Response.json("unexpected"))).rejects.toThrow("closed");
});

it("rejects unsupported profiles and credential path traversal before starting Ante", () => {
  for (const reference of ["oauth:anthropic/work", "oauth:openai/../../other", "env:OPENAI_API_KEY", "oauth:openai/"])
    expect(() => new AnteAuth(reference)).toThrow("requires oauth:openai");
});

it("cancels an in-flight request and refuses to reuse the interrupted auth session", async () => {
  const { binary } = await fakeAnte();
  const auth = new AnteAuth("oauth:openai", binary);
  const controller = new AbortController();
  let began!: () => void;
  const ready = new Promise<void>((resolve) => { began = resolve; });
  const operation = auth.authorize(async (_authorization, signal) => {
    began();
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  }, controller.signal);
  try {
    await ready;
    controller.abort();
    await expect(operation).rejects.toThrow("cancelled");
    await expect(auth.authorize(async () => Response.json("unexpected"))).rejects.toThrow("cancelled");
  } finally { await auth.close(); }
});

it("reports a missing Ante executable without exposing a provider diagnostic", async () => {
  const auth = new AnteAuth("oauth:openai", "/nonexistent/pomerado-fixture-ante");
  try {
    await expect(auth.authorize(async () => Response.json("unexpected"))).rejects.toThrow("Could not start Ante");
  } finally { await auth.close(); }
});
