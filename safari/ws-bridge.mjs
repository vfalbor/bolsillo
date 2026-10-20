// TCP → WebSocket bridge to make the snapshot in native QEMU with the same network as in Safari:
// QEMU (-netdev socket,connect=127.0.0.1:<tcp>) talks to c2w-net (--listen-ws) the way the page does
// (in the browser, Emscripten turns that socket into a WebSocket). Only bytes are passed through.
//
//   node safari/ws-bridge.mjs <tcp port> <ws://127.0.0.1:port>
import net from 'node:net';

const [port, wsUrl] = process.argv.slice(2);
net.createServer((sock) => {
  const ws = new WebSocket(wsUrl, { headers: { origin: "http://127.0.0.1" } }); // c2w-net rejects connections without Origin
  ws.binaryType = 'arraybuffer';
  const early = [];
  sock.on('data', (d) => (ws.readyState === 1 ? ws.send(d) : early.push(d)));
  console.log('QEMU connected');
  ws.onopen = () => { console.log('WebSocket open'); for (const d of early.splice(0)) ws.send(d); };
  ws.onmessage = (e) => sock.write(Buffer.from(e.data));
  ws.onclose = (e) => { console.log('WebSocket closed', e.code); sock.destroy(); };
  ws.onerror = (e) => { console.log('WebSocket error', e.message); sock.destroy(); };
  sock.on('close', () => ws.close());
  sock.on('error', () => ws.close());
}).listen(Number(port), '127.0.0.1', () => console.log(`bridge 127.0.0.1:${port} → ${wsUrl}`));
