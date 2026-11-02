// Fake `codex app-server` for chat turns. Every request is logged to the state file so tests
// can assert what Rook sent; threads persist there too, so a new process can resume them.
// The prompt picks the scenario: "approve", "subagent" (and "subagent-v2", "-early", "-nested",
// "-fail", "-hang"), "elicit", "requests", "edit", "hang" (which turn/steer can end), "hang-command", "fail",
// "die", or a plain reply.
import * as NodePath from "node:path";

import { readLines, readState, writeState } from "./state.mjs";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const log = (entry) => {
  const state = readState({ requests: [], threads: [] });
  writeState({ ...state, requests: [...state.requests, entry] });
};

const MODELS = [
  {
    id: "gpt-fast",
    displayName: "GPT Fast",
    description: "Quick.",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "high", description: "" },
    ],
    defaultReasoningEffort: "low",
    inputModalities: ["text", "image"],
    serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }],
  },
  {
    id: "gpt-hidden",
    displayName: "Hidden",
    description: "",
    hidden: true,
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    serviceTiers: [],
  },
  {
    id: "gpt-plain",
    displayName: "GPT Plain",
    description: "",
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    serviceTiers: [],
  },
];

let nextRequest = 1;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `srv-${nextRequest++}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

// A `thread/tokenUsage/updated` payload.
const usage = (window) => ({
  total: { totalTokens: 9000 },
  last: { totalTokens: 1234, inputTokens: 1200, cachedInputTokens: 0, outputTokens: 34 },
  modelContextWindow: window,
});

let turns = 0;
const running = new Map(); // threadId -> turnId waiting for an interrupt
const cwds = new Map(); // threadId -> cwd from thread/start or thread/resume
const terminals = new Map(); // threadId -> background terminals ({ itemId, processId })

// Subagent scenario helpers.
// Shapes from codex app-server 0.156 transcripts and the 0.162 schema: receiverThreadIds fill
// in when a spawn completes; multi-agent v2 announces children with subAgentActivity items.
const on = (thread) => ({ threadId: thread, turnId: `${thread}-turn` });
const emitItem = (thread, method, value) => notify(method, { ...on(thread), item: value });
const spawn = (thread, id, child) => {
  const value = {
    type: "collabAgentToolCall",
    id,
    tool: "spawnAgent",
    status: "inProgress",
    senderThreadId: thread,
    receiverThreadIds: [],
    prompt: "Check the tests\nthen report",
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  };
  emitItem(thread, "item/started", value);
  return () =>
    emitItem(thread, "item/completed", {
      ...value,
      status: "completed",
      receiverThreadIds: [child],
      agentsStates: { [child]: { status: "pendingInit", message: null } },
    });
};
const activity = (thread, id, kind, child) => {
  for (const method of ["item/started", "item/completed"])
    emitItem(thread, method, {
      type: "subAgentActivity",
      id,
      kind,
      agentThreadId: child,
      agentPath: "/root/say_hello",
      model: null,
      reasoningEffort: null,
    });
};
const childTurn = (child, status = "inProgress", error = null) => ({
  id: `${child}-turn`,
  items: [],
  status,
  error,
});

async function play(threadId, turnId, prompt, cwd) {
  const turn = (status, error = null) => ({ id: turnId, items: [], status, error });
  const text = (delta) =>
    notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg", delta });
  const done = (status = "completed", error = null) =>
    notify("turn/completed", { threadId, turn: turn(status, error) });
  notify("turn/started", { threadId, turn: turn("inProgress") });
  // Another thread's traffic must not reach this turn.
  notify("item/agentMessage/delta", { threadId: "other", turnId: "x", itemId: "m", delta: "!" });

  if (prompt === "approve") {
    const item = {
      type: "commandExecution",
      id: "cmd-1",
      command: "npm test",
      cwd,
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    };
    notify("item/started", { threadId, turnId, item });
    const { decision } = await ask("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "cmd-1",
      command: "npm test",
      cwd,
      reason: "Runs the tests",
    });
    log({ method: "approvalAnswer", params: { decision } });
    const accepted = decision === "accept" || decision === "acceptForSession";
    notify("item/completed", {
      threadId,
      turnId,
      item: accepted
        ? { ...item, status: "completed", aggregatedOutput: "ok", exitCode: 1 }
        : { ...item, status: "declined" },
    });
    text(accepted ? "ran" : "skipped");
    return done();
  }
  if (prompt.startsWith("subagent")) {
    const startChild = (child) => {
      notify("turn/started", { threadId: child, turn: childTurn(child) });
      emitItem(child, "item/completed", {
        type: "userMessage",
        id: `${child}-user`,
        content: [{ type: "text", text: "Check the tests", text_elements: [] }],
      });
      // Child reasoning and text are the subagent's, not the reply.
      notify("item/reasoning/summaryTextDelta", {
        ...on(child),
        itemId: `${child}-r`,
        delta: "Hm",
      });
    };
    const command = {
      type: "commandExecution",
      id: "child-cmd",
      command: "npm test",
      cwd,
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    };
    const approve = (child) => {
      emitItem(child, "item/started", command);
      return ask("item/commandExecution/requestApproval", {
        ...on(child),
        itemId: "child-cmd",
        command: "npm test",
        cwd,
        reason: null,
      }).then(({ decision }) => log({ method: "approvalAnswer", params: { decision } }));
    };
    const finishChild = (child, fail = false) => {
      emitItem(child, "item/completed", {
        ...command,
        status: "completed",
        aggregatedOutput: "ok",
        exitCode: 1,
      });
      if (fail) {
        notify("error", {
          ...on(child),
          willRetry: false,
          error: { message: "Child exploded\n    at secret/stack.rs:1" },
        });
        return notify("turn/completed", { threadId: child, turn: childTurn(child, "failed") });
      }
      for (const delta of ["Tests ", "fail"])
        notify("item/agentMessage/delta", { ...on(child), itemId: `${child}-msg`, delta });
      emitItem(child, "item/completed", {
        type: "agentMessage",
        id: `${child}-msg`,
        text: "Tests fail",
        phase: "final_answer",
      });
      notify("turn/completed", { threadId: child, turn: childTurn(child, "completed") });
    };
    const finish = () => {
      const wait = {
        type: "collabAgentToolCall",
        id: "wait-1",
        tool: "wait",
        status: "inProgress",
        senderThreadId: threadId,
        receiverThreadIds: ["child-1"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      };
      emitItem(threadId, "item/started", wait);
      emitItem(threadId, "item/completed", { ...wait, status: "completed" });
      text("done");
      return done();
    };

    if (prompt === "subagent-v2") {
      activity(threadId, "spawn-1", "started", "child-1");
      startChild("child-1");
      await approve("child-1");
      finishChild("child-1");
      activity(threadId, "activity-2", "completed", "child-1");
      return finish();
    }
    if (prompt === "subagent-early") {
      // The 0.162 Thread names its parent, so a child can be known before its spawn completes.
      const spawned = spawn(threadId, "spawn-1", "child-1");
      notify("thread/started", {
        thread: { id: "child-1", parentThreadId: threadId, agentNickname: "Ada", agentRole: null },
      });
      startChild("child-1");
      await approve("child-1");
      spawned();
      finishChild("child-1");
      return finish();
    }
    spawn(threadId, "spawn-1", "child-1")();
    startChild("child-1");
    if (prompt === "subagent-nested") {
      spawn("child-1", "spawn-2", "child-2")();
      startChild("child-2");
      await approve("child-2");
      finishChild("child-2");
      emitItem("child-1", "item/completed", {
        type: "agentMessage",
        id: "child-1-msg",
        text: "Relayed",
        phase: "final_answer",
      });
      notify("turn/completed", { threadId: "child-1", turn: childTurn("child-1", "completed") });
      return finish();
    }
    if (prompt === "subagent-hang") {
      running.set(threadId, turnId);
      await approve("child-1");
      // An approval after the parent turn ended has no one to ask.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return approve("child-1");
    }
    if (prompt === "subagent-long") {
      for (let i = 0; i < 300; i++)
        emitItem("child-1", "item/completed", {
          ...command,
          id: `step-${i}`,
          command: `echo step ${i}`.padEnd(40, "."),
          status: "completed",
          exitCode: 0,
        });
    } else await approve("child-1");
    finishChild("child-1", prompt === "subagent-fail");
    return finish();
  }
  // Plan-mode questions; the answers are logged as "questionAnswer".
  if (prompt === "question" || prompt === "secret-question") {
    const answer = await ask("item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: "call-q1",
      questions: [
        {
          id: "colour",
          header: "Colour",
          question: "Which colour?",
          isOther: true,
          isSecret: prompt === "secret-question",
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Cool" },
          ],
        },
        { id: "name", header: "Name", question: "Its name?", isOther: false, options: null },
      ],
      isBlocking: true,
      autoResolutionMs: null,
    });
    log({ method: "questionAnswer", params: answer });
    text("thanks");
    return done();
  }
  if (prompt === "elicit") {
    // The shape codex 0.162.1 sends before an MCP tool call (live transcript), then others.
    const elicit = (thread, serverName, extra = {}) =>
      ask("mcpServer/elicitation/request", {
        threadId: thread,
        turnId,
        serverName,
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          persist: ["session", "always"],
          tool_description: "Hands work to another agent.",
          tool_params: { task: "x" },
        },
        message: `Allow the ${serverName} MCP server to run tool "delegate_task"?`,
        requestedSchema: { type: "object", properties: {} },
        ...extra,
      }).then((answer) => log({ method: "elicitationAnswer", params: { serverName, ...answer } }));
    await elicit(threadId, "rook");
    notify("thread/started", {
      thread: { id: "child-1", parentThreadId: threadId, agentNickname: null, agentRole: null },
    });
    await elicit("child-1", "rook");
    await elicit(threadId, "docs");
    await elicit(threadId, "rook", { _meta: null, message: "Your email?" });
    return done();
  }
  if (prompt === "requests") {
    // Requests Rook used to answer itself: legacy approvals, permissions, other elicitations.
    const answer = (method, params) =>
      ask(method, params).then((result) => log({ method: `${method}:answer`, params: result }));
    await answer("execCommandApproval", {
      conversationId: threadId,
      callId: "call-1",
      approvalId: null,
      command: ["bash", "-lc", "npm install"],
      cwd,
      reason: "Installs packages",
      parsedCmd: [],
    });
    await answer("applyPatchApproval", {
      conversationId: threadId,
      callId: "call-2",
      fileChanges: { "a.txt": { type: "add", content: "hi\n" } },
      reason: null,
      grantRoot: null,
    });
    await answer("item/permissions/requestApproval", {
      threadId,
      turnId,
      itemId: "perm-1",
      environmentId: null,
      startedAtMs: 0,
      cwd,
      reason: "Needs the network",
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    await answer("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "cmd-2",
      command: "npm test",
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } },
        "cancel",
      ],
    });
    await answer("mcpServer/elicitation/request", {
      threadId,
      turnId,
      serverName: "docs",
      mode: "url",
      _meta: null,
      message: "Sign in to docs",
      url: "https://docs.example/login",
      elicitationId: "e-1",
    });
    await answer("mcpServer/elicitation/request", {
      threadId,
      turnId,
      serverName: "docs",
      mode: "form",
      _meta: null,
      message: "Your email?",
      requestedSchema: {
        type: "object",
        properties: { email: { type: "string" } },
        required: ["email"],
      },
    });
    return done();
  }
  if (prompt === "edit") {
    const item = {
      type: "fileChange",
      id: "patch-1",
      changes: [{ path: NodePath.join(cwd, "src", "a.ts"), kind: { type: "add" }, diff: "+x" }],
      status: "inProgress",
    };
    notify("item/started", { threadId, turnId, item });
    notify("item/completed", { threadId, turnId, item: { ...item, status: "completed" } });
    return done();
  }
  if (prompt === "hang") {
    running.set(threadId, turnId);
    return;
  }
  if (prompt === "hang-command") {
    // Like 0.162.1 in Ask mode: item/started has no processId, and commands still running when
    // the turn is interrupted keep running as background terminals.
    const command = (id) => ({
      type: "commandExecution",
      id,
      command: "ping -n 60 127.0.0.1",
      cwd,
      processId: null,
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    });
    const child = `${threadId}-child`;
    // An earlier turn's background command (say a dev server) is not this turn's to stop.
    terminals.set(threadId, [
      { itemId: "old-server", processId: `${threadId}-proc-9` },
      { itemId: "cmd-run", processId: `${threadId}-proc-1` },
    ]);
    terminals.set(child, [{ itemId: "child-cmd", processId: `${child}-proc-2` }]);
    emitItem(threadId, "item/started", command("cmd-run"));
    emitItem(threadId, "item/started", command("cmd-done"));
    emitItem(threadId, "item/completed", { ...command("cmd-done"), status: "completed" });
    notify("thread/started", {
      thread: { id: child, parentThreadId: threadId, agentNickname: null, agentRole: null },
    });
    emitItem(child, "item/started", command("child-cmd"));
    text("ready");
    running.set(threadId, turnId);
    return;
  }
  if (prompt === "fail") {
    notify("error", {
      threadId,
      turnId,
      willRetry: true,
      error: { message: "retrying" },
    });
    notify("error", {
      threadId,
      turnId,
      willRetry: false,
      error: { message: "Upstream exploded\n    at secret/stack.rs:1" },
    });
    return done("failed", null);
  }
  if (prompt === "output") {
    // Streamed command output, retries Codex recovers from, warnings, and other item types.
    const item = (value) => notify("item/completed", { threadId, turnId, item: value });
    const retry = { threadId, turnId, willRetry: true, error: { message: "Stream disconnected" } };
    notify("error", retry);
    notify("error", retry);
    notify("warning", { threadId, message: "Sandbox is off" });
    notify("configWarning", { summary: "Unknown key in config.toml", details: "line 3" });
    const command = {
      type: "commandExecution",
      id: "cmd-out",
      command: "npm test",
      cwd,
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    };
    notify("item/started", { threadId, turnId, item: command });
    const delta = (chunk) =>
      notify("item/commandExecution/outputDelta", {
        threadId,
        turnId,
        itemId: "cmd-out",
        delta: chunk,
      });
    delta("\u001b[32mok\u001b[0m 1\n");
    delta("ok 2\n");
    await new Promise((resolve) => setTimeout(resolve, 400));
    item({ ...command, status: "failed", aggregatedOutput: "ok 1\nok 2\nfail 3\n", exitCode: 2 });
    item({ type: "imageView", id: "img-1", path: NodePath.join(cwd, "shot.png") });
    item({ type: "contextCompaction", id: "compact-1" });
    item({ type: "brandNewThing", id: "new-1" });
    text("done");
    return done();
  }
  if (prompt === "die") process.exit(3);
  if (prompt === "plan") {
    // As 0.166 does: a task list through turn/plan/updated, and in plan mode a streamed plan item.
    for (const first of ["inProgress", "completed"]) {
      const plan = [
        { step: "Read the code", status: first },
        { step: "Write the plan", status: "pending" },
      ];
      notify("turn/plan/updated", { threadId, turnId, explanation: null, plan });
    }
    const item = { type: "plan", id: `${turnId}-plan`, text: "" };
    notify("item/started", { threadId, turnId, item });
    for (const delta of ["## Plan", "\n\n1. Do it"])
      notify("item/plan/delta", { threadId, turnId, itemId: item.id, delta });
    notify("item/completed", {
      threadId,
      turnId,
      item: { ...item, text: "## Plan\n\n1. Do it\n" },
    });
    return done();
  }

  notify("item/reasoning/summaryTextDelta", {
    threadId,
    turnId,
    itemId: "r",
    delta: "Thinking",
    summaryIndex: 0,
  });
  text("Hello");
  text(" there");
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage(null) });
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage(258400) });
  done();
}

readLines((message) => {
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  if (method !== "initialized") log({ method, params });
  const reply = (result) => send({ id, result });
  const state = readState({ requests: [], threads: [] });
  switch (method) {
    case "initialize":
      return reply({ userAgent: "fake" });
    case "initialized":
      return;
    case "model/list": {
      // Two pages, to exercise the cursor.
      const page = params?.cursor === "page-2" ? MODELS.slice(2) : MODELS.slice(0, 2);
      if (process.env.FAKE_MODELS === "unsupported")
        return send({ id, error: { code: -32601, message: "not found" } });
      return reply({ data: page, nextCursor: params?.cursor === "page-2" ? null : "page-2" });
    }
    case "thread/start": {
      const threadId = `thread-${state.threads.length + 1}`;
      writeState({ ...state, threads: [...state.threads, threadId] });
      cwds.set(threadId, params.cwd);
      return reply({ thread: { id: threadId }, model: params.model ?? "gpt-fast" });
    }
    case "thread/resume":
      if (!state.threads.includes(params.threadId))
        return send({
          id,
          error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` },
        });
      cwds.set(params.threadId, params.cwd);
      return reply({ thread: { id: params.threadId }, model: params.model ?? "gpt-fast" });
    case "thread/unsubscribe":
      return reply({ status: "unsubscribed" });
    case "thread/backgroundTerminals/list":
      return reply({ data: terminals.get(params.threadId) ?? [], nextCursor: null });
    case "thread/backgroundTerminals/terminate":
      return reply({ terminated: true });
    case "turn/start": {
      const turnId = `turn-${++turns}`;
      reply({ turn: { id: turnId, items: [], status: "inProgress", error: null } });
      const prompt = params.input.find((part) => part.type === "text")?.text ?? "";
      void play(params.threadId, turnId, prompt, cwds.get(params.threadId));
      return;
    }
    case "turn/steer": {
      // Like Codex: the input joins the active turn, which here then replies and completes.
      const turnId = running.get(params.threadId);
      if (!turnId || turnId !== params.expectedTurnId || process.env.FAKE_STEER === "reject")
        return send({ id, error: { code: -32600, message: "no active turn to steer" } });
      reply({ turnId });
      running.delete(params.threadId);
      const text = params.input.find((part) => part.type === "text")?.text ?? "";
      notify("item/agentMessage/delta", {
        threadId: params.threadId,
        turnId,
        itemId: "msg",
        delta: `Steered: ${text}`,
      });
      notify("turn/completed", {
        threadId: params.threadId,
        turn: { id: turnId, items: [], status: "completed", error: null },
      });
      return;
    }
    case "turn/interrupt": {
      const turnId = running.get(params.threadId);
      reply({});
      if (turnId && process.env.FAKE_INTERRUPT !== "ignore") {
        running.delete(params.threadId);
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: turnId, items: [], status: "interrupted", error: null },
        });
      }
      return;
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "not found" } });
  }
});
