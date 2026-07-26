// Brink core — handoff writer (Phase 5).
// Brink writes HANDOFF.md ITSELF (deterministically, from the session transcript) rather
// than instructing the model to — because the live test (2026-06-26) showed the model may
// distrust a tool-result that orders it around and refuse. The handoff must survive even if
// the model won't cooperate. Best-effort transcript parse; degrades gracefully.
const fs = require('fs');
const path = require('path');

function readTranscript(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8'); if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return raw.split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function summarize(events) {
  let lastUser = '';
  const actions = [];
  for (const e of events) {
    const msg = e.message || e;
    const role = msg.role || e.type;
    const content = msg.content;
    if (role === 'user' && content) {
      const txt = typeof content === 'string'
        ? content
        : (Array.isArray(content) && (content.find((c) => c.type === 'text') || {}).text);
      // skip tool_result echoes; keep real user prose
      if (txt && !(Array.isArray(content) && content.some((c) => c.type === 'tool_result'))) lastUser = txt;
    }
    if (role === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'tool_use') {
          const tgt = (c.input && (c.input.file_path || c.input.path || c.input.command)) || '';
          actions.push(`${c.name}${tgt ? ' -> ' + String(tgt).slice(0, 80) : ''}`);
        }
      }
    }
  }
  return { lastUser: String(lastUser || '').slice(0, 800), actions: actions.slice(-8) };
}

function writeHandoff({ transcriptPath, outPath, pct, window, resetText, isGit }) {
  const events = transcriptPath ? readTranscript(transcriptPath) : [];
  const { lastUser, actions } = summarize(events);
  const lines = [
    '# HANDOFF - paused by Brink',
    '',
    `Paused at **${Math.round(pct)}%** of your ${window} usage limit${resetText ? ` (resets ${resetText})` : ''}.`,
    'This file was written automatically so no progress is lost. To resume, read it and continue the task.',
    '',
    '## The task',
    '',
    lastUser ? '> ' + lastUser.replace(/\n/g, '\n> ') : '_(could not read the original request from the transcript)_',
    '',
    '## Recent actions before the pause',
    '',
    actions.length ? actions.map((a) => '- ' + a).join('\n') : '_(no recent tool actions captured)_',
    '',
    '## Next steps',
    '',
    '- Continue the task above from where it stopped.',
    isGit ? '- This IS a git repo - review uncommitted changes before continuing.' : '- (not a git repo - nothing to commit)',
    '',
  ];
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join('\n'));
    return outPath;
  } catch { return null; }
}

module.exports = { writeHandoff, summarize, readTranscript };
