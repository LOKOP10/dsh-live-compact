/**
 * 备份文件。按会话分目录，默认上限 256MB，快满时删最老的。
 * Shadow files live in per-session directories. Default cap is 256MB; delete the oldest when nearly full.
 *
 * 删除顺序：根目录旧文件，死会话，当前会话的旧文件。
 * 不删当前卡片指向的文件，也不删别的还活着的会话。ENOENT 当成已经删掉。
 * Delete legacy root files, then dead sessions, then old files of the current session.
 * Never delete the current card's file or another live session. ENOENT counts as already freed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const PLUGIN_NAME = /^(?:(?:cut|official|shadow)-\d+-[0-9a-f]{8}|raw-[0-9a-f]{16}|\d+-[0-9a-f]{8}-[0-9a-f]{8}|\d+-[0-9a-f]{8,16})\.txt$/;
const SESSION_MARK = /^# spine-session (\S+)/;

export function isPluginShadowName(name) {
  return PLUGIN_NAME.test(name);
}

export function sanitizeSessionKey(key) {
  const safe = String(key || "default").replace(/[^A-Za-z0-9_-]/g, "");
  return safe || "default";
}

export function sessionDir(root, key) {
  return join(root, sanitizeSessionKey(key));
}

function ownerPid(dir) {
  try {
    const text = readFileSync(join(dir, "owner"), "utf8").trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function shadowFileBody(sessionKey, body) {
  const key = String(sessionKey || "default").replace(/\s+/g, "");
  return `# spine-session ${key}\n${body || ""}`;
}

export const STATS_NAME = "spine-stats.json";
export const CUTS_NAME = "spine-cuts.jsonl";

export function readCutStats(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, STATS_NAME), "utf8"));
    return {
      cuts: Number(parsed.cuts) || 0,
      savedTokens: Number(parsed.savedTokens) || 0,
      rewriteTokens: Number(parsed.rewriteTokens) || 0,
      drains: Number(parsed.drains) || 0,
    };
  } catch {
    return { cuts: 0, savedTokens: 0, rewriteTokens: 0, drains: 0 };
  }
}

export function drainRewrite(notes) {
  const cuts = (notes || []).filter((note) => note?.kind === "cut" && note.saved > 0);
  if (!cuts.length) return 0;
  const later = cuts.slice(1).reduce((sum, note) => sum + (note.saved || 0), 0);
  return Math.max(0, (cuts[0].afterPrefix || 0) - later);
}

export function flushDrainStats(dir, notes, meta = {}) {
  const cuts = (notes || []).filter((note) => note?.kind === "cut" && note.saved > 0);
  const charged = drainRewrite(notes);
  const saved = cuts.reduce((sum, note) => sum + note.saved, 0);
  if (cuts.length) recordDrainStats(dir, { cuts: cuts.length, saved, rewrite: charged });
  const lines = (notes || []).map((note, index) => JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    sid: meta.sid || "",
    kind: note.kind || "cut",
    pass: index,
    drain: meta.drain === true,
    saved: note.saved || 0,
    rewriteCharged: note.kind === "cut" && index === (notes || []).findIndex((item) => item?.kind === "cut") ? charged : 0,
    tailBeyondKept: note.tailBeyondKept || 0,
    prefix: note.prefix || 0,
    afterPrefix: note.afterPrefix || 0,
    tokens: note.tokens || 0,
    total: note.total || 0,
    gate: note.gate || "cut",
  }));
  if (!lines.length) return charged;
  try {
    appendFileSync(join(dir, CUTS_NAME), `${lines.join("\n")}\n`);
  } catch {}
  return charged;
}

function recordDrainStats(dir, { cuts = 0, saved = 0, rewrite = 0 } = {}) {
  if (!(cuts > 0) || !(saved > 0)) return null;
  try {
    const file = join(dir, STATS_NAME);
    const lock = join(dir, "spine-stats.lock");
    const tmp = `${file}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
    let fd;
    try {
      fd = openSync(lock, "wx");
    } catch {
      return null;
    }
    try {
      const prev = readCutStats(dir);
      const locked = {
        cuts: prev.cuts + cuts,
        savedTokens: prev.savedTokens + saved,
        rewriteTokens: prev.rewriteTokens + rewrite,
        drains: (Number(prev.drains) || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(tmp, JSON.stringify(locked));
      renameSync(tmp, file);
      return locked;
    } finally {
      try { unlinkSync(tmp); } catch {}
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  } catch {
    return null;
  }
}

export function recordCutStats(dir, { saved = 0, rewrite = 0 } = {}) {
  if (!(saved > 0)) return readCutStats(dir);
  try {
    const file = join(dir, STATS_NAME);
    const lock = join(dir, "spine-stats.lock");
    const tmp = `${file}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
    let fd;
    try {
      fd = openSync(lock, "wx");
    } catch {
      return null;
    }
    try {
      const prev = readCutStats(dir);
      const locked = {
        cuts: prev.cuts + 1,
        savedTokens: prev.savedTokens + saved,
        rewriteTokens: prev.rewriteTokens + rewrite,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(tmp, JSON.stringify(locked));
      renameSync(tmp, file);
      return locked;
    } finally {
      try { unlinkSync(tmp); } catch {}
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  } catch {
    return null;
  }
}

export function shadowAccessPlan(platform = process.platform, userSid = "", kind = "dir") {
  if (platform === "win32") {
    if (!/^S-\d+(?:-\d+)+$/.test(userSid)) {
      throw new Error("spine: current Windows user SID is required");
    }

    // 文件不能带继承标志，否则 icacls 会把整条 ACE 当无效丢掉，留下空 DACL。
    // Files reject (OI)(CI), so a file grant must not carry it.
    const scope = kind === "dir" ? "(OI)(CI)" : "";

    return {
      kind: "acl",
      usesChmodOnly: false,
      inheritance: "remove",
      grant: [
        `*${userSid}:${scope}F`,
        `*S-1-5-18:${scope}F`,
        `*S-1-5-32-544:${scope}F`,
      ],
    };
  }

  return {
    kind: "mode",
    usesChmodOnly: true,
    dirMode: 0o700,
    fileMode: 0o600,
  };
}

export function defaultShadowAccessRunner({ path, kind, platform, execFile = execFileSync }) {
  if (platform !== "win32") {
    const plan = shadowAccessPlan(platform);
    chmodSync(path, kind === "dir" ? plan.dirMode : plan.fileMode);
    return true;
  }

  const identity = execFile(
    "whoami.exe",
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  const match = identity.match(/,"(S-\d+(?:-\d+)+)"\s*$/i);
  if (!match) {
    throw new Error("spine: cannot determine current Windows user SID");
  }

  const plan = shadowAccessPlan("win32", match[1], kind);
  execFile(
    "icacls.exe",
    [resolve(path), "/inheritance:r", "/grant:r", ...plan.grant],
    { stdio: "pipe", windowsHide: true },
  );

  return true;
}

export function tightenShadow(path, kind = "dir", access = {}) {
  const platform = access.platform ?? process.platform;
  const runner = access.runner ?? defaultShadowAccessRunner;

  try {
    if (runner({ path, kind, platform }) !== true) {
      throw new Error("permission runner did not confirm success");
    }
  } catch (cause) {
    const error = new Error(
      "spine: shadow permission action failed; backup refused",
      { cause },
    );
    error.code = "ESHADOWACCESS";
    throw error;
  }
}

export function ensureShadowDir(dir, access = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tightenShadow(dir, "dir", access);
  return dir;
}

export function discardShadowFiles(files, cause) {
  const errors = [];

  for (const file of files) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }

  if (errors.length > 0) {
    const error = new AggregateError(
      [cause, ...errors],
      "spine: shadow write failed and cleanup failed",
    );
    error.code = cause?.code || "ESHADOWCLEANUP";
    throw error;
  }
}

export function writeShadowFile(
  file,
  body,
  access = {},
  { exclusive = false } = {},
) {
  const dir = dirname(file);
  ensureShadowDir(dir, access);

  const target = exclusive
    ? file
    : join(
        dir,
        `.${basename(file)}-${randomBytes(8).toString("hex")}.tmp`,
      );

  let fd = null;
  let created = false;
  let protectedPath = target;

  try {
    fd = openSync(target, "wx", 0o600);
    created = true;

    if (!exclusive) {
      renameSync(target, file);
      protectedPath = file;
    }

    tightenShadow(protectedPath, "file", access);
    writeFileSync(fd, body);

    const opened = fd;
    fd = null;
    closeSync(opened);
    return file;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }

    if (created) discardShadowFiles([protectedPath], error);
    throw error;
  }
}

export function writeShadowOwner(dir, access = {}) {
  return writeShadowFile(
    join(dir, "owner"),
    String(process.pid),
    access,
  );
}

export function shadowMaxBytes(env = process.env) {
  const bytes = Number(env.SPINE_SHADOW_MAX_BYTES);
  if (Number.isFinite(bytes) && bytes > 0) return Math.floor(bytes);
  const mb = Number(env.SPINE_SHADOW_MAX_MB);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return 256 * 1024 * 1024;
}

function readSessionKey(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(240);
    const count = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, count).toString("utf8").split("\n")[0] || "";
    return SESSION_MARK.exec(line)?.[1] || "";
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export function listPluginShadows(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!isPluginShadowName(name)) continue;
    const path = resolve(dir, name);
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      files.push({
        name,
        path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        sessionKey: readSessionKey(path),
      });
    } catch {}
  }
  return files;
}

function byAge(left, right) {
  return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
}

export function listShadowEntries(dir, alive = processAlive) {
  const entries = [];
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of names) {
    const path = resolve(dir, entry.name);
    if (entry.isFile() && isPluginShadowName(entry.name)) {
      try {
        const info = statSync(path);
        entries.push({
          name: entry.name,
          path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          sessionKey: "",
          legacy: true,
          live: false,
        });
      } catch {}
      continue;
    }
    if (!entry.isDirectory()) continue;
    const live = ownerPid(path) ? alive(ownerPid(path)) : false;
    for (const file of listPluginShadows(path)) {
      entries.push({ ...file, legacy: false, live, sessionKey: file.sessionKey || entry.name });
    }
  }
  return entries;
}

// 先删根目录旧文件，再删死会话，最后才删当前会话的旧文件。
// 当前卡片和这次引用的原文路径受保护。删不掉且仍然超限时返回 ok:false。
// Delete legacy root files, then dead sessions, then old files of this session.
// Protect the current card and cited raw paths. If unlink fails and the cap is still exceeded, ok is false.
export function rotateShadow({ dir, incomingBytes, protectPath, protectPaths = [], sessionKey, cap, unlink = unlinkSync, alive = processAlive }) {
  const files = listShadowEntries(dir, alive);
  const protect = new Set([protectPath, ...protectPaths].filter(Boolean).map((path) => resolve(path)));
  const current = sanitizeSessionKey(sessionKey);
  let used = files.reduce((sum, file) => sum + file.size, 0);
  const low = Math.floor(cap * 0.8);
  const oversize = incomingBytes > cap;
  if (!oversize && used + incomingBytes <= cap) {
    return { ok: true, deleted: 0, freed: 0, used, cap, oversize: false, failed: false };
  }
  const legacy = [];
  const dead = [];
  const mine = [];
  for (const file of files) {
    if (protect.has(file.path)) continue;
    if (file.live && file.sessionKey !== current) continue;
    if (file.legacy) legacy.push(file);
    else if (file.sessionKey === current) mine.push(file);
    else dead.push(file);
  }
  legacy.sort(byAge);
  dead.sort(byAge);
  mine.sort(byAge);
  let deleted = 0;
  let freed = 0;
  let failed = false;
  for (const file of [...legacy, ...dead, ...mine]) {
    if (!oversize && used + incomingBytes <= low) break;
    try {
      unlink(file.path);
    } catch (error) {
      if (error?.code === "ENOENT") {
        used -= file.size;
        freed += file.size;
        deleted += 1;
        continue;
      }
      failed = true;
      break;
    }
    used -= file.size;
    freed += file.size;
    deleted += 1;
    if (file.name.startsWith("raw-")) {
      try {
        unlink(`${file.path}.meta.json`);
      } catch {}
    }
  }
  const fits = used + incomingBytes <= cap;
  return {
    ok: !failed && (oversize || fits),
    deleted,
    freed,
    used,
    cap,
    oversize,
    failed,
  };
}
