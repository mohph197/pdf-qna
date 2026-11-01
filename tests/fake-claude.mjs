// A stand-in for the claude CLI, used by the native host and end-to-end
// tests so they never run Claude Code or reach the network. It answers
// `--version`, and `-p` runs with the stream-json events the host reads.
//
//   FAKE_CLAUDE_REPLIES  JSON file: { answers, systems, prompt } structured
//                        outputs, picked by the --json-schema's properties
//   FAKE_CLAUDE_LOG      file to append { args, stdin } of every run to
//   FAKE_CLAUDE_URL      the page web searches "find" (default below)
//
// A prompt containing FAKE_NOT_LOGGED_IN gets Claude Code's login error.

import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = (evt) => process.stdout.write(`${JSON.stringify(evt)}\n`);

if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, stdin })}\n`);

out({ type: "system", subtype: "init", model: flag("--model") ?? "claude-opus-5-5", tools: (flag("--tools") ?? "").split(",").filter(Boolean) });

if (stdin.includes("FAKE_NOT_LOGGED_IN")) {
  out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", usage: {} });
  process.exit(1);
}

if ((flag("--tools") ?? "").includes("WebSearch")) {
  const url = process.env.FAKE_CLAUDE_URL ?? "https://github.com/KaimingHe/deep-residual-networks";
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "resnet official code" } }] } });
  out({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: `Web search results for query: "resnet official code"\n\nLinks: ${JSON.stringify([{ title: "deep-residual-networks", url }])}`,
        },
      ],
    },
  });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "WebFetch", input: { url: `${url}/blob/master/README.md`, prompt: "Summarize" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "The README." }] } });
}

const schema = JSON.parse(flag("--json-schema") ?? "{}");
const replies = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_REPLIES, "utf8"));
const key = Object.keys(schema.properties ?? {}).find((k) => k in replies);
const structured = key === "prompt" ? { prompt: replies.prompt, web_sources: replies.web_sources ?? [] } : { [key]: replies[key] };
out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(structured) } } });
out({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  structured_output: structured,
  usage: { input_tokens: 17000, output_tokens: 400, cache_read_input_tokens: 0 },
});
