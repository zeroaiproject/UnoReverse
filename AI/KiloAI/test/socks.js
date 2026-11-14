/**
 * Minimal SOCKS5 CONNECT server for transport tests (no auth, IPv4/domain).
 * It tunnels to the requested host:port and is closed after each test.
 */

import net from "node:net";

export async function startSocksServer({ requireAuth = false } = {}) {
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage = 0;

    client.on("error", () => client.destroy());

    client.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 0) {
        if (buffer.length < 2) return;
        const methods = buffer[1];
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);
        if (requireAuth) {
          client.write(Buffer.from([0x05, 0xff]));
          client.destroy();
          return;
        }
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }

      if (stage === 1) {
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let host;
        let offset;
        if (atyp === 0x01) {
          if (buffer.length < 8) return;
          host = Array.from(buffer.subarray(4, 8)).join(".");
          offset = 8;
        } else if (atyp === 0x03) {
          const len = buffer[4];
          if (buffer.length < 5 + len + 2) return;
          host = buffer.subarray(5, 5 + len).toString("utf8");
          offset = 5 + len;
        } else {
          client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.destroy();
          return;
        }
        const port = buffer.readUInt16BE(offset);
        const rest = buffer.subarray(offset + 2);
        buffer = Buffer.alloc(0);
        stage = 2;

        const upstream = net.connect({ host, port }, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.removeAllListeners("data");
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
