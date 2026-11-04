import { Effect } from "effect";
import { expect, it } from "vitest";
import { anteOptions } from "../../src/standalone/ante-options.js";

it("pins every minting role to the same Ante provider without starting an auth handshake", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const options = yield* anteOptions("oauth:openai/work");
    expect("minterProvider" in options).toBe(true);
    if ("minterProvider" in options) {
      expect(options.guardianProvider).toBe(options.minterProvider);
      expect(options.outcomeReviewerProvider).toBe(options.minterProvider);
    }
  })));
});

it("leaves the default providers alone unless Ante is explicitly selected", async () => {
  expect(await Effect.runPromise(Effect.scoped(anteOptions(undefined)))).toEqual({});
});
