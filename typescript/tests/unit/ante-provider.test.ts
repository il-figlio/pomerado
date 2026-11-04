import { expect, it } from "vitest";
import { subscriptionRequest, subscriptionResponse, subscriptionOutput } from "../../src/models/ante-provider.js";
import { solModel } from "../../src/models/models.js";

it("keeps tools, structured output and reasoning while adapting subscription transport", () => {
  const tools = [{ type: "function", name: "read_source", parameters: { type: "object" } }];
  const text = { format: { type: "json_schema", name: "decision", schema: {} } };
  const adapted = subscriptionRequest({
    model: solModel, input: "Read a public heading", tools, text,
    reasoning: { effort: "medium" }, stream: false, store: true, max_output_tokens: 100,
  });
  expect(adapted).toMatchObject({ model: solModel, tools, text, reasoning: { effort: "medium" }, stream: true, store: false });
  expect(adapted).not.toHaveProperty("max_output_tokens");
});

it("assembles a nonstreaming SDK response from the subscription's terminal SSE event", async () => {
  const response = { id: "resp_fixture", status: "completed", output: [{ type: "function_call", name: "read_source", arguments: "{}", call_id: "call_fixture" }] };
  const wire = `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response })}\r\n\r\n`;
  const result = await subscriptionResponse(new Response(wire, { headers: { "Content-Type": "text/event-stream" } }));
  expect(await result.json()).toEqual(response);
});

it("fails a truncated stream instead of inventing a successful model response", async () => {
  await expect(subscriptionResponse(new Response('data: {"type":"response.created"}\n\n'))).rejects.toThrow("terminal");
});

it("retains completed streamed tool items when the subscription terminal omits them", async () => {
  const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read_source", arguments: '{"path":"README.md"}', status: "completed" };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [] } },
  ];
  const result = await subscriptionResponse(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
  expect(await result.json()).toMatchObject({ output: [item] });
});

it("merges a partial terminal output by item id without losing reasoning or duplicating messages", async () => {
  const reasoning = { id: "rs_fixture", type: "reasoning", encrypted_content: "fixture-opaque", summary: [] };
  const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [] };
  const events = [
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.completed", response: { id: "resp_fixture", output: [message] } },
  ];
  const result = await subscriptionResponse(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
  expect(await result.json()).toMatchObject({ output: [reasoning, message] });
});

it("round-trips native patch calls through the subscription's function-only tools", () => {
  const operation = { type: "create_file", path: "src/read.ts", diff: "+export {};" };
  const request = subscriptionRequest({ tools: [{ type: "apply_patch" }], tool_choice: {
    type: "allowed_tools", mode: "auto", tools: [{ type: "apply_patch" }, { type: "function", name: "execute" }],
  }, input: [
    { type: "apply_patch_call", id: "item_patch", call_id: "call_patch", operation, status: "completed" },
    { type: "apply_patch_call_output", call_id: "call_patch", output: "done", status: "completed" },
  ] });
  expect(request.tools).toMatchObject([{ type: "function", name: "apply_patch" }]);
  expect(request.tool_choice).toEqual({ type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "apply_patch" }, { type: "function", name: "execute" }] });
  expect(request.input).toEqual([
    { type: "function_call", id: "item_patch", call_id: "call_patch", name: "apply_patch", arguments: JSON.stringify({ operation }), status: "completed" },
    { type: "function_call_output", call_id: "call_patch", output: "done" },
  ]);
  expect(subscriptionOutput({ output: [{ type: "function_call", id: "item_patch", call_id: "call_patch", name: "apply_patch", arguments: JSON.stringify({ operation }), status: "completed" }] })).toEqual({
    output: [{ type: "apply_patch_call", id: "item_patch", call_id: "call_patch", operation, status: "completed" }],
  });
});
