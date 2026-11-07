import assert from "node:assert/strict";
import test from "node:test";
import Spine from "../index.js";

function toolResult(seq, id) {
  return { seq, type: "tool/result", data: { turn: 1, message: { toolCallId: id, content: [{ type: "text", text: "ok" }] } } };
}

function toolCall(seq, id) {
  return { seq, type: "tool/call", data: { turn: 1, callId: id, name: "read", arguments: { file_path: "a.txt" } } };
}

test("captureOne does not copy the whole log", () => {
  let snaps = 0;
  const session = {
    id: "s",
    snapshotEvents() { snaps += 1; return []; },
    eventAt() { return undefined; },
  };
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.noteEvent(session, toolCall(1, "c1"));
  engine.captureOne(session, toolResult(2, "c1"));
  assert.equal(snaps, 0);
  assert.equal(engine.callIndex.get("s").get("c1").name, "read");
});

test("captureNew scans only events after the cursor", () => {
  const seen = [];
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.captureCursor = new Map();
  engine.captureOne = (session, event) => { seen.push(event.seq); };
  const session = { id: "s" };
  const events = [toolResult(0, "a"), toolResult(1, "b"), toolResult(2, "c")];
  engine.captureNew(session, events.slice(0, 2));
  engine.captureNew(session, events);
  assert.deepEqual(seen, [0, 1, 2]);
});

test("finishTurn measures once when it does not cut", async () => {
  let measures = 0;
  let snaps = 0;
  const events = [{ seq: 0, type: "turn/end", data: { reason: { kind: "completed" }, turn: 1 } }];
  const session = {
    id: "s",
    surface: { nodes: [] },
    snapshotEvents() { snaps += 1; return events; },
    eventAt() { return undefined; },
    requestHeader() { return { config: { provider: "deepseek-official" } }; },
    requestContext() { return {}; },
  };
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.captureCursor = new Map();
  engine.sessionState = new Map();
  engine.shadowFullWarned = new Set();
  engine.pruneGuarded = true;
  engine.ctx = {
    tokenMeter: { measure() { measures += 1; return { totalTokens: 100, nodes: [] }; } },
    logger: { info() {}, warn() {} },
    llm: { listProviders() { return []; } },
    get() { return undefined; },
  };
  engine.ensurePruneGuard = () => {};
  const agent = {
    session,
    runMaintenance(fn) { return fn(AbortSignal.abort()); },
  };
  await engine.finishTurn(agent, events);
  assert.equal(snaps, 0);
  assert.equal(measures, 1);
});
