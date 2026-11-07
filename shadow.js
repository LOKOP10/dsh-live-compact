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
import { homedir } from "node:os";
import {
  chmodSync,
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";

const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const PLUGIN_NAME = /^(?:(?:cut|official|shadow)-\d+-[0-9a-f]{8}|raw-[0-9a-f]{16}|\d+-[0-9a-f]{8}-[0-9a-f]{8}|\d+-[0-9a-f]{8,16})\.txt$/;
let cachedSid = "";
const lockedDirs = new Set();
let shadowFuse = false;
const shadowWarnings = new Set();

// No shared byte ledger. A positively dead holder leaves an immutable fence:
// recovery enables the original shared scans, never ownership or an estimate.
const ROTATION_LOCK = ".spine-rotation.lock";
const ROTATION_OWNER = ".spine-rotation.owner";
const ROTATION_SHARED = ".spine-rotation.shared";
const ROTATION_RECOVERED = ".spine-rotation.recovered";
const rotationOwner = randomBytes(24).toString("hex");
let rotationScope = null;
let shadowUsage = null;

export function shadowDirectory(env = process.env) {
  return env.SPINE_SHADOW_DIR || defaultShadowDirectory(env);
}

function defaultShadowDirectory(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), ".dsh"), "compaction-spine", "shadow");
}

function realDirectory(dir) {
  return realpathSync.native(dir);
}

function directoryIdentity(dir) {
  const info = statSync(dir, { bigint: true });
  if (!info.isDirectory() || info.ino <= 0n) return "";
  return `${info.dev}:${info.ino}`;
}

function coordinationError(cause) {
  const error = new Error("spine: shadow rotation coordination unavailable; backup refused", { cause });
  error.code = "ESHADOWBUSY";
  return error;
}

function touchExclusive(file, body = "") {
  let fd;
  try {
    fd = openSync(file, "wx", 0o600);
    writeFileSync(fd, body);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readRotationOwner(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(49);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, count).toString("utf8");
    return /^[0-9a-f]{48}$/.test(token) ? token : "";
  } finally {
    closeSync(fd);
  }
}

function rotationRecordText(record) {
  return `${JSON.stringify({ v: 1, pid: record.pid, id: record.id })}\n`;
}

function readRotationRecord(file) {
  // Reject directories (including old empty locks), symlinks and special files
  // before opening. Neither malformed nor oversized metadata proves death.
  if (!lstatSync(file).isFile()) throw new Error("shadow holder is not a regular file");
  const fd = openSync(file, "r");
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.size <= 0n || info.size > 256n) throw new Error("invalid shadow holder size");
    const buffer = Buffer.alloc(257);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, count).toString("utf8");
    const record = JSON.parse(text);
    if (count !== Number(info.size) || record?.v !== 1 ||
        !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > 0x7fffffff ||
        !/^[0-9a-f]{48}$/.test(record.id) || rotationRecordText(record) !== text) {
      throw new Error("invalid shadow holder record");
    }
    return { ...record, identity: `${info.dev}:${info.ino}` };
  } finally {
    closeSync(fd);
  }
}

function sameRotationRecord(left, right) {
  return left.pid === right.pid && left.id === right.id;
}

function publishRotationRecord(file, record) {
  const temp = `${file}.${randomBytes(24).toString("hex")}.tmp`;
  let fd;
  let created = false;
  try {
    fd = openSync(temp, "wx", 0o600);
    created = true;
    writeFileSync(fd, rotationRecordText(record));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Same-directory hard links atomically publish a complete, closed file on
    // POSIX and Windows. Unlike rename, link never replaces an existing lock.
    linkSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(temp);
  }
}

function syncRotationDirectory(root) {
  // Node cannot open/flush directory handles on Windows. The marker files are
  // flushed there too; POSIX also flushes their directory entries.
  if (process.platform === "win32") return;
  const fd = openSync(root, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function persistRotationShared(root) {
  const fd = openSync(join(root, ROTATION_SHARED), "a", 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("invalid shadow shared marker");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncRotationDirectory(root);
}

function verifyRotationGuard(root, identity, guard) {
  if (identity && directoryIdentity(root) !== identity) throw new Error("shadow directory identity changed");
  const current = readRotationRecord(join(root, ROTATION_LOCK));
  if (!sameRotationRecord(current, guard.record) || current.identity !== guard.record.identity) {
    throw new Error("shadow lock identity changed");
  }
}

function acquireRotationGuard(root, identity) {
  const lock = join(root, ROTATION_LOCK);
  const record = { pid: process.pid, id: randomBytes(24).toString("hex") };
  try {
    publishRotationRecord(lock, record);
    const published = readRotationRecord(lock);
    if (!sameRotationRecord(published, record)) throw new Error("shadow lock publication changed");
    return { owned: true, record: published };
  } catch (error) {
    shadowUsage = null;
    try { touchExclusive(join(root, ROTATION_SHARED)); } catch {}
    if (error?.code !== "EEXIST") throw error;
  }

  const guard = { owned: false, record: readRotationRecord(lock) };
  const recovered = join(root, ROTATION_RECOVERED);
  let recovery;
  try { recovery = readRotationRecord(recovered); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (recovery && !sameRotationRecord(recovery, guard.record)) throw new Error("shadow recovery identity changed");
  if (!recovery) {
    let dead = false;
    try { process.kill(guard.record.pid, 0); } catch (error) { dead = error?.code === "ESRCH"; }
    if (!dead) throw new Error("shadow holder is live or its death is unknown");
  }
  // Persist shared participation BEFORE permitting any action or recording
  // recovery. A later reused PID cannot resurrect this exact proven-dead token.
  persistRotationShared(root);
  verifyRotationGuard(root, identity, guard);
  if (!recovery) {
    try { publishRotationRecord(recovered, guard.record); } catch (error) {
      if (error?.code !== "EEXIST" || !sameRotationRecord(readRotationRecord(recovered), guard.record)) throw error;
    }
    syncRotationDirectory(root);
  }
  verifyRotationGuard(root, identity, guard);
  return guard; // Never unlink or replace an observed lock, even after ESRCH.
}

function dedicatedRoot(root, identity) {
  if (!identity || process.env.SPINE_SHADOW_SINGLE_PROCESS !== "1" || !process.env.SPINE_SHADOW_DIR) return false;
  try {
    if (realDirectory(process.env.SPINE_SHADOW_DIR) !== root) return false;
    // Explicitly spelling the normal shared root is not a dedicated-root contract.
    let normal = resolve(defaultShadowDirectory());
    try { normal = realDirectory(normal); } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return false;
    }
    return normal !== root;
  } catch {
    return false;
  }
}

// A root is explicit at production call sites. Standalone helpers can also find
// an already participating parent; custom callers must pass root when using a
// session directory outside their configured shadowDirectory().
export function shadowRootForDir(dir) {
  const configured = shadowDirectory();
  try {
    const root = realDirectory(configured);
    let path;
    try { path = realDirectory(dir); } catch {
      path = join(realDirectory(dirname(resolve(dir))), basename(dir));
    }
    if (path === root || dirname(path) === root) return configured;
  } catch {}
  if (existsSync(join(dirname(dir), ROTATION_OWNER)) || existsSync(join(dirname(dir), ROTATION_SHARED))) return dirname(dir);
  return dir;
}

function scopedFile(file, root) {
  const path = join(realDirectory(dirname(file)), basename(file));
  const dir = dirname(path);
  return dir === root || dirname(dir) === root ? path : null;
}

function verifyRotationScope() {
  try {
    verifyRotationGuard(rotationScope.root, rotationScope.identity, rotationScope.guard);
  } catch (error) {
    shadowUsage = null;
    throw coordinationError(error);
  }
}

function retireRotationScope() {
  shadowUsage = null;
  rotationScope.exclusive = false;
  touchExclusive(join(rotationScope.root, ROTATION_SHARED));
}

function rememberShadowParent(dir) {
  const identity = directoryIdentity(dir);
  const expected = rotationScope.parents.get(dir);
  if (expected !== undefined && expected !== identity) {
    retireRotationScope();
    throw coordinationError(new Error("shadow session directory identity changed"));
  }
  rotationScope.parents.set(dir, identity);
  if (!identity && rotationScope.exclusive) retireRotationScope();
  return identity;
}

// Synchronous and reentrant only within this module's current root transaction.
// Different module instances/workers have different random owner tokens and use
// the same filesystem lock, even when they share a PID or a path alias.
export function withShadowRoot(dir, action) {
  let root;
  try { root = realDirectory(dir); } catch (error) { throw coordinationError(error); }
  if (rotationScope) {
    if (rotationScope.root !== root) throw coordinationError(new Error("nested shadow roots"));
    verifyRotationScope();
    return action();
  }
  const shared = join(root, ROTATION_SHARED);
  let identity;
  let guard;
  try {
    identity = directoryIdentity(root);
    guard = acquireRotationGuard(root, identity);
  } catch (error) {
    shadowUsage = null;
    throw coordinationError(error);
  }
  try {
    verifyRotationGuard(root, identity, guard);
    const optedIn = guard.owned && dedicatedRoot(root, identity);
    const owner = join(root, ROTATION_OWNER);
    let token = "";
    if (optedIn && !existsSync(owner) && !existsSync(shared)) {
      shadowUsage = null;
      touchExclusive(owner, rotationOwner);
    }
    if (existsSync(owner)) {
      try { token = readRotationOwner(owner); } catch {}
      if (token !== rotationOwner || !optedIn) touchExclusive(shared);
    }
    const exclusive = optedIn && token === rotationOwner && !existsSync(shared);
    if (!exclusive || shadowUsage?.root !== root || shadowUsage?.identity !== identity) shadowUsage = null;
    rotationScope = { root, identity, guard, exclusive, parents: new Map() };
    return action();
  } finally {
    rotationScope = null;
    try {
      verifyRotationGuard(root, identity, guard);
      if (guard.owned) unlinkSync(join(root, ROTATION_LOCK));
    } catch (error) {
      shadowUsage = null;
      throw coordinationError(error);
    }
  }
}

export function resetShadowAccessState() {
  cachedSid = "";
  lockedDirs.clear();
  shadowFuse = false;
  shadowWarnings.clear();
}

export function shadowAccessFused() {
  return shadowFuse;
}

function tripFuse() {
  shadowFuse = true;
}

function envValue(env, name) {
  if (!env) return "";
  const found = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? String(env[found] ?? "").trim() : "";
}

export function windowsSystemRoot(env = process.env) {
  const systemRoot = envValue(env, "SystemRoot");
  const windir = envValue(env, "windir");
  const root = (DRIVE_ROOT.test(systemRoot) ? systemRoot : "") || (DRIVE_ROOT.test(windir) ? windir : "");
  return root.replace(/[\\/]+$/, "");
}

export function win32Tool(name, env = process.env) {
  const root = windowsSystemRoot(env);
  if (!root) {
    const error = new Error("spine: Windows system root is not a drive path");
    error.code = "ESHADOWACCESS";
    throw error;
  }
  return win32.join(root, "System32", name);
}

function lockKey(path) {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

export function shadowDirLocked(path) {
  return lockedDirs.has(lockKey(path));
}

export function noteShadowWarning(logger, error) {
  const code = error?.code || "ESHADOWACCESS";
  if (shadowWarnings.has(code)) return;
  shadowWarnings.add(code);
  const status = error?.cause?.status ?? error?.status;
  const step = error?.step || error?.cause?.step || "";
  const where = step ? ` ${step}` : "";
  const exit = status == null ? "" : ` exit ${status}`;
  logger?.warn?.(`spine: shadow permission failed ${code}${where}${exit}`);
}
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

export function defaultShadowAccessRunner({
  path,
  kind,
  platform,
  execFile = execFileSync,
  env = process.env,
} = {}) {
  if (platform !== "win32") {
    const plan = shadowAccessPlan(platform);
    chmodSync(path, kind === "dir" ? plan.dirMode : plan.fileMode);
    return true;
  }

  if (shadowFuse) {
    const error = new Error("spine: shadow permission already failed");
    error.code = "ESHADOWACCESS";
    throw error;
  }

  let whoamiPath = "";
  let icaclsPath = "";
  try {
    whoamiPath = win32Tool("whoami.exe", env);
    icaclsPath = win32Tool("icacls.exe", env);
  } catch (error) {
    tripFuse();
    throw error;
  }

  let sid = cachedSid;
  if (!sid) {
    let identity = "";
    try {
      identity = execFile(whoamiPath, ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
      });
    } catch (error) {
      error.step = "whoami";
      tripFuse();
      throw error;
    }
    const match = String(identity ?? "").match(/,"(S-\d+(?:-\d+)+)"\s*$/i);
    if (!match) {
      const error = new Error("spine: cannot determine current Windows user SID");
      error.step = "whoami";
      tripFuse();
      throw error;
    }
    sid = match[1];
    cachedSid = sid;
  }

  const plan = shadowAccessPlan("win32", sid, kind);
  try {
    execFile(
      icaclsPath,
      [resolve(path), "/inheritance:r", "/grant:r", ...plan.grant],
      { stdio: "pipe", windowsHide: true },
    );
  } catch (error) {
    error.step = kind === "file" ? "file" : "dir";
    tripFuse();
    throw error;
  }

  if (kind === "dir") lockedDirs.add(lockKey(path));
  return true;
}

export function tightenShadow(path, kind = "dir", access = {}) {
  const platform = access.platform ?? process.platform;
  const windows = platform === "win32" && !access.runner;
  if (windows && kind === "file" && shadowDirLocked(dirname(path))) return;
  if (windows && shadowFuse) {
    const error = new Error("spine: shadow permission action failed; backup refused");
    error.code = "ESHADOWACCESS";
    throw error;
  }

  const runner = access.runner ?? ((action) => defaultShadowAccessRunner({
    ...action,
    execFile: access.execFile,
    env: access.env,
  }));

  try {
    if (runner({ path, kind, platform, env: access.env, execFile: access.execFile }) !== true) {
      throw new Error("permission runner did not confirm success");
    }
  } catch (cause) {
    if (windows) tripFuse();
    const error = new Error(
      "spine: shadow permission action failed; backup refused",
      { cause },
    );
    error.code = "ESHADOWACCESS";
    error.step = cause?.step;
    throw error;
  }
}

export function ensureShadowDir(dir, access = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const platform = access.platform ?? process.platform;
  if (!access.runner && platform === "win32" && shadowDirLocked(dir)) return dir;
  tightenShadow(dir, "dir", access);
  return dir;
}

export function discardShadowFiles(files, cause, unlink = unlinkSync) {
  const errors = [];

  for (const file of files) {
    if (rotationScope) {
      verifyRotationScope();
      const path = scopedFile(file, rotationScope.root);
      if (!path) throw coordinationError(new Error("cleanup outside shadow root"));
      rememberShadowParent(dirname(path));
    }
    try {
      unlink(file);
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
  { exclusive = false, root, write = writeFileSync, unlink = unlinkSync } = {},
) {
  const dir = dirname(file);
  ensureShadowDir(dir, access);
  return withShadowRoot(root ?? shadowRootForDir(dir), () => {
    const path = scopedFile(file, rotationScope.root);
    if (!path) throw coordinationError(new Error("shadow file outside root scope"));
    writeShadowFileLocked(path, body, access, { exclusive, write, unlink, accessPath: file });
    return file;
  });
}

function writeShadowFileLocked(file, body, access, { exclusive, write, unlink, accessPath }) {
  const dir = dirname(file);
  const parentIdentity = rememberShadowParent(dir);

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

    // Keep the caller's spelling for the existing permission cache/runner.
    // The opened descriptor and cleanup path remain in the canonical root.
    tightenShadow(accessPath, "file", access);
    verifyRotationScope();
    if (parentIdentity && directoryIdentity(dir) !== parentIdentity) {
      retireRotationScope();
      throw coordinationError(new Error("shadow session directory identity changed"));
    }
    // Full replacement bytes are a conservative charge, even for overwrites,
    // partial writes and failed cleanup. Metadata/owner/stats are not capacity.
    if (shadowUsage && isPluginShadowName(basename(file))) {
      shadowUsage.bytes += typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
    }
    write(fd, body);

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

    if (created) {
      // Do not unlink through a replacement directory after a failed write.
      let sameParent = false;
      try { sameParent = !parentIdentity || directoryIdentity(dir) === parentIdentity; } catch {}
      if (sameParent) discardShadowFiles([protectedPath], error, unlink);
      else shadowUsage = null;
    }
    throw error;
  }
}

export function writeShadowOwner(dir, access = {}, root) {
  return writeShadowFile(
    join(dir, "owner"),
    String(process.pid),
    access,
    { root },
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

export function listPluginShadows(dir, { readdir = readdirSync, stat = statSync, onError } = {}) {
  let names = [];
  try {
    names = readdir(dir);
  } catch {
    onError?.();
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!isPluginShadowName(name)) continue;
    const path = resolve(dir, name);
    try {
      const info = stat(path);
      if (!info.isFile()) continue;
      files.push({
        name,
        path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        sessionKey: readSessionKey(path),
      });
    } catch { onError?.(); }
  }
  return files;
}

function byAge(left, right) {
  return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
}

export function listShadowEntries(dir, alive = processAlive, { readdir = readdirSync, stat = statSync, onError } = {}) {
  const entries = [];
  let names = [];
  try {
    names = readdir(dir, { withFileTypes: true });
  } catch {
    onError?.();
    return entries;
  }
  for (const entry of names) {
    if (entry.name === ROTATION_LOCK) continue;
    const path = resolve(dir, entry.name);
    if (entry.isFile() && isPluginShadowName(entry.name)) {
      try {
        const info = stat(path);
        entries.push({
          name: entry.name,
          path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          sessionKey: "",
          legacy: true,
          live: false,
        });
      } catch { onError?.(); }
      continue;
    }
    if (!entry.isDirectory()) continue;
    const live = ownerPid(path) ? alive(ownerPid(path)) : false;
    for (const file of listPluginShadows(path, { readdir, stat, onError })) {
      entries.push({ ...file, legacy: false, live, sessionKey: file.sessionKey || entry.name });
    }
  }
  return entries;
}

// 先删根目录旧文件，再删死会话，最后才删当前会话的旧文件。
// 当前卡片和这次引用的原文路径受保护。删不掉且仍然超限时返回 ok:false。
// Delete legacy root files, then dead sessions, then old files of this session.
// Protect the current card and cited raw paths. If unlink fails and the cap is still exceeded, ok is false.
export function rotateShadow(options) {
  return withShadowRoot(options.dir, () => rotateShadowLocked(options));
}

function rotateShadowLocked({
  incomingBytes, protectPath, protectPaths = [], sessionKey, cap,
  unlink = unlinkSync, alive = processAlive, readdir = readdirSync, stat = statSync,
}) {
  const { root, identity, exclusive } = rotationScope;
  const low = Math.floor(cap * 0.8);
  const oversize = incomingBytes > cap;
  if (exclusive && shadowUsage?.cap === cap && Number.isSafeInteger(incomingBytes) && incomingBytes >= 0 && !oversize && shadowUsage.bytes + incomingBytes < low) {
    return { ok: true, deleted: 0, freed: 0, used: shadowUsage.bytes, cap, oversize: false, failed: false, estimated: true };
  }
  let complete = true;
  const files = listShadowEntries(root, alive, { readdir, stat, onError() { complete = false; } });
  const protect = new Set([protectPath, ...protectPaths].filter(Boolean).map((path) => {
    try { return join(realDirectory(dirname(path)), basename(path)); } catch { return resolve(path); }
  }));
  const current = sanitizeSessionKey(sessionKey);
  let used = files.reduce((sum, file) => sum + file.size, 0);
  const validBytes = [used, incomingBytes, cap].every(Number.isSafeInteger) && used >= 0 && incomingBytes >= 0 && cap > 0;
  const usage = exclusive && complete && validBytes ? { root, identity, cap, bytes: used } : null;
  shadowUsage = usage;
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
  if (usage) usage.bytes = used;
  if (failed) shadowUsage = null;
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
