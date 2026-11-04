#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Schema } from "effect";
import { readArtifact, writeArtifact } from "./artifact-files.js";
import { createPomerado } from "./pomerado.js";
import type { LocalMintOutcome, PomeradoOptions } from "./contracts.js";
import type { JobBuildBlocked, MintStopReason } from "../mint/contracts.js";
import { RunOutcomeFailure } from "./run-report.js";
import { makeTerminalAsker } from "../inputs/terminal.js";
import { anteOptions } from "./ante-options.js";

const usage = `Pomerado

  pomerado mint --url URL --intent TEXT --out DIRECTORY [--input JSON]
  pomerado run --artifact DIRECTORY --url URL [--input JSON]

Options
  --endpoint URL          Attach to a native Playwright websocket endpoint
  --headed                Show locally launched Chromium
  --effect read|write|ask  Mint authority (default ask)
  --timeout-seconds N      Session budget (default 1200)
  --ante-credential REF    Use Ante's OpenAI subscription login (oauth:openai[/account])

Mint with OPENAI_API_KEY or --ante-credential. A run makes no model request and needs no key.
A run ignores --intent and --effect. Questions are asked in this terminal.
`;

const selectedEffect = (supplied: string | undefined) =>
  Schema.decodeUnknown(Schema.Literal("read", "write", "ask"))(supplied ?? "ask").pipe(
    Effect.mapError(() => new Error("Choose a supported --effect. See --help.")),
  );
const selectedTimeout = (supplied: string | undefined) =>
  Effect.try(() => {
    const timeoutMs = Number(supplied ?? "1200") * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("--timeout-seconds must be positive.");
    return timeoutMs;
  });

const readOptions = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() =>
      parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
          help: { type: "boolean", short: "h" },
          url: { type: "string" },
          intent: { type: "string" },
          out: { type: "string" },
          artifact: { type: "string" },
          input: { type: "string" },
          endpoint: { type: "string" },
          headed: { type: "boolean" },
          effect: { type: "string" },
          "timeout-seconds": { type: "string" },
          "ante-credential": { type: "string" },
        },
      }),
    );
    const { values, positionals } = parsed;
    const command = positionals[0];
    if (values.help || command === undefined) {
      return undefined;
    }
    if ((command !== "mint" && command !== "run") || positionals.length !== 1)
      return yield* Effect.fail(new Error("Use mint or run. See --help."));
    if (values.url === undefined) return yield* Effect.fail(new Error("--url is required."));
    if (command === "mint" && values.intent === undefined)
      return yield* Effect.fail(new Error("--intent is required to mint."));
    // Guardian checked the intent and authority when the artifact was minted, so a run ignores both.
    const effect = command === "mint" ? yield* selectedEffect(values.effect) : undefined;
    const timeoutMs = yield* selectedTimeout(values["timeout-seconds"]);
    const input = yield* Effect.try({
      try: () => JSON.parse(values.input ?? "{}") as unknown,
      catch: (cause) => new Error("--input must be valid JSON.", { cause }),
    });
    return {
      values,
      command,
      timeoutMs,
      request: {
        url: values.url,
        intent: values.intent ?? "",
        input,
        ...(effect === undefined ? {} : { effect }),
      },
    };
  });

/** A few words on each ending a stopped mint names by its code. */
const stopMeanings: Readonly<Record<MintStopReason | JobBuildBlocked["reason"], string>> = {
  final_text_without_tool: "the build agent kept answering without acting",
  turn_budget_spent: "the build used every model call it may make",
  model_quota_exhausted: "the model provider's quota is spent",
  sign_in_failed: "signing in to the site failed",
  account_locked: "the site says the account is locked",
  question_unanswered: "a question the build needed went unanswered",
  owner_declined: "you declined a step the build needs",
  owner_ended: "you chose to end the build",
  site_lacks_capability: "the site can't do what was asked",
  site_declined: "the site declined the request",
  site_unavailable: "the site was temporarily down",
  policy: "a safety review ruled the build out",
  host_refused: "a host check refused a step the build needs",
  caller_input: "the request itself stops the build",
  agent_declined: "the build agent declined the request",
  host_unavailable: "a service the build relies on failed, not the task",
  new_mint_recommended: "the task changed enough to need a new build",
  not_supported_yet: "this kind of build isn't supported yet",
};

/**
 * The lines a mint that saved nothing prints under its summary: its codes and counts. Each code
 * is a fixed literal, and the outcome holds no step's output, so no secret prints.
 */
const stoppedLines = (result: LocalMintOutcome) => {
  const why = result.stopReason ?? result.blocked?.reason;
  const denial = result.publicationDenial;
  const denialCodes = [denial?.reason, denial?.category].filter((code) => code !== undefined);
  const failed = result.executions.filter(
    (execution) => execution.status === "failed" || execution.status === "unsupported",
  );
  const last = failed.at(-1);
  const lastFailure = last?.siteAccess?.code ?? last?.terminalFailure;
  const writes = (result.writes ?? []).filter((write) => write.status !== "not_applied").length;
  return [
    why === undefined
      ? "Why: no reason recorded; the full report's diagnostics hold what the host saw"
      : `Why: ${stopMeanings[why]} (${why})`,
    ...(result.hostFailure === undefined ? [] : [`Host failure: ${result.hostFailure}`]),
    ...(denial === undefined
      ? []
      : [
          `Guardian: denied the last publication${denialCodes.length === 0 ? "" : ` (${denialCodes.join(", ")})`}`,
        ]),
    ...(result.noResponse === undefined
      ? []
      : [
          `Question: went unanswered${result.noResponse.possibleCommit ? "; a step may have changed the site" : ""}`,
        ]),
    `Steps: ${result.executions.length} run, ${failed.length} failed.${lastFailure === undefined ? "" : ` Last failure: ${lastFailure}`}`,
    `Writes that may have gone through: ${writes === 0 ? "none" : `${writes}; check the website before minting again`}`,
  ]
    .map((line) => `  ${line}\n`)
    .join("");
};

/**
 * The outcome as `mint-report.json` holds it. Each JSON diagnostic is parsed so the filter reaches
 * inside it too. The filter drops every `rationale`, `advice`, `explanation` and `responseRulings`
 * key: the models' words about steps and publications, such as Guardian's rationale and findings
 * and the outcome reviewer's explanation, which may quote what a page returned, such as a session
 * cookie. The summary stays as the harness wrote it for its caller, which may quote Guardian's
 * rationale. Credentials and one-time codes are redacted before any model reads them.
 */
const reportText = (result: LocalMintOutcome) =>
  `${JSON.stringify(
    {
      ...result,
      diagnostics: result.diagnostics.map((entry) => {
        try {
          return JSON.parse(entry) as unknown;
        } catch {
          return entry;
        }
      }),
    },
    (key, value: unknown) =>
      key === "rationale" ||
      key === "advice" ||
      key === "explanation" ||
      key === "responseRulings"
        ? undefined
        : value,
    2,
  )}\n`;

/**
 * The terminal CLI. `overrides` holds what a caller that starts it sets, such as model providers;
 * the CLI sets the terminal asker, and the browser and session budget from `args`.
 */
const runCli = (
  args: readonly string[],
  overrides: Omit<PomeradoOptions, "ask" | "browser" | "timeoutMs">,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const options = yield* readOptions(args);
      if (options === undefined) {
        process.stdout.write(usage);
        return;
      }
      const { values, command, timeoutMs, request } = options;
      const pomerado = yield* createPomerado({
        ...overrides,
        ...(command === "mint" ? yield* anteOptions(values["ante-credential"]) : {}),
        ask: makeTerminalAsker(),
        timeoutMs,
        browser: {
          headless: !values.headed,
          ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
        },
      });
      if (command === "run") {
        if (values.artifact === undefined)
          return yield* Effect.fail(new Error("--artifact is required."));
        const artifact = yield* readArtifact(resolve(values.artifact));
        const output = yield* pomerado
          .run(artifact, {
            url: request.url,
            intent: request.intent,
            input: request.input,
          })
          .pipe(
            // A write that may have applied still prints what its script returned; the error
            // that follows says it is unconfirmed.
            Effect.tapError((failure) =>
              Effect.sync(() => {
                if (failure instanceof RunOutcomeFailure && failure.unconfirmed !== undefined)
                  process.stdout.write(
                    `${JSON.stringify(failure.unconfirmed.output, null, 2)}\n`,
                  );
              }),
            ),
          );
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return;
      }
      if (values.out === undefined) return yield* Effect.fail(new Error("--out is required."));
      const outputDirectory = resolve(values.out);
      // Creating the destination first prevents a long mint from overwriting an existing project.
      yield* Effect.tryPromise(() => mkdir(dirname(outputDirectory), { recursive: true }));
      yield* Effect.tryPromise({
        try: () => mkdir(outputDirectory),
        catch: (cause) => new Error("--out must name a new directory.", { cause }),
      });
      const result = yield* pomerado.mint(request);
      if (result.artifact === undefined) {
        // The lines print before the report is written, so a failed write still shows them.
        process.stderr.write(`${result.summary}\n${stoppedLines(result)}`);
        process.exitCode = 1;
        // The outcome, which has no artifact here, stays on this machine beside the build.
        const report = join(outputDirectory, "mint-report.json");
        yield* Effect.tryPromise(() => writeFile(report, reportText(result)));
        process.stderr.write(`  Full report: ${report}\n`);
        return;
      }
      const artifact = result.artifact;
      yield* writeArtifact(outputDirectory, artifact);
      process.stdout.write(`Saved ${artifact.entrypoint} and its schemas to ${outputDirectory}\n`);
    }),
  );

/**
 * Runs the terminal CLI on `args` and sets the exit code: 1 when the command fails or a mint
 * saves nothing. `options` lets a caller start it with its own model providers, as
 * `startMcpCli` does for the MCP CLI. The browser tests start the compiled CLI this way with
 * recorded providers, since no test may call a real model.
 */
export const startCli = (
  args: readonly string[] = process.argv.slice(2),
  options: Omit<PomeradoOptions, "ask" | "browser" | "timeoutMs"> = {},
): void => {
  const cancel = Effect.runCallback(runCli(args, options), {
    onExit: (result) => {
      if (Exit.isFailure(result)) {
        const failure = Cause.squash(result.cause);
        process.stderr.write(
          `${failure instanceof Error ? failure.message : "Pomerado failed."}\n`,
        );
        process.exitCode = 1;
      }
    },
  });
  process.once("SIGINT", () => cancel());
  process.once("SIGTERM", () => cancel());
};

/** npm links a bin to this file, so the entry path counts once its links are resolved. */
const isEntrypoint = (path: string | undefined) => {
  if (path === undefined) return false;
  try {
    return pathToFileURL(realpathSync(path)).href === import.meta.url;
  } catch {
    return false;
  }
};

if (isEntrypoint(process.argv[1])) startCli();
