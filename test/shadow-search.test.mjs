// shadow-search 的自测（node --test test/shadow-search.test.mjs）
//
// 目录一律用临时目录构造：本模块的前提就是「目录由调用方传入」，
// 所以测试也不依赖本机任何真实路径。
//
// 1.0.6 起备份按会话分目录（`sessionDir(root, key)`），这里覆盖两种给法：
// 直接给会话目录、以及给 root + sessionKey 由模块定位。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchShadow } from "../shadow-search.js";
import { shadowFileBody, sessionDir } from "../shadow.js";

/**
 * 造一个按会话分目录的 shadow 根，返回 { root, sessionDirOf, write }。
 * write(sessionKey, name, body) 会写到该会话目录里。
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spine-search-"));
  const sessionDirOf = (key) => sessionDir(root, key);
  const write = (sessionKey, name, body) => {
    const dir = sessionDirOf(sessionKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), shadowFileBody(sessionKey, body), "utf8");
  };
  return { root, sessionDirOf, write };
}

test("按会话目录检索：命中返回文件、会话键与 1 起始行号", () => {
  const { root, sessionDirOf, write } = fixture();
  write("sess-a", "cut-1-aaaaaaaa.txt", "第一行\ncommit 99f51d0 已推送\n第三行");
  const result = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "99f51d0" });
  assert.equal(result.scanned, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].sessionKey, "sess-a");
  assert.equal(result.matches[0].line, 3, "首行是 # spine-session 头，命中在正文第 3 行");
});

test("root + sessionKey 形式：只定到该会话目录", () => {
  const { root, write } = fixture();
  write("sess-a", "cut-2-bbbbbbbb.txt", "want-this-line");
  write("sess-b", "cut-3-cccccccc.txt", "want-this-line");
  const result = searchShadow({ root, sessionKey: "sess-a", pattern: "want-this-line" });
  assert.equal(result.directory, sessionDir(root, "sess-a"));
  assert.equal(result.matches.length, 1, "另一个会话的同名内容不得被搜到");
  assert.equal(result.matches[0].sessionKey, "sess-a");
});

test("会话头本身不参与匹配", () => {
  const { sessionDirOf, write } = fixture();
  write("want-this-session-key", "cut-4-dddddddd.txt", "正文里没有关键词");
  const result = searchShadow({ dir: sessionDirOf("want-this-session-key"), pattern: "want-this-session-key" });
  assert.equal(result.matches.length, 0, "首行 # spine-session 是元信息，不应命中");
});

test("正则模式与忽略大小写", () => {
  const { sessionDirOf, write } = fixture();
  write("sess-a", "cut-5-eeeeeeee.txt", "Commit 99F51D0\n另一个 commit abc1234");
  const byRegex = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "commit [0-9a-f]{7}", regex: true, ignoreCase: true });
  assert.equal(byRegex.matches.length, 2);
  const byIgnoreCase = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "99f51d0", ignoreCase: true });
  assert.equal(byIgnoreCase.matches.length, 1);
});

test("limit 截断时 truncated 为 true，且不超额返回", () => {
  const { sessionDirOf, write } = fixture();
  write("sess-a", "cut-6-ffffffff.txt", Array.from({ length: 10 }, () => "needle").join("\n"));
  const result = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "needle", limit: 3 });
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
});

test("超大文件跳过并计入 skipped，不影响其它文件", () => {
  const { sessionDirOf, write } = fixture();
  write("sess-a", "cut-7-11111111.txt", "x".repeat(2048) + "needle");
  write("sess-a", "cut-8-22222222.txt", "needle");
  const result = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "needle", maxFileBytes: 1024 });
  assert.equal(result.skipped, 1);
  assert.equal(result.scanned, 1);
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].file, /cut-8/);
});

test("不递归子目录：只读指定的这一层", () => {
  const { root, sessionDirOf, write } = fixture();
  write("sess-a", "cut-9-33333333.txt", "needle");
  // 在 sess-a 目录里再套一个子目录，里面也放同名内容的文件
  const nested = join(sessionDirOf("sess-a"), "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "deep.txt"), shadowFileBody("sess-a", "needle"), "utf8");
  const result = searchShadow({ dir: sessionDirOf("sess-a"), pattern: "needle" });
  assert.equal(result.scanned, 1, "子目录里的文件不该被读到");
  assert.ok(!result.matches.some((m) => m.file.includes("nested")));
  assert.equal(result.directory, sessionDirOf("sess-a"), "根目录参数只用来定位，不参与扫描");
  void root;
});

test("目录不存在时返回空结果而不是抛错", () => {
  const { root } = fixture();
  const result = searchShadow({ root, sessionKey: "no-such-session", pattern: "x" });
  assert.deepEqual({ scanned: result.scanned, matches: result.matches.length }, { scanned: 0, matches: 0 });
});

test("目录参数缺失或 pattern 缺失时抛 TypeError", () => {
  assert.throws(() => searchShadow({ pattern: "x" }), /either dir .* or root \+ sessionKey/);
  assert.throws(() => searchShadow({ root: "/tmp" }), /either dir .* or root \+ sessionKey/, "只给 root 不行：那等于扫全部会话");
  assert.throws(() => searchShadow({ dir: "/tmp" }), /pattern is required/);
});
