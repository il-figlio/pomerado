import OpenAI from "openai";
import { OpenAIProvider } from "@openai/agents";
import { AnteAuth } from "./ante-auth.js";

const endpoint = "https://chatgpt.com/backend-api/codex/responses";

// The subscription endpoint does not accept the API's native apply_patch tool. Keep
// the same SDK editor and guards by translating only its wire representation.
const patchTool = {
  type: "function", name: "apply_patch", strict: false,
  description: "Apply one structured file operation. For create_file, diff is the file's lines prefixed with +. For update_file, diff uses V4A hunks. For delete_file, only type and path are needed.",
  parameters: { type: "object", properties: { operation: {
    type: "object", properties: {
      type: { type: "string", enum: ["create_file", "update_file", "delete_file"] },
      path: { type: "string" }, diff: { type: "string" }, move_to: { type: "string" },
    }, required: ["type", "path"], additionalProperties: false,
  } }, required: ["operation"], additionalProperties: false },
};

const subscriptionInput = (item: Record<string, unknown>): Record<string, unknown> => {
  if (item.type === "apply_patch_call") return {
    type: "function_call", id: item.id, call_id: item.call_id, name: "apply_patch",
    arguments: JSON.stringify({ operation: item.operation }), status: item.status,
  };
  if (item.type === "apply_patch_call_output") return {
    type: "function_call_output", call_id: item.call_id, output: item.output ?? "",
  };
  return item;
};

export const subscriptionOutput = (response: Record<string, unknown>): Record<string, unknown> => ({
  ...response,
  ...(Array.isArray(response.output) ? { output: response.output.map((item) => {
    if (item.type !== "function_call" || item.name !== "apply_patch") return item;
    const { operation } = JSON.parse(item.arguments);
    return { type: "apply_patch_call", id: item.id, call_id: item.call_id, status: item.status, operation };
  }) } : {}),
});

/** Subscription Responses accepts streaming, stateless calls and chooses its output limit. */
export const subscriptionRequest = (body: Record<string, unknown>) => {
  const { max_output_tokens: _limit, ...request } = body;
  const choice = request.tool_choice as { type?: string; tools?: Array<{ type?: string }> } | undefined;
  const toolChoice = choice?.type === "apply_patch" ? { type: "function", name: "apply_patch" }
    : choice?.type === "allowed_tools" ? { ...choice, tools: choice.tools?.map((entry) => entry.type === "apply_patch" ? { type: "function", name: "apply_patch" } : entry) }
    : choice;
  return {
    ...request, store: false, stream: true, instructions: request.instructions ?? "",
    ...(Array.isArray(request.tools) ? { tools: request.tools.map((entry) => entry.type === "apply_patch" ? patchTool : entry) } : {}),
    ...(Array.isArray(request.input) ? { input: request.input.map(subscriptionInput) } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

/** The Agents SDK's nonstreaming model interface still needs the full terminal response. */
export const subscriptionResponse = async (response: Response): Promise<Response> => {
  if (!response.ok) return response;
  if (!response.body) throw new Error("Subscription response had no terminal event.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const items = new Map<number, Record<string, unknown>>();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (event.type === "response.output_item.done" && Number.isInteger(event.output_index) && event.item)
          items.set(event.output_index, event.item);
        if (["response.completed", "response.incomplete", "response.failed"].includes(event.type) && event.response) {
          // Subscription responses can omit tool calls from the terminal output array.
          // Completed item events are authoritative too; never lose their tool calls.
          for (const [index, item] of (event.response.output ?? []).entries()) {
            const existing = [...items].find(([, entry]) => item.id !== undefined && entry.id === item.id);
            const target = existing?.[0] ?? (items.has(index) ? Math.max(...items.keys()) + 1 : index);
            items.set(target, item);
          }
          const output = [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
          return Response.json(subscriptionOutput({ ...event.response, output }), { status: response.status });
        }
        if (event.type === "error") throw new Error("Subscription stream returned a provider error.");
      }
      if (done) break;
      if (buffer.length > 32 * 1024 * 1024) throw new Error("Subscription event exceeded the transport limit.");
    }
    throw new Error("Subscription stream ended without a terminal event.");
  } finally {
    await reader.cancel();
  }
};

/** Opt-in OpenAI subscription transport. Every request is authorized through Ante serve;
 * there is no credential-file parser, token refresh implementation or API-key fallback. */
export const makeAnteProvider = (credential = "oauth:openai", binary = "ante") => {
  const auth = new AnteAuth(credential, binary);
  const client = new OpenAI({
    // SDK construction needs a nonempty string; this placeholder never leaves this transport.
    apiKey: "ante-managed", baseURL: "https://chatgpt.com/backend-api/codex",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== endpoint || request.method !== "POST")
        throw new Error("Ante subscription transport permits only the fixed Responses endpoint.");
      const body = await request.json() as Record<string, unknown>;
      const headers = new Headers({ "Content-Type": "application/json", Accept: "text/event-stream", originator: "ante", "OpenAI-Beta": "responses=experimental" });
      const response = await auth.authorize(async (authorization, signal) => {
        headers.set("Authorization", authorization);
        // Subscription accounts may require their account id, encoded in the access token.
        try {
          const claims = JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString("utf8"));
          const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
          if (typeof account === "string") headers.set("ChatGPT-Account-Id", account);
        } catch { /* Opaque bearer tokens are valid too. */ }
        return fetch(endpoint, {
          method: "POST", headers, body: JSON.stringify(subscriptionRequest(body)),
          signal: AbortSignal.any([request.signal, signal]), redirect: "error",
        });
      }, request.signal);
      return body.stream === true ? response : subscriptionResponse(response);
    },
  });
  const provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
  return {
    provider,
    close: async () => { await provider.close(); await auth.close(); },
  };
};
