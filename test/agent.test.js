import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEvents } from '../lib/agent.js';

test('init message yields the session id', () => {
  assert.deepEqual(toEvents({ type: 'system', subtype: 'init', session_id: 's1' }), [{ type: 'session', sessionId: 's1' }]);
});

test('assistant blocks become text and friendly tool labels', () => {
  const evs = toEvents({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Hola' },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b/c/app.js' } },
    { type: 'tool_use', name: 'Rare', input: {} },
    { type: 'text', text: '   ' },
  ] } });
  assert.deepEqual(evs, [
    { type: 'text', text: 'Hola' },
    { type: 'tool', name: 'Edit', label: 'Modificando c/app.js' },
    { type: 'tool', name: 'Rare', label: 'Usando Rare' },
  ]);
});

test('result maps to done with error info', () => {
  const [ev] = toEvents({ type: 'result', is_error: true, result: 'boom', session_id: 's', total_cost_usd: 1 });
  assert.equal(ev.type, 'done');
  assert.equal(ev.ok, false);
  assert.equal(ev.error, 'boom');
});

test('noise is ignored', () => {
  assert.deepEqual(toEvents({ type: 'rate_limit_event' }), []);
  assert.deepEqual(toEvents(null), []);
});
