// Brink adapter — OpenAI Codex CLI.
// readUsage(): parse the newest ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl token_count
//   event, which carries the primary (~5h) + secondary (~weekly) rate-limit windows.
// denyOutput(): Codex PreToolUse blocks via exit code 2 + reason on stderr.
//
// Field names VERIFIED against Codex Rust source (protocol.rs, RateLimitWindow) + 53 real
// local rollout files: guard .type=="event_msg" && .payload.type=="token_count"; data at
// .payload.rate_limits.{primary,secondary}.{used_percent, window_minutes, resets_at} (epoch s).
// ⚠️ UPSTREAM BUG (openai/codex#14880): rate_limits is almost always `null` in rollout files,
//   so this returns null TODAY and pause won't fire until OpenAI populates it (or we add an alt
//   source: auth.json -> ChatGPT usage endpoint). We scan back for a populated line and never
//   act on null (safe no-op). ⚠️ Codex PreToolUse also reliably gates Bash only (edits/MCP leaky).
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionsDir = () => process.env.CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions');

function newestRollout(root) {
  if (!fs.existsSync(root)) return null;
  let best = null;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
  };
  try { walk(root); } catch { return null; }
  return best && best.p;
}

const pick = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return null;
};

function parseWindow(w, now) {
  if (!w) return { pct: null, reset: null };
  const pct = pick(w, ['used_percent', 'used_percentage', 'percent', 'percent_used']);
  const at = pick(w, ['resets_at', 'reset_at']);
  const inSecs = pick(w, ['resets_in_seconds', 'reset_in_seconds', 'resets_in']);
  let reset = null;
  if (typeof at === 'number') reset = at > 1e12 ? Math.floor(at / 1000) : at;
  else if (typeof inSecs === 'number') reset = now + inSecs;
  return { pct: typeof pct === 'number' ? pct : null, reset };
}

function readUsage() {
  const f = newestRollout(sessionsDir());
  if (!f) return null;
  let lines;
  try { let raw = fs.readFileSync(f, 'utf8'); if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); lines = raw.split(/\r?\n/).filter(Boolean); } catch { return null; }
  let rl = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    rl = ev.rate_limits || (ev.payload && ev.payload.rate_limits) || (ev.info && ev.info.rate_limits) || null;
    if (rl) break;
  }
  if (!rl) return null;
  const now = Math.floor(Date.now() / 1000);
  const primary = parseWindow(rl.primary || rl.five_hour, now);
  const secondary = parseWindow(rl.secondary || rl.seven_day || rl.weekly, now);
  return {
    provider: 'codex',
    five_pct: primary.pct, five_reset: primary.reset,
    week_pct: secondary.pct, week_reset: secondary.reset,
    session_id: '', cwd: process.cwd(),
  };
}

// Codex PreToolUse deny: exit code 2 + reason on stderr (the reliable path).
function denyOutput(reason) {
  return { stderr: reason, exitCode: 2 };
}

module.exports = { name: 'codex', readUsage, denyOutput };
