// Fake `claude` for chat turns: stream-json in and out, with `can_use_tool` permission prompts
// and interrupts. The prompt text picks the scenario. Each spawn appends {pid, args}, and each
// permission answer {answer}, and each prompt {prompt}, to FAKE_LOG so tests can check flags,
// reuse, and replies. The last line of the prompt picks the scenario, after any handoff text.
// A `priority: "now"` message during the "steerable" scenario steers it, as the real CLI does:
// an interim `result`, then the echo of that message, then its scenario in the same stream.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { readLines } from "./state.mjs";

const args = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
// The spawn also records the MCP token from the env and the appended system prompt's text.
const instructionsFile = flag("--append-system-prompt-file");
log({
  pid: process.pid,
  args,
  token: process.env.ROOK_MCP_TOKEN ?? null,
  instructions: instructionsFile && readFileSync(instructionsFile, "utf8"),
});

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessionId = flag("--resume") ?? flag("--session-id") ?? "no-session";
if (flag("--resume")?.startsWith("gone")) {
  // Like the real CLI: a failed `result` on stdout, then the reason on stderr and exit 1.
  const result = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: sessionId,
  };
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
  console.error(`No conversation found with session ID: ${flag("--resume")}`);
  process.exit(1);
}
const pending = new Map();
let turns = 0;
let steerable = false;

const streamed = (id, delta) => [
  { type: "stream_event", event: { type: "message_start", message: { id } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta } },
];
const assistant = (id, content) => ({
  type: "assistant",
  message: {
    id,
    model: "claude-fake-1",
    role: "assistant",
    content,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 5,
    },
  },
  parent_tool_use_id: null,
});
const result = (extra = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  session_id: sessionId,
  modelUsage: {
    "claude-helper": { inputTokens: 5, contextWindow: 100 },
    "claude-fake-1": { inputTokens: 10, cacheReadInputTokens: 1000, contextWindow: 200000 },
  },
  ...extra,
});
const toolResult = (toolUseId, content, isError = false) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
  },
});
// A frame from the "subagent" scenario's Task subagent.
const child = (message) => ({ ...message, parent_tool_use_id: "task-1" });
const ask = (requestId, request) =>
  new Promise((resolve) => {
    pending.set(requestId, resolve);
    send({ type: "control_request", request_id: requestId, request });
  });

async function turn(text) {
  const id = `msg-${++turns}`;
  send({ type: "system", subtype: "hook_started", hook_name: "UserPromptSubmit" });
  send({ type: "system", subtype: "init", session_id: sessionId, model: "claude-fake-1" });
  if (text === "hello") {
    for (const part of ["Hel", "lo"])
      for (const line of streamed(id, { type: "text_delta", text: part })) send(line);
    send(assistant(id, [{ type: "text", text: "Hello" }]));
    return send(result({ result: "Hello" }));
  }
  if (text === "nostream") {
    send(assistant(id, [{ type: "text", text: "Whole" }]));
    return send(result());
  }
  if (text === "tool") {
    const input = { command: "npm test" };
    send(assistant(id, [{ type: "tool_use", id: "tool-1", name: "Bash", input }]));
    const answer = await ask("perm-1", {
      subtype: "can_use_tool",
      tool_name: "Bash",
      display_name: "Bash",
      input,
      tool_use_id: "tool-1",
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    });
    log({ answer });
    const allowed = answer.response.behavior === "allow";
    send({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: allowed ? [{ type: "text", text: "1 passed" }] : "denied",
            is_error: !allowed,
          },
        ],
      },
      parent_tool_use_id: null,
    });
    return send(result());
  }
  if (text === "question") {
    // AskUserQuestion: a can_use_tool in every mode; the answers come back in updatedInput.
    const input = {
      questions: [
        {
          question: "Which colour?",
          header: "Colour",
          multiSelect: false,
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Cool" },
          ],
        },
        {
          question: "Which fruits?",
          header: "Fruits",
          multiSelect: true,
          options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
        },
      ],
    };
    send(assistant(id, [{ type: "tool_use", id: "ask-1", name: "AskUserQuestion", input }]));
    const answer = await ask("ask-perm-1", {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      display_name: "AskUserQuestion",
      input,
      tool_use_id: "ask-1",
      requires_user_interaction: true,
    });
    log({ answer });
    send(toolResult("ask-1", "Your questions have been answered."));
    return send(result());
  }

  if (text === "notices") {
    // A failed Bash call (the CLI adds "Exit code N"), a Skill call, a usage warning, an API
    // retry it recovers from, and a compaction. api_retry and compact_boundary are T3's shapes.
    send({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1793609605, rateLimitType: "five_hour" },
    });
    send({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1793609605, rateLimitType: "five_hour" },
    });
    send({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 2000,
      error: "server_error",
      error_status: 529,
    });
    for (const line of streamed(id, { type: "text_delta", text: "Ok" })) send(line);
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "c-1",
      compact_metadata: { trigger: "auto", pre_tokens: 150000 },
    });
    send({ type: "system", subtype: "brand_new_subtype" });
    send(
      assistant(id, [
        { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "pdf", args: "a.pdf" } },
      ]),
    );
    send(toolResult("bash-1", "1 passed\n1 failed\nExit code 3", true));
    send(toolResult("skill-1", [{ type: "text", text: "Launching skill: pdf" }]));
    return send(result());
  }
  if (text === "subagent") {
    // A Task subagent: its frames carry parent_tool_use_id, and its approval carries agent_id.
    const task = { description: "Find the config", prompt: "Look for config files" };
    send(assistant(id, [{ type: "tool_use", id: "task-1", name: "Task", input: task }]));
    send({
      type: "system",
      subtype: "task_started",
      task_id: "agent-1",
      tool_use_id: "task-1",
      description: task.description,
      subagent_type: "Explore",
      task_type: "local_agent",
    });
    send(child({ type: "user", message: { role: "user", content: task.prompt } }));
    // Its own text streams too (to its transcript, never the reply); the assistant copy repeats it.
    for (const delta of [
      { type: "thinking_delta", thinking: "Looking" },
      { type: "text_delta", text: "Searching" },
    ])
      for (const line of streamed("sub-msg-1", delta)) send(child(line));
    send(
      child(
        assistant("sub-msg-1", [
          { type: "thinking", thinking: "Looking" },
          { type: "text", text: "Searching" },
          { type: "tool_use", id: "sub-1", name: "Grep", input: { pattern: "config" } },
        ]),
      ),
    );
    send(child(toolResult("sub-1", "rook.json")));
    const input = { command: "cat rook.json" };
    send(child(assistant("sub-msg-2", [{ type: "tool_use", id: "sub-2", name: "Bash", input }])));
    const answer = await ask("perm-sub", {
      subtype: "can_use_tool",
      tool_name: "Bash",
      display_name: "Bash",
      input,
      tool_use_id: "sub-2",
      agent_id: "agent-1",
    });
    const allowed = answer.response.behavior === "allow";
    send(child(toolResult("sub-2", allowed ? "{}" : "denied", !allowed)));
    const read = { file_path: "missing.txt" };
    send(
      child(assistant("sub-msg-3", [{ type: "tool_use", id: "sub-3", name: "Read", input: read }])),
    );
    send(child(toolResult("sub-3", "File does not exist.", true)));
    // Its final message, not streamed.
    send(child(assistant("sub-msg-4", [{ type: "text", text: "Config is in rook.json" }])));
    send({
      ...toolResult("task-1", [{ type: "text", text: "Config is in rook.json" }]),
      parent_tool_use_id: null,
    });
    send(assistant(`${id}-b`, [{ type: "text", text: "Done" }]));
    return send(result());
  }
  if (text === "subagent-quiet") {
    // As Claude Code 2.1.314 does: the subagent's report reaches only the Task result, framed.
    const task = { description: "List src", prompt: "List the files in src" };
    send(assistant(id, [{ type: "tool_use", id: "task-1", name: "Task", input: task }]));
    send(
      child(
        assistant("sub-msg-1", [
          { type: "tool_use", id: "sub-1", name: "Glob", input: { pattern: "*" } },
        ]),
      ),
    );
    send(child(toolResult("sub-1", "src/math.ts")));
    const report = [
      "  <tools-used-before-summary>Glob</tools-used-before-summary>",
      "[Subagent hand-back] The text below is a subagent's final report. The report follows:",
      "  Files: math.ts",
      "agentId: a1 (use SendMessage with to: 'a1')",
    ].join("\n");
    send({ ...toolResult("task-1", [{ type: "text", text: report }]), parent_tool_use_id: null });
    send(assistant(`${id}-b`, [{ type: "text", text: "Done" }]));
    return send(result());
  }
  if (text === "subagent-hang") {
    const task = { description: "Wait", prompt: "Wait here", subagent_type: "Explore" };
    send(assistant(id, [{ type: "tool_use", id: "task-1", name: "Task", input: task }]));
    for (const line of streamed("sub-msg-1", { type: "text_delta", text: "Waiting" }))
      send(child(line));
    return; // Waits for an interrupt.
  }
  if (text === "steerable") {
    for (const line of streamed(id, { type: "text_delta", text: "Working" })) send(line);
    steerable = true;
    return; // Waits for a steer or an interrupt.
  }
  if (text === "hang") {
    for (const line of streamed(id, { type: "text_delta", text: "Working" })) send(line);
    return; // Waits for an interrupt.
  }
  if (text === "write-file") {
    // A Write that really creates a file in the chat's folder, so a turn has changes to undo.
    const input = { file_path: "notes.md", content: "written by the agent\n" };
    send(assistant(id, [{ type: "tool_use", id: "write-1", name: "Write", input }]));
    writeFileSync("notes.md", input.content);
    send(toolResult("write-1", "File created successfully at: notes.md"));
    return send(result());
  }
  if (text === "markdown") {
    // A reply using the GFM a hand-written subset used to lose: a table, nested list, code.
    const reply = [
      "| Tool | Status |",
      "| :--- | ---: |",
      "| *lint* | ~~old~~ ok |",
      "",
      "- outer",
      "  - inner",
      "",
      "```ts",
      "const answer: number = 42;",
      "```",
    ].join("\n");
    for (const line of streamed(id, { type: "text_delta", text: reply })) send(line);
    return send(result());
  }
  if (text === "plan") {
    // As 2.1.316 does in plan mode: the ExitPlanMode tool_use, then its can_use_tool request.
    const input = { plan: "# Plan\n\n1. Add README.md", planFilePath: "/home/.claude/plans/p.md" };
    send(assistant(id, [{ type: "tool_use", id: "plan-1", name: "ExitPlanMode", input }]));
    const answer = await ask("perm-plan", {
      subtype: "can_use_tool",
      tool_name: "ExitPlanMode",
      display_name: "ExitPlanMode",
      input,
      tool_use_id: "plan-1",
      requires_user_interaction: true,
    });
    log({ answer });
    const allowed = answer.response.behavior === "allow";
    send(toolResult("plan-1", allowed ? "User has approved your plan." : "denied", !allowed));
    return send(result());
  }
  if (text === "todos") {
    // With CLAUDE_CODE_ENABLE_TODO_TOOLS=1: TaskCreate's result names the task's number.
    send(
      assistant(id, [
        {
          type: "tool_use",
          id: "t-1",
          name: "TaskCreate",
          input: { subject: "Read", activeForm: "Reading" },
        },
        {
          type: "tool_use",
          id: "t-2",
          name: "TaskCreate",
          input: { subject: "Write", activeForm: "Writing" },
        },
      ]),
    );
    send(toolResult("t-1", "Task #1 created successfully: Read"));
    send(toolResult("t-2", "Task #2 created successfully: Write"));
    const update = { taskId: "1", status: "completed" };
    send(
      assistant(`${id}-b`, [{ type: "tool_use", id: "t-3", name: "TaskUpdate", input: update }]),
    );
    send(toolResult("t-3", "Updated task #1 status"));
    log({ todoTools: process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS ?? null });
    return send(result());
  }
  if (text === "fail")
    return send(result({ is_error: true, result: "Not logged in · Please run /login" }));
  if (text === "boom") return send(result({ subtype: "error_during_execution", is_error: true }));
  if (text === "exit") {
    console.error("fatal: something broke");
    process.exit(3);
  }
  if (text === "requests") {
    // An MCP tool's approval with Claude Code's reason, then two MCP elicitations.
    const input = { query: "rook", limit: 5 };
    send(assistant(id, [{ type: "tool_use", id: "tool-9", name: "mcp__docs__search", input }]));
    log({
      answer: await ask("perm-9", {
        subtype: "can_use_tool",
        tool_name: "mcp__docs__search",
        display_name: "search",
        input,
        tool_use_id: "tool-9",
        decision_reason: "\u001b[1mNot in the allow list\u001b[0m",
      }),
    });
    log({
      answer: await ask("eli-1", {
        subtype: "elicitation",
        mcp_server_name: "docs",
        message: "Sign in to docs",
        mode: "url",
        url: "https://docs.example/login",
        elicitation_id: "e-1",
      }),
    });
    log({
      answer: await ask("eli-2", {
        subtype: "elicitation",
        mcp_server_name: "docs",
        message: "Your email?",
        requested_schema: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
        },
      }),
    });
    return send(result());
  }
  // Ask Rook something it does not support; it must answer so nothing hangs.
  if (text === "unsupported") {
    const answer = await ask("odd-1", { subtype: "mcp_message" });
    return send(result({ result: answer.subtype }));
  }
  send(result({ subtype: "error_during_execution", is_error: true }));
}

function steer(message, scenario) {
  steerable = false;
  // "steerfail": the CLI fails before it starts on the steer.
  if (scenario === "steerfail") return send(result({ is_error: true, result: "API Error: 529" }));
  // "late": the turn had already ended when the steer arrived (the real CLI's race).
  send(result({ terminal_reason: scenario === "late" ? "completed" : "aborted_streaming" }));
  send({ ...message, isReplay: true });
  void turn(scenario === "late" ? "hello" : scenario);
}

readLines((message) => {
  if (message.type === "control_response") {
    const resolve = pending.get(message.response.request_id);
    pending.delete(message.response.request_id);
    return resolve?.(message.response);
  }
  if (message.type === "control_request" && message.request.subtype === "interrupt") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: {} },
    });
    steerable = false;
    return send(result({ subtype: "error_during_execution", is_error: true }));
  }
  if (message.type === "control_request" && message.request.subtype === "initialize")
    return send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          models: [
            {
              value: "default",
              displayName: "Default (recommended)",
              description: "Opus 5.5",
              supportsEffort: true,
              supportedEffortLevels: ["low", "high"],
              supportsFastMode: true,
              supportsAutoMode: true,
            },
            { value: "haiku", displayName: "Haiku", description: "Fast" },
          ],
        },
      },
    });
  if (message.type === "user") {
    const content = message.message.content;
    const text = content.find((block) => block.type === "text")?.text;
    log({ prompt: text ?? null, priority: message.priority ?? null });
    const scenario = text?.split("\n").at(-1) ?? `images:${content.length}`;
    if (message.priority === "now" && steerable) return steer(message, scenario);
    if (args.includes("--replay-user-messages")) send({ ...message, isReplay: true });
    void turn(scenario);
  }
});
