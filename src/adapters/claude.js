// Brink adapter — Claude Code. Implements the two-method adapter contract:
//   readUsage() -> normalized usage   |   denyOutput(reason) -> how this CLI blocks
// Usage source: the state.json the Brink statusline writes (the cleanest source of all).
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = () => process.env.BRINK_DIR || path.join(os.homedir(), '.claude', 'brink');

function readUsage() {
  const sp = path.join(dir(), 'state.json');
  if (!fs.existsSync(sp)) return null;
  try {
    const raw = fs.readFileSync(sp, 'utf8');
    const s = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    const num = (v) => (typeof v === 'number' ? v : null);
    return {
      provider: 'claude',
      five_pct: num(s.five_pct),
      week_pct: num(s.week_pct),
      five_reset: num(s.five_reset),
      week_reset: num(s.week_reset),
      updated_at: num(s.updated_at),
      session_id: s.session_id || '',
      cwd: s.cwd || '',
      model: s.model || '',
    };
  } catch { return null; }
}

// Claude Code PreToolUse deny: JSON on stdout, exit 0.
function denyOutput(reason) {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

module.exports = { name: 'claude', readUsage, denyOutput };
