#!/usr/bin/env node
// Stands in for `claude -p ... --output-format stream-json` in tests.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
// Sign-in: logged in once a login succeeded (flag file next to the HOME the test gives us).
const flag = `${process.env.HOME}/.fake-claude-login`;
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = fs.existsSync(flag);
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' }));
  process.exit(loggedIn ? 0 : 1);
}
if (args[0] === 'auth' && args[1] === 'login') {
  process.stdout.write('Visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&state=abc\x07link\x1b]8;;\x07\r\nPaste code here if prompted > ');
  process.stdin.once('data', (d) => {
    if (String(d).trim() === 'codigo-bueno') { fs.writeFileSync(flag, 'ok'); console.log('\r\nLogin successful'); process.exit(0); }
    console.log('\r\nOAuth error: invalid code'); process.exit(1);
  });
} else {
  const prompt = args[args.indexOf('-p') + 1];
  const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const sid = resumed || 'sess-123';
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init', session_id: sid });
  fs.writeFileSync('nota.txt', `${prompt}\n`, { flag: 'a' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `${process.cwd()}/nota.txt` } }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `Hecho: ${prompt}${resumed ? ' (reanudado)' : ''}` }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.01 });
}
