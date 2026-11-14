import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { parseProxyUrl, torRenewIdentity } from "../../../lib/proxy.js";

async function fakeTorControl({ rejectAuth = false } = {}) {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        seen.push(line);
        if (line.startsWith("AUTHENTICATE")) {
          socket.write(rejectAuth ? "515 Authentication failed\r\n" : "250 OK\r\n");
        } else if (line === "SIGNAL NEWNYM") {
          socket.write("250 OK\r\n");
        } else if (line === "QUIT") {
          socket.end("250 closing connection\r\n");
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("parseProxyUrl understands socks5h, socks5, http and bare host:port", () => {
  assert.deepEqual(parseProxyUrl("socks5h://user:p%40ss@127.0.0.1:9050"), {
    type: "socks5h",
    host: "127.0.0.1",
    port: 9050,
    username: "user",
    password: "p@ss",
  });
  assert.equal(parseProxyUrl("127.0.0.1:9050").type, "socks5h");
  assert.deepEqual(parseProxyUrl("http://proxy.local:3128"), {
    type: "http",
    host: "proxy.local",
    port: 3128,
    username: null,
    password: null,
  });
  assert.equal(parseProxyUrl(""), null);
  assert.throws(() => parseProxyUrl("ftp://proxy:21"), /unsupported proxy scheme/);
});

test("torRenewIdentity authenticates, signals NEWNYM and quits", async () => {
  const control = await fakeTorControl();
  try {
    const result = await torRenewIdentity({ host: "127.0.0.1", port: control.port });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(control.seen.slice(0, 2), ["AUTHENTICATE", "SIGNAL NEWNYM"]);
    assert.equal(control.seen.at(-1), "QUIT");
  } finally {
    await control.close();
  }
});

test("torRenewIdentity surfaces a rejected AUTHENTICATE", async () => {
  const control = await fakeTorControl({ rejectAuth: true });
  try {
    await assert.rejects(
      torRenewIdentity({ host: "127.0.0.1", port: control.port }),
      /authentication failed/i
    );
  } finally {
    await control.close();
  }
});

test("torRenewIdentity sends a password", async () => {
  const control = await fakeTorControl();
  try {
    await torRenewIdentity({ host: "127.0.0.1", port: control.port, password: "hunter2" });
    assert.equal(control.seen[0], 'AUTHENTICATE "hunter2"');
  } finally {
    await control.close();
  }
});
