import { Effect } from "effect";
import { makeAnteProvider } from "../models/ante-provider.js";

/** All model roles share the selected account; none falls back to an API key. */
export const anteOptions = (credential: string | undefined) =>
  credential === undefined
    ? Effect.succeed({})
    : Effect.acquireRelease(
        Effect.try(() => makeAnteProvider(credential)),
        (ante) => Effect.promise(() => ante.close()),
      ).pipe(Effect.map(({ provider }) => ({
        minterProvider: provider,
        guardianProvider: provider,
        outcomeReviewerProvider: provider,
      })));
