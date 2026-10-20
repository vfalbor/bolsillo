// Puente TCP → WebSocket para hacer la instantánea en QEMU nativo con la misma red que en Safari:
// QEMU (-netdev socket,connect=127.0.0.1:<tcp>) habla con c2w-net (--listen-ws) como lo hace la página
// (en el navegador, Emscripten convierte ese socket en un WebSocket). Solo se pasan los bytes.
//
//   node safari/ws-bridge.mjs <puerto tcp> <ws://127.0.0.1:puerto>
import net from 'node:net';

const [port, wsUrl] = process.argv.slice(2);
net.createServer((sock) => {
  const ws = new WebSocket(wsUrl, { headers: { origin: "http://127.0.0.1" } }); // c2w-net rechaza las conexiones sin Origin
  ws.binaryType = 'arraybuffer';
  const early = [];
  sock.on('data', (d) => (ws.readyState === 1 ? ws.send(d) : early.push(d)));
  console.log('QEMU conectado');
  ws.onopen = () => { console.log('WebSocket abierto'); for (const d of early.splice(0)) ws.send(d); };
  ws.onmessage = (e) => sock.write(Buffer.from(e.data));
  ws.onclose = (e) => { console.log('WebSocket cerrado', e.code); sock.destroy(); };
  ws.onerror = (e) => { console.log('WebSocket error', e.message); sock.destroy(); };
  sock.on('close', () => ws.close());
  sock.on('error', () => ws.close());
}).listen(Number(port), '127.0.0.1', () => console.log(`puente 127.0.0.1:${port} → ${wsUrl}`));
