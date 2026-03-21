/**
 * UDP discovery responder — lets MCP servers announce themselves to the aggregator.
 * Zero dependencies, uses built-in Node.js dgram module.
 */

const dgram = require('dgram');

function createDiscoveryResponder({ name, description, tools, port = 9099, listenPort = 9099, auth, onDiscovery }) {
  const payload = { type: 'announce', name, description, tools, port };
  if (auth) payload.auth = auth;
  const manifest = JSON.stringify(payload);

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (data, rinfo) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'discovery') {
        console.log(`Discovery request from ${rinfo.address}:${rinfo.port}, announcing`);
        socket.send(manifest, rinfo.port, rinfo.address);
        if (onDiscovery) {
          onDiscovery({ mcp_url: msg.mcp_url || null });
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  socket.on('error', (err) => {
    console.error('Announce socket error:', err.message);
  });

  socket.bind(listenPort, '0.0.0.0', () => {
    console.log(`Discovery responder listening on UDP :${listenPort} for ${name}`);
  });

  return socket;
}

module.exports = { createDiscoveryResponder };
