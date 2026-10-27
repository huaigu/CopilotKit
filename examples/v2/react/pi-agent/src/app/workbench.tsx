"use client";

import {
  CopilotChat,
  CopilotKitProvider,
  useAgent,
  useAgentContext,
  useCopilotKit,
  useFrontendTool,
  useHumanInTheLoop,
  defineToolCallRenderer,
} from "@copilotkit/react-core/v2";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";

type Language = "en" | "zh";
const text = {
  en: {
    eyebrow: "COPILOTKIT × PI",
    title: "A conversation that can act.",
    subtitle: "Ask, inspect the work, and choose what happens next.",
    newChat: "New conversation",
    stop: "Stop task",
    workspace: "Shared workspace",
    goal: "Target",
    hint: "Change this value, then ask Pi to read it.",
    capability: "Try a complete interaction",
    quote: "Calculate a quote for 4 units",
    change: "Set the target to 7",
    confirm: "Ask me to confirm a target of 9",
    skill: "Read and use the greeting Skill",
    examples: "These prompts run through Pi and the registered tools.",
    ready: "Ready",
    running: "Working",
    waiting: "Waiting for you",
    test: "Verification mode · deterministic model",
    live: "Live model mode",
    placeholder: "Ask Pi to do something…",
    welcome: "What would you like to work on?",
    disclaimer: "Check tool results before relying on them.",
    approve: "Confirm",
    deny: "Decline",
    confirmed: "Confirmed",
    declined: "Declined",
    confirmation: "Your confirmation",
    restore: "Restoring conversation…",
    interrupted:
      "The previous task was interrupted. Send a new message to continue.",
    error: "Something went wrong. Try again.",
    message: "Message Pi",
    saved: "Conversation is saved on this server.",
    label: "Language",
    stopped: "Task stopped.",
  },
  zh: {
    eyebrow: "COPILOTKIT × PI",
    title: "让对话，接着把事做完。",
    subtitle: "提出需求，查看执行过程，在需要时做决定。",
    newChat: "新建对话",
    stop: "停止任务",
    workspace: "共享工作区",
    goal: "目标值",
    hint: "修改这个值，再让 Pi 读取它。",
    capability: "试试完整交互",
    quote: "计算 4 件商品的报价",
    change: "把目标值改为 7",
    confirm: "把目标值改为 9，但先征求我的确认",
    skill: "读取并使用问候 Skill",
    examples: "这些操作会经过 Pi 和已注册的工具。",
    ready: "就绪",
    running: "执行中",
    waiting: "等待你的决定",
    test: "验证模式 · 确定性模型",
    live: "真实模型模式",
    placeholder: "让 Pi 帮你做点什么…",
    welcome: "今天想先做什么？",
    disclaimer: "使用结果前，请核对工具返回的信息。",
    approve: "确认",
    deny: "拒绝",
    confirmed: "已确认",
    declined: "已拒绝",
    confirmation: "请你确认",
    restore: "正在恢复对话…",
    interrupted: "上一次任务已中断，可以发新消息继续。",
    error: "执行出现问题，请重试。",
    message: "向 Pi 发消息",
    saved: "对话保存在当前服务器。",
    label: "语言",
    stopped: "任务已停止。",
  },
};

const renderers = [
  defineToolCallRenderer({
    name: "*",
    render: ({ name, status, result }) => (
      <details className="tool-card tool-details">
        <summary>
          <span className="tool-icon">⌘</span>
          <strong>{name}</strong>
          <small>{status === "complete" ? "✓" : "…"}</small>
        </summary>
        {result && <pre>{result}</pre>}
      </details>
    ),
  }),
];

export function PiWorkbench({ testMode }: { testMode: boolean }) {
  const [language, setLanguage] = useState<Language>("en");
  const [threadId, setThreadId] = useState<string>();
  useEffect(() => {
    const stored = localStorage.getItem("pi-demo-thread");
    const id =
      stored && /^[a-zA-Z0-9_-]{1,100}$/.test(stored)
        ? stored
        : crypto.randomUUID();
    localStorage.setItem("pi-demo-thread", id);
    setThreadId(id);
    setLanguage(
      localStorage.getItem("pi-demo-language") === "zh" ? "zh" : "en",
    );
  }, []);
  const t = text[language];
  return (
    <main className="workbench" lang={language === "zh" ? "zh-CN" : "en"}>
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Pi Agent home">
          <span className="brand-mark">π</span>
          <span>
            Pi Agent <small>with CopilotKit</small>
          </span>
        </Link>
        <div className="topbar-actions">
          <span className={`mode ${testMode ? "test-mode" : ""}`}>
            {testMode ? t.test : t.live}
          </span>
          <select
            aria-label={t.label}
            value={language}
            onChange={(event) => {
              const lang = event.target.value as Language;
              setLanguage(lang);
              localStorage.setItem("pi-demo-language", lang);
            }}
          >
            <option value="en">English</option>
            <option value="zh">简体中文</option>
          </select>
        </div>
      </header>
      {threadId ? (
        <CopilotKitProvider
          runtimeUrl="/api/copilotkit"
          useSingleEndpoint={false}
          enableInspector={false}
          renderToolCalls={renderers}
        >
          <Conversation
            key={threadId}
            threadId={threadId}
            language={language}
            onNew={() => {
              const id = crypto.randomUUID();
              localStorage.setItem("pi-demo-thread", id);
              setThreadId(id);
            }}
          />
        </CopilotKitProvider>
      ) : (
        <p className="loading">{t.restore}</p>
      )}
    </main>
  );
}

function Conversation({
  threadId,
  language,
  onNew,
}: {
  threadId: string;
  language: Language;
  onNew: () => void;
}) {
  const t = text[language];
  const { agent, isReady } = useAgent({ agentId: "pi" });
  const { copilotkit } = useCopilotKit();
  const [restored, setRestored] = useState(false);
  const [notice, setNotice] = useState("");
  const [waiting, setWaiting] = useState(false);
  const stopRequested = useRef(false);
  const restoreText = useRef(t);
  restoreText.current = t;
  const goal = typeof agent.state?.goal === "number" ? agent.state.goal : 3;

  useEffect(() => {
    if (!isReady) return;
    const controller = new AbortController();
    agent.threadId = threadId;
    fetch(`/api/pi/history?threadId=${encodeURIComponent(threadId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("History could not be loaded");
        return response.json();
      })
      .then((history) => {
        agent.setMessages(history.messages ?? []);
        agent.setState({ goal: 3, ...history.state });
        if (history.interrupted && !history.running)
          setNotice(restoreText.current.interrupted);
        if (Array.isArray(history.pending) && history.pending.length > 0)
          setWaiting(true);
        setRestored(true);
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setNotice(restoreText.current.error);
          setRestored(true);
        }
      });
    return () => controller.abort();
  }, [agent, isReady, threadId]);

  useAgentContext({
    description: "Preferred reply language and current demo target",
    value: { language, goal },
  });

  useFrontendTool(
    {
      name: "set_goal",
      description: "Set the target value shown in the user's browser.",
      parameters: z.object({ goal: z.number().min(0).max(1000) }),
      handler: async ({ goal: nextGoal }) => {
        agent.setState({ ...agent.state, goal: nextGoal });
        return { goal: nextGoal, executedIn: "browser" };
      },
      render: ({ args, status }) => (
        <div className="tool-card">
          <span className="tool-icon">↗</span>
          <div>
            <strong>
              {language === "zh" ? "更新页面目标值" : "Update page target"}
            </strong>
            <p>
              {status === "complete" ? `${t.goal}: ${args.goal}` : t.running}
            </p>
          </div>
        </div>
      ),
    },
    [agent, language],
  );

  useHumanInTheLoop(
    {
      name: "request_confirmation",
      description:
        "Ask the user to confirm a proposed change. Only proceed with the change if approved is true.",
      parameters: z.object({ message: z.string() }),
      render: ({ args, respond, status, result }) => (
        <div className="confirmation" data-testid="confirmation">
          <span className="card-eyebrow">{t.confirmation}</span>
          <p>{args.message}</p>
          {respond ? (
            <div className="confirmation-actions">
              <button
                onClick={() => {
                  setWaiting(false);
                  void respond({ approved: true });
                }}
              >
                {t.approve}
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setWaiting(false);
                  void respond({ approved: false });
                }}
              >
                {t.deny}
              </button>
            </div>
          ) : (
            <small>
              {status === "complete"
                ? result.includes("true")
                  ? t.confirmed
                  : t.declined
                : t.running}
            </small>
          )}
        </div>
      ),
    },
    [language],
  );

  useEffect(
    () =>
      agent.subscribe({
        onRunInitialized: () => {
          stopRequested.current = false;
        },
        onMessagesChanged: () => {
          const calls = agent.messages.flatMap((message) =>
            message.role === "assistant" ? (message.toolCalls ?? []) : [],
          );
          const completed = new Set(
            agent.messages
              .filter((message) => message.role === "tool")
              .map((message) => message.toolCallId),
          );
          setWaiting(
            calls.some(
              (call) =>
                call.function.name === "request_confirmation" &&
                !completed.has(call.id),
            ),
          );
        },
      }).unsubscribe,
    [agent],
  );

  async function send(message: string) {
    stopRequested.current = false;
    setNotice("");
    agent.threadId = threadId;
    agent.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: message,
    });
    try {
      await copilotkit.runAgent({ agent });
    } catch {
      if (!stopRequested.current) setNotice(t.error);
    }
  }

  async function stop() {
    stopRequested.current = true;
    try {
      copilotkit.stopAgent({ agent });
      const response = await fetch("/api/pi/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      });
      if (!response.ok) throw new Error("Stop failed");
      setWaiting(false);
      setNotice(t.stopped);
    } catch {
      setNotice(t.error);
    }
  }

  return (
    <div className="workspace-grid">
      <section className="conversation">
        <div className="conversation-intro">
          <span className="eyebrow">{t.eyebrow}</span>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
          <div className="conversation-meta">
            <span className="status">
              <i />
              {waiting ? t.waiting : agent.isRunning ? t.running : t.ready}
            </span>
            <button
              className="text-button"
              onClick={onNew}
              disabled={agent.isRunning || waiting}
            >
              {t.newChat}
            </button>
          </div>
        </div>
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {restored ? (
          <div className="chat-shell" data-testid="pi-chat">
            <CopilotChat
              agentId="pi"
              threadId={threadId}
              inspectorTools={false}
              onStop={() => {
                void stop();
              }}
              onError={() => {
                if (!stopRequested.current) setNotice(t.error);
              }}
              labels={{
                chatInputPlaceholder: t.placeholder,
                chatInputToolbarSendButtonLabel: t.message,
                chatInputToolbarStopButtonLabel: t.stop,
                welcomeMessageText: t.welcome,
                chatDisclaimerText: t.disclaimer,
              }}
            />
          </div>
        ) : (
          <p className="loading">{t.restore}</p>
        )}
      </section>
      <aside className="side-panel">
        <section className="workspace-card">
          <span className="card-eyebrow">{t.workspace}</span>
          <label className="goal-label" htmlFor="goal">
            {t.goal}
          </label>
          <div className="goal-control">
            <input
              id="goal"
              data-testid="goal-input"
              type="number"
              min="0"
              max="1000"
              value={goal}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value))
                  agent.setState({
                    ...agent.state,
                    goal: Math.max(0, Math.min(1000, value)),
                  });
              }}
            />
            <span>↔ Pi</span>
          </div>
          <p>{t.hint}</p>
        </section>
        <section className="try-card">
          <span className="card-eyebrow">{t.capability}</span>
          {[t.quote, t.change, t.confirm, t.skill].map((prompt, index) => (
            <button
              className="prompt-button"
              key={index}
              disabled={!restored || agent.isRunning || waiting}
              onClick={() => {
                void send(prompt);
              }}
            >
              <span className="prompt-number">0{index + 1}</span>
              <span>{prompt}</span>
              <span className="prompt-arrow">↗</span>
            </button>
          ))}
          <p>{t.examples}</p>
        </section>
        <footer className="sidebar-footer">
          <p>{t.saved}</p>
          <button
            className="stop-button"
            onClick={() => {
              void stop();
            }}
            disabled={!agent.isRunning && !waiting}
          >
            {t.stop}
          </button>
        </footer>
      </aside>
    </div>
  );
}
