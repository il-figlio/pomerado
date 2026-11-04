import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";

/** Ante's agent protocol is not an inference API. This private loopback provider asks
 * Ante to authorize a request, then acknowledges the handshake locally without a model
 * call. Ante alone reads, refreshes and writes its shared auth store. No transcript,
 * tool, skill, memory or actual Pomerado prompt is sent through the auth session. */
export class AnteAuth {
  private child: ChildProcessWithoutNullStreams | undefined;
  private server: Server | undefined;
  private directory: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failure: Error | undefined;
  private pending: {
    call: (authorization: string, signal: AbortSignal) => Promise<Response>;
    controller: AbortController;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
    response?: Response;
  } | undefined;

  constructor(private readonly credential: string, private readonly binary = "ante") {
    if (!/^oauth:openai(?:\/[a-zA-Z0-9_-]+)?$/.test(credential))
      throw new Error("This transport requires oauth:openai or oauth:openai/account. Sign in with ante auth login openai/account.");
  }

  private async start() {
    if (this.closed) throw new Error("Ante authentication bridge is closed.");
    if (this.failure) throw this.failure;
    if (this.child) return;
    const sourceHome = process.env.ANTE_HOME ?? join(homedir(), ".ante");
    this.directory = await mkdtemp(join(tmpdir(), "pomerado-ante-"));
    // A symlink shares Ante's existing store and locking; credentials are never copied.
    await symlink(join(sourceHome, "auth"), join(this.directory, "auth"), "dir");
    const route = `/auth/${randomBytes(24).toString("hex")}`;
    this.server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== `${route}/chat/completions` || !this.pending) {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      const pending = this.pending;
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ")) {
        pending.reject(new Error("Ante supplied no subscription credential. Run ante auth login openai."));
        response.writeHead(401).end();
        return;
      }
      try {
        const result = await pending.call(authorization, pending.controller.signal);
        if (this.pending !== pending) {
          await result.body?.cancel();
          response.writeHead(503).end();
          return;
        }
        if (result.status === 401) {
          await result.body?.cancel();
          // Ante sees the refusal and owns OAuth refresh/retry, including rotated tokens.
          response.writeHead(401, { "Content-Type": "application/json" }).end('{"error":{"message":"Subscription authentication required"}}');
          return;
        }
        pending.response = result;
        const chunk = (delta: object, finish: string | null) => ({
          id: "auth", object: "chat.completion.chunk", created: 0, model: "auth",
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify(chunk({ role: "assistant", content: "Authenticated." }, null))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`);
      } catch {
        pending.reject(new Error("The subscription request failed before a response was received."));
        response.writeHead(502).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind Ante auth bridge.");
    let profiles: unknown;
    try {
      const openai = JSON.parse(await readFile(join(sourceHome, "catalog.json"), "utf8")).oauth_profiles?.openai;
      if (openai !== undefined) profiles = { openai };
    } catch { /* Built-in OAuth profiles need no user catalog. */ }
    await writeFile(join(this.directory, "catalog.json"), JSON.stringify({
      ...(profiles === undefined ? {} : { oauth_profiles: profiles }),
      providers: { "pomerado-auth": {
        base_url: `http://127.0.0.1:${address.port}${route}`,
        wire_style: "OpenAiCompatible", credential: this.credential,
      } },
    }), { mode: 0o600 });
    await writeFile(join(this.directory, "settings.json"), JSON.stringify({ mcp_servers: {} }), { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = { ...process.env, ANTE_HOME: this.directory, ANTE_TELEMETRY: "off" };
    delete environment.ANTE_PROFILE;
    this.child = spawn(this.binary, ["serve", "--stdio"], {
      cwd: this.directory,
      env: environment,
      stdio: "pipe",
    });
    // Never forward provider/auth diagnostics: upstream errors can contain credentials.
    this.child.stderr.resume();
    const fail = (error: Error) => {
      this.failure = error;
      this.pending?.reject(error);
    };
    this.child.stdin.on("error", () => fail(new Error("Ante authentication connection closed.")));
    this.child.on("error", () => fail(new Error("Could not start Ante. Install Ante 0.3.1 or later.")));
    this.child.on("exit", () => fail(new Error("Ante authentication process exited.")));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line).event;
        if (event?.Error || (event?.TurnEnd && event.TurnEnd.status !== "Completed"))
          this.pending?.reject(new Error("Ante could not authorize the selected account. Run ante auth login for that account."));
        if (event?.TurnEnd?.status === "Completed" && this.pending?.response)
          this.pending.resolve(this.pending.response);
      } catch { /* Ignore non-protocol output; the operation's deadline still applies. */ }
    });
  }

  private send(op: unknown) {
    // The protocol requires a ULID; random 128-bit data encoded as 26 base32 digits.
    let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
    let id = "";
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (let i = 0; i < 26; i++, value >>= 5n) id = alphabet[Number(value & 31n)] + id;
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify({ id: `op_${id}`, op })}\n`);
  }

  authorize(call: (authorization: string, signal: AbortSignal) => Promise<Response>, signal?: AbortSignal | null): Promise<Response> {
    const operation = this.queue.then(async () => {
      signal?.throwIfAborted();
      await this.start();
      signal?.throwIfAborted();
      return new Promise<Response>((resolve, reject) => {
        const finish = (error?: Error, response?: Response) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (!this.pending) return;
          if (error) this.pending.controller.abort();
          this.pending = undefined;
          if (error) {
            this.failure = error;
            this.send("Interrupt");
            reject(error);
          } else resolve(response!);
        };
        const abort = () => finish(new Error("Subscription request cancelled."));
        const timer = setTimeout(() => finish(new Error("Ante authentication timed out.")), 120_000);
        signal?.addEventListener("abort", abort, { once: true });
        this.pending = { call, controller: new AbortController(), resolve: (response) => finish(undefined, response), reject: (error) => finish(error) };
        this.send({ StartSession: {
          provider: "pomerado-auth", credential: this.credential, model: "auth",
          system_prompt: "Local authentication handshake.", tools: [], no_skills: true,
          enable_auto_memory: false, save_session: false, unattended: true,
        } });
        this.send({ UserInput: "Authenticate." });
      });
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async close() {
    this.closed = true;
    this.pending?.reject(new Error("Ante authentication bridge closed."));
    this.child?.stdin.end();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const child = this.child;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
