import { closeSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const PLUGIN_NAME = /^(?:(?:cut|official|shadow)-\d+-[0-9a-f]{8}|\d+-[0-9a-f]{8,16})\.txt$/;
const SESSION_MARK = /^# spine-session (\S+)/;

export function isPluginShadowName(name) {
  return PLUGIN_NAME.test(name);
}

export function shadowFileBody(sessionKey, body) {
  const key = String(sessionKey || "default").replace(/\s+/g, "");
  return `# spine-session ${key}\n${body || ""}`;
}

export function shadowMaxBytes(env = process.env) {
  const bytes = Number(env.SPINE_SHADOW_MAX_BYTES);
  if (Number.isFinite(bytes) && bytes > 0) return Math.floor(bytes);
  const mb = Number(env.SPINE_SHADOW_MAX_MB);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return 128 * 1024 * 1024;
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

export function rotateShadow({ dir, incomingBytes, protectPath, sessionKey, cap, unlink = unlinkSync }) {
  const files = listPluginShadows(dir);
  const protect = protectPath ? resolve(protectPath) : "";
  const current = String(sessionKey || "");
  let used = files.reduce((sum, file) => sum + file.size, 0);
  const low = Math.floor(cap * 0.8);
  const oversize = incomingBytes > cap;
  if (!oversize && used + incomingBytes <= cap) {
    return { ok: true, deleted: 0, freed: 0, used, cap, oversize: false };
  }
  const others = [];
  const untagged = [];
  const mine = [];
  for (const file of files) {
    if (file.path === protect) continue;
    if (!file.sessionKey) untagged.push(file);
    else if (file.sessionKey === current) mine.push(file);
    else others.push(file);
  }
  others.sort(byAge);
  untagged.sort(byAge);
  mine.sort(byAge);
  let deleted = 0;
  let freed = 0;
  let failed = false;
  for (const file of [...others, ...untagged, ...mine]) {
    if (!oversize && used + incomingBytes <= low) break;
    try {
      unlink(file.path);
    } catch {
      failed = true;
      break;
    }
    used -= file.size;
    freed += file.size;
    deleted += 1;
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
