// Brink core — resume-in-place target validation + context (pure, no I/O). Phase 8.
function validateTarget(recorded, live) {
  if (!recorded || !live) return false;
  return live.pid === recorded.SessionPid && live.startTime === recorded.SessionStartTime;
}
function serializeCtx(obj) { return JSON.stringify(obj); }
function parseCtx(str) { try { return JSON.parse(str); } catch { return null; } }
module.exports = { validateTarget, serializeCtx, parseCtx };
