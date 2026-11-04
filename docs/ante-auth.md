# Mint with Ante authentication

Pomerado can use an OpenAI subscription account already signed in through
[Ante](https://github.com/AntigmaLabs/ante). This opt-in transport needs Ante
0.3.1 or later on `PATH` and access to both of Pomerado's existing models.
It needs no `OPENAI_API_KEY` and never falls back to one.

## Sign in and choose an account

```sh
ante auth login openai
ante auth list --json
```

For a separate named account, sign in with `ante auth login openai/work` or
`ante auth login openai/personal`. Select the exact corresponding credential
reference, such as `oauth:openai/work`. A missing or rejected account fails
the mint; it never silently switches accounts.

## Terminal mint

```sh
env -u OPENAI_API_KEY pomerado mint \
  --ante-credential oauth:openai \
  --url https://example.com \
  --intent 'Return the visible main heading as a heading string. No inputs.' \
  --effect read \
  --out ./example_heading
```

## MCP minter

In the standard MCP configuration, add the credential flag to the mint server:

```json
{
  "mcpServers": {
    "pomerado": {
      "command": "pomerado-mcp",
      "args": ["mint", "--root", "/absolute/path/to/integrations", "--ante-credential", "oauth:openai"]
    }
  }
}
```

Use an installation containing this feature. An older npm release does not
recognize the flag. When building from source, use your Node executable as
`command` and put the absolute path to
`dist/typescript/src/standalone/mcp-cli.js` first in `args`.

Starting the MCP server and listing tools do not start Ante or call a model.
Running a completed integration still needs neither Ante nor model credentials.

## What the bridge does

`ante serve --stdio` exposes an agent-session protocol, not an OpenAI-compatible
HTTP inference endpoint. Pomerado therefore starts a private loopback provider
as an authentication handshake. It gives Ante a temporary home with a symlink
to the existing auth store and a provider pinned to the selected credential.
Ante reads the account, supplies its bearer token, and refreshes it if the
upstream rejects it. The bridge forwards that credential only to the fixed
OpenAI subscription Responses endpoint. The local handshake receives a synthetic
completion; it makes no additional model call.

The temporary auth session has no tools, MCP servers, skills, saved transcript
or auto-memory. Pomerado's actual prompts and tools go directly to the model
through its existing Agents SDK provider interface. Credential values never
appear in configuration, model messages or logs. The bridge closes with the
minting host and removes its temporary configuration. `ANTE_HOME`, when set,
selects the existing Ante auth store.

All three roles—the minter, Guardian and outcome reviewer—use the selected
account. Model IDs remain unchanged. The subscription transport requires SSE
and stateless requests, so the bridge assembles the terminal response for the
SDK's nonstreaming calls. It represents the SDK's native patch editor as a
function on the wire and translates it back before execution, preserving the
existing editor, sandbox and Guardian checks. The subscription endpoint chooses
its output limit; `max_output_tokens` is omitted.

This first adapter supports OpenAI subscription credentials. Ante can also
store named Anthropic and Antix logins, but routing these Pomerado models to
another provider requires a separate model and protocol compatibility pass.
Subscription limits still apply. This feature makes no claim about lower rates
or access to models unavailable on the selected account.

After building, `node tools/verify-ante-auth.mjs` checks named-account selection
and native refresh with the installed Ante, an isolated synthetic auth store
and a local token server. It makes no model calls and does not access real accounts.
