#!/usr/bin/env node
// Stands in for `claude -p ... --output-format stream-json` in tests.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const prompt = args[args.indexOf('-p') + 1];
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const sid = resumed || 'sess-123';
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: sid });
fs.writeFileSync('nota.txt', `${prompt}\n`, { flag: 'a' });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `${process.cwd()}/nota.txt` } }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text: `Hecho: ${prompt}${resumed ? ' (reanudado)' : ''}` }] } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.01 });
