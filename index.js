import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BasicCompactionEngine, compactSurfaceRegion } from "@deepseek-ai/dsh-compaction-basic";
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { buildCard, planMessages, RAIL_TOKENS } from "./plan.js";
import { buildSendLess, decideThunder } from "./thunder.js";

const MARK = "Spine extract.";
const CHUNK_MIN = 1000;
const CHUNK_MAX = RAIL_TOKENS;
const BIG_GATE = 650000;
const URGENT_TOKENS = 48000;
const MAX_TAIL = 2200;
const MIN_PRESSURE = Number(process.env.SPINE_MIN_TOKENS || 20000);
const MAX_TRACKED_SESSIONS = 64;
const DEFAULT_KEY = "__default__";

function messageText(message) {
  const content = message?.content ?? message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
}

function eventText(session, seq) {
  const event = session.eventAt(seq);
  if (event?.type === "user/message") return messageText(event.data);
  if (event?.type === "assistant/message") return messageText(event.data?.message);
  return messageText(event?.data);
}

function isCheckpoint(session, seq) {
  const event = session.eventAt(seq);
  if (event?.data?.source?.kind === "compact-checkpoint") return true;
  return eventText(session, seq).includes(MARK);
}

function isUser(session, seq) {
  return session.eventAt(seq)?.type === "user/message";
}

function cutOk(fn, session, seq) {
  try {
    return fn(session, seq);
  } catch {
    return false;
  }
}

function shadowDirectory() {
  if (process.env.SPINE_SHADOW_DIR) return process.env.SPINE_SHADOW_DIR;
  const root = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(root, "compaction-spine", "shadow");
}

function sessionKey(agent) {
  const id = agent?.session?.id;
  return typeof id === "string" && id.length > 0 ? id : DEFAULT_KEY;
}

function shadowName(key, length) {
  const tag = key.replace(/[^A-Za-z0-9_-]/g, "").slice(-24) || "session";
  return `${Date.now()}-${length}-${tag}-${randomBytes(4).toString("hex")}.txt`;
}

function selectNewestChunk(session, measurement) {
  const nodes = session.surface.nodes;
  const priced = measurement.nodes;
  if (nodes.length === 0 || nodes.length !== priced.length) return null;
  const first = session.eventAt(nodes[0])?.type === "system/message" ? 1 : 0;
  let end = priced.length - 1;
  while (end >= first) {
    const event = session.eventAt(nodes[end]);
    const shortTail = event?.type === "assistant/message" || (event?.type === "user/message" && priced[end].tokens < 400);
    if (!shortTail) break;
    end -= 1;
  }
  while (end >= first && isCheckpoint(session, nodes[end])) end -= 1;
  while (end >= first && !cutOk(toolPairingBalancedAfter, session, nodes[end])) end -= 1;
  if (end < first || isCheckpoint(session, nodes[end])) return null;
  if (priced[end].tokens > CHUNK_MAX) return null;
  const spanText = (spanStart, spanEnd) => {
    const bits = [];
    for (let index = spanStart; index <= spanEnd; index += 1) bits.push(eventText(session, nodes[index]));
    return bits.join("\n");
  };
  const liveText = (spanStart, spanEnd) => {
    const bits = [];
    for (let index = 0; index < nodes.length; index += 1) {
      if (index >= spanStart && index <= spanEnd) continue;
      bits.push(eventText(session, nodes[index]));
    }
    return bits.join("\n");
  };
  let start = end;
  let tokens = priced[end].tokens;
  let card = buildCard(spanText(start, end), liveText(start, end));
  if (card.verdict !== "TRUNK CONFIRMED") return null;
  while (start > first) {
    const prev = start - 1;
    if (isCheckpoint(session, nodes[prev]) || isUser(session, nodes[prev])) break;
    const nextTokens = tokens + priced[prev].tokens;
    if (nextTokens > CHUNK_MAX) break;
    const trial = buildCard(spanText(prev, end), liveText(prev, end));
    if (trial.verdict !== "TRUNK CONFIRMED") break;
    tokens = nextTokens;
    start = prev;
    card = trial;
  }
  while (start <= end && (isCheckpoint(session, nodes[start]) || !cutOk(toolPairingBalancedBefore, session, nodes[start]))) {
    tokens -= priced[start].tokens;
    start += 1;
  }
  if (start > end || tokens < CHUNK_MIN || isCheckpoint(session, nodes[start])) return null;
  card = buildCard(spanText(start, end), liveText(start, end));
  if (card.verdict !== "TRUNK CONFIRMED") return null;
  if (!cutOk(toolPairingBalancedAfter, session, nodes[end])) return null;
  let after = 0;
  for (let index = end + 1; index < priced.length; index += 1) after += priced[index].tokens;
  return { start: nodes[start], end: nodes[end], tokens, after, card };
}

export { planMessages };

export default class SpineCompactionEngine extends BasicCompactionEngine {
  // Per-session state. One engine instance can serve several agents, so nothing
  // here may live on `this` directly or one agent's card/prefix leaks into another.
  sessionState = new Map();

  constructor(ctx, config) {
    super(ctx, config);
    ctx.on("agent/status", ({ agent, status }) => {
      if (status !== "idle") return;
      const state = this.stateFor(agent);
      if (state.warming) return;
      const done = agent.session.snapshotEvents().some((event) => event.type === "turn/end" && event.data?.reason?.kind === "completed");
      if (!done) return;
      state.warming = true;
      void this.finishTurn(agent).finally(() => {
        state.warming = false;
      });
    });
  }

  stateFor(agent) {
    const key = sessionKey(agent);
    let state = this.sessionState.get(key);
    if (state) {
      this.sessionState.delete(key);
      this.sessionState.set(key, state);
      return state;
    }
    state = {
      key,
      liveAgent: null,
      warming: false,
      localOnly: false,
      approvedCard: null,
      lastPrefix: "",
      lastPrefixTokens: 0,
    };
    this.sessionState.set(key, state);
    if (this.sessionState.size > MAX_TRACKED_SESSIONS) {
      for (const [oldKey, old] of this.sessionState) {
        if (this.sessionState.size <= MAX_TRACKED_SESSIONS) break;
        if (oldKey === key || old.warming || old.localOnly) continue;
        this.sessionState.delete(oldKey);
      }
    }
    return state;
  }

  chunkPlan(session, chunk) {
    const messages = [];
    let on = false;
    for (const seq of session.surface.nodes) {
      if (seq === chunk.start) on = true;
      if (!on) continue;
      messages.push({ role: "assistant", content: eventText(session, seq) });
      if (seq === chunk.end) break;
    }
    return planMessages(messages);
  }

  async finishTurn(agent) {
    const state = this.stateFor(agent);
    const signal = AbortSignal.timeout(30000);
    try {
      await agent.runMaintenance(async (agentSignal) => {
        const op = AbortSignal.any([agentSignal, signal]);
        const measurement = this.ctx.tokenMeter.measure(agent.session);
        if (measurement.totalTokens < MIN_PRESSURE || measurement.totalTokens >= BIG_GATE) return;
        const chunk = selectNewestChunk(agent.session, measurement);
        if (chunk === null) return;
        if (chunk.after > MAX_TAIL && measurement.totalTokens < URGENT_TOKENS) return;
        const before = measurement.totalTokens;
        const started = Date.now();
        let reduced = false;
        try {
          state.localOnly = true;
          state.approvedCard = chunk.card;
          await compactSurfaceRegion(this.regionDependencies(), agent.session, chunk.start, chunk.end, agent, {
            owner: null,
            stability: "selected-span",
            flush: async () => {
              await this.ctx.sessions.flush(agent.session);
            },
          }, op);
          const after = this.ctx.tokenMeter.measure(agent.session).totalTokens;
          reduced = after < before;
          this.ctx.logger?.info?.(`spine cut ${Date.now() - started}ms ${before} -> ${after} chunk=${chunk.tokens}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.ctx.logger?.warn?.(`spine cut failed: ${message}`);
        }
        if (!reduced) {
          this.ctx.logger?.warn?.(`spine cut did not reduce ${before}; leaving the prefix for the gate`);
        }
        await this.ctx.sessions?.flush?.(agent.session);
        this.rememberPrefix(agent);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger?.warn?.(`spine after-turn skipped: ${message}`);
    } finally {
      state.localOnly = false;
    }
  }

  rememberPrefix(agent) {
    const state = this.stateFor(agent);
    try {
      const messages = agent.session.deriveMessages();
      state.lastPrefix = (messages || []).map(messageText).join("\n");
      state.lastPrefixTokens = this.ctx.tokenMeter.measure(agent.session).totalTokens;
    } catch {}
  }

  async compactIfNeeded(agent, trigger, signal) {
    const state = this.stateFor(agent);
    state.liveAgent = agent;
    state.localOnly = false;
    return super.compactIfNeeded(agent, trigger, signal);
  }

  async summarize(input, agent, signal) {
    const joined = input.messages.map(messageText).join("\n\n");
    const state = this.stateFor(agent);
    const card = state.localOnly && state.approvedCard ? state.approvedCard : planMessages(input.messages);
    state.approvedCard = null;
    const shadow = shadowDirectory();
    mkdirSync(shadow, { recursive: true });
    const file = join(shadow, shadowName(state.key, joined.length));
    writeFileSync(file, joined);
    if (state.localOnly || card.route === "local") {
      const text = `${card.text}\nFull shadowed text: ${file}`;
      const block = { type: "text", text };
      return { summary: [block], provider: "local", model: "spine-extract", rawOutput: [block] };
    }
    if (process.env.SPINE_THUNDER !== "1") return super.summarize(input, agent, signal);
    const next = joined;
    const mode = decideThunder({
      previous: state.lastPrefix || "",
      next,
      modelKind: process.env.SPINE_THUNDER_MODEL === "27b" ? "27b" : "flash",
      prefixTokens: state.lastPrefixTokens || 0,
    });
    if (mode === "attach") return super.summarize(input, agent, signal);
    const users = input.messages.filter((message) => (message?.role ?? message?.message?.role) === "user");
    const taskLine = messageText(users.at(-1) || input.messages.at(-1)).slice(0, 500);
    const trunk = buildCard(joined, "");
    const facts = [...new Set([...(trunk.hardLines || []), ...(trunk.missing || [])])];
    const slim = buildSendLess({ taskLine, uncovered: trunk.uncovered, facts });
    return super.summarize({
      ...input,
      messages: [{ role: "user", content: [{ type: "text", text: slim }] }],
    }, agent, signal);
  }
}
