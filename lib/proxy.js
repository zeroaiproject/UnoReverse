/**
 * Zero-dependency proxy transport.
 *
 * The Kilo AI documented workflow is "route through Tor's SOCKS5 port and renew
 * the circuit to get a new exit IP". Node's `fetch` has no SOCKS support, so this
 * module implements:
 *
 *   - a SOCKS5 client (`socks5h://` = remote DNS, `socks5://` = local DNS)
 *   - an HTTP CONNECT tunnel (`http://` proxy)
 *   - a `fetch`-compatible adapter over `node:http(s)` using those sockets
 *   - Tor control-port `SIGNAL NEWNYM` for circuit rotation
 *
 * No dependencies, works with the platform `fetch` API shape (Response, streams).
 */

import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { ApiError, ERROR_CODES } from "./errors.js";

/** Parse `socks5h://user:pass@host:9050`, `http://host:3128`, … */
export function parseProxyUrl(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") return { ...value };
  const raw = String(value).trim();
  if (!raw) return null;
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `socks5h://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (e) {
    throw new ApiError(`invalid proxy URL: ${raw}`, {
      code: ERROR_CODES.INVALID_INPUT,
      cause: e,
    });
  }
  const type = url.protocol.replace(":", "").toLowerCase();
  const supported = { socks5: "socks5", socks5h: "socks5h", http: "http", https: "https" };
  if (!supported[type]) {
    throw new ApiError(`unsupported proxy scheme: ${type}`, { code: ERROR_CODES.INVALID_INPUT });
  }
  return {
    type: supported[type],
    host: url.hostname,
    port: Number(url.port || (type.startsWith("socks") ? 1080 : 8080)),
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
  };
}

function socksReplyMessage(code) {
  const map = {
    0x01: "general SOCKS server failure",
    0x02: "connection not allowed by ruleset",
    0x03: "network unreachable",
    0x04: "host unreachable",
    0x05: "connection refused",
    0x06: "TTL expired",
    0x07: "command not supported",
    0x08: "address type not supported",
  };
  return map[code] || `SOCKS5 error 0x${code.toString(16)}`;
}

function readExactly(socket, n) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onReadable = () => {
      if (done) return;
      const chunk = socket.read(n);
      if (chunk == null) return;
      if (chunk.length < n) {
        socket.unshift(chunk);
        return;
      }
      cleanup();
      resolve(chunk);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("proxy closed the connection"));
    };
    socket.pause();
    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("close", onClose);
    onReadable();
  });
}

function connectTcp(host, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ApiError(`proxy connect timeout ${host}:${port}`, { code: ERROR_CODES.TIMEOUT }));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Open a tunnel to `targetHost:targetPort` through a SOCKS5 proxy. */
export async function socks5Connect(proxy, targetHost, targetPort, opts = {}) {
  const socket = await connectTcp(proxy.host, proxy.port, opts.connectTimeoutMs);
  try {
    const wantAuth = proxy.username != null;
    const methods = wantAuth ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const [ver, method] = await readExactly(socket, 2);
    if (ver !== 0x05) throw new ApiError("proxy is not SOCKS5", { code: ERROR_CODES.PROXY_ERROR });

    if (method === 0x02) {
      if (!wantAuth) throw new ApiError("proxy requires authentication", { code: ERROR_CODES.PROXY_ERROR });
      const user = Buffer.from(proxy.username || "", "utf8");
      const pass = Buffer.from(proxy.password || "", "utf8");
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const [, status] = await readExactly(socket, 2);
      if (status !== 0x00) {
        throw new ApiError("SOCKS5 authentication failed", { code: ERROR_CODES.PROXY_ERROR });
      }
    } else if (method === 0xff) {
      throw new ApiError("no acceptable SOCKS5 auth method", { code: ERROR_CODES.PROXY_ERROR });
    }

    let address;
    let atyp;
    if (proxy.type === "socks5") {
      // Local resolution: the proxy gets an IP.
      const resolved = await dns.lookup(targetHost);
      atyp = resolved.family === 6 ? 0x04 : 0x01;
      address = resolved.family === 6 ? ipv6Buffer(resolved.address) : ipv4Buffer(resolved.address);
    } else {
      if (net.isIP(targetHost)) {
        const family = net.isIP(targetHost);
        atyp = family === 6 ? 0x04 : 0x01;
        address = family === 6 ? ipv6Buffer(targetHost) : ipv4Buffer(targetHost);
      } else {
        const host = Buffer.from(targetHost, "utf8");
        if (host.length > 255) throw new ApiError("target hostname too long", { code: ERROR_CODES.INVALID_INPUT });
        atyp = 0x03;
        address = Buffer.concat([Buffer.from([host.length]), host]);
      }
    }

    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), address, portBuf]));

    const head = await readExactly(socket, 4);
    const [rver, rep, , ratyp] = head;
    if (rver !== 0x05) throw new ApiError("bad SOCKS5 reply", { code: ERROR_CODES.PROXY_ERROR });
    if (rep !== 0x00) {
      throw new ApiError(socksReplyMessage(rep), {
        code: ERROR_CODES.PROXY_ERROR,
        details: { reply: rep, target: `${targetHost}:${targetPort}` },
      });
    }
    // Consume the bound address we will never use.
    if (ratyp === 0x01) await readExactly(socket, 4);
    else if (ratyp === 0x04) await readExactly(socket, 16);
    else if (ratyp === 0x03) {
      const [len] = await readExactly(socket, 1);
      await readExactly(socket, len);
    }
    await readExactly(socket, 2); // bound port
    socket.resume();
    return socket;
  } catch (e) {
    socket.destroy();
    throw e instanceof ApiError ? e : new ApiError(e.message, { code: ERROR_CODES.PROXY_ERROR, cause: e });
  }
}

function ipv4Buffer(address) {
  return Buffer.from(address.split(".").map((n) => Number(n)));
}

function ipv6Buffer(address) {
  const sections = address.split("%")[0].split(":");
  const buf = Buffer.alloc(16);
  let idx = 0;
  const expanded = [];
  for (let i = 0; i < sections.length; i++) {
    if (sections[i] === "" && sections[i + 1] === "") {
      const missing = 8 - sections.filter((s) => s !== "").length;
      for (let k = 0; k < missing; k++) expanded.push("0");
      i++;
    } else if (sections[i] !== "") {
      expanded.push(sections[i]);
    }
  }
  for (const part of expanded.slice(0, 8)) {
    buf.writeUInt16BE(parseInt(part || "0", 16), idx);
    idx += 2;
  }
  return buf;
}

/** Open a tunnel through an HTTP CONNECT proxy. */
export async function httpConnect(proxy, targetHost, targetPort, opts = {}) {
  const socket = await connectTcp(proxy.host, proxy.port, opts.connectTimeoutMs);
  const auth =
    proxy.username != null
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64")}\r\n`
      : "";
  socket.write(
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}Connection: keep-alive\r\n\r\n`
  );
  const head = await readHttpHead(socket);
  if (!/^HTTP\/1\.[01] 2\d\d/.test(head)) {
    socket.destroy();
    throw new ApiError("HTTP CONNECT rejected", {
      code: ERROR_CODES.PROXY_ERROR,
      details: head.split("\r\n")[0],
    });
  }
  return socket;
}

function readHttpHead(socket, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onReadable = () => {
      if (done) return;
      let chunk;
      while ((chunk = socket.read()) !== null) {
        buffer += chunk.toString("latin1");
        const end = buffer.indexOf("\r\n\r\n");
        if (end !== -1) {
          const rest = Buffer.from(buffer.slice(end + 4), "latin1");
          cleanup();
          if (rest.length) socket.unshift(rest);
          resolve(buffer.slice(0, end));
          return;
        }
        if (buffer.length > maxBytes) {
          cleanup();
          reject(new ApiError("proxy response too large", { code: ERROR_CODES.PROXY_ERROR }));
          return;
        }
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("proxy closed the connection"));
    };
    socket.pause();
    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("close", onClose);
    onReadable();
  });
}

async function openTunnel(proxy, targetHost, targetPort, opts) {
  if (proxy.type === "socks5" || proxy.type === "socks5h") {
    return socks5Connect(proxy, targetHost, targetPort, opts);
  }
  return httpConnect(proxy, targetHost, targetPort, opts);
}

function bodyToBuffer(body) {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "object" && typeof body.toString === "function" && body.constructor?.name === "URLSearchParams") {
    return Buffer.from(body.toString(), "utf8");
  }
  throw new ApiError("unsupported request body type for proxy transport", {
    code: ERROR_CODES.INVALID_INPUT,
    details: typeof body,
  });
}

/**
 * Build a `fetch`-compatible function that egresses through `proxy`.
 * The returned function accepts the same `(url, init)` shape as global fetch.
 */
export function createProxyFetch(proxyInput, opts = {}) {
  const proxy = parseProxyUrl(proxyInput);
  if (!proxy) return opts.fetchImpl || globalThis.fetch;

  return async function proxyFetch(url, init = {}) {
    const target = new URL(String(url));
    const isHttps = target.protocol === "https:";
    if (!isHttps && target.protocol !== "http:") {
      throw new ApiError(`unsupported target protocol: ${target.protocol}`, {
        code: ERROR_CODES.INVALID_INPUT,
      });
    }
    const host = target.hostname;
    const port = Number(target.port || (isHttps ? 443 : 80));

    let socket;
    try {
      socket = await openTunnel(proxy, host, port, opts);
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError(e.message, { code: ERROR_CODES.PROXY_ERROR, cause: e });
    }

    const headers = { ...(init.headers || {}) };
    const hasHeader = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    // Each call opens its own tunnel, so keep-alive would only leak sockets.
    if (!hasHeader("connection")) headers.connection = "close";
    const body = bodyToBuffer(init.body);
    if (body && !hasHeader("content-length")) {
      headers["content-length"] = String(body.length);
    }

    const requestOptions = {
      method: init.method || "GET",
      host,
      port,
      path: `${target.pathname}${target.search}`,
      headers,
      agent: false,
      createConnection: () =>
        isHttps ? tls.connect({ socket, servername: host }) : socket,
    };

    return new Promise((resolve, reject) => {
      const requester = isHttps ? https.request : http.request;
      const req = requester(requestOptions, (res) => {
        const stream = Readable.toWeb(res);
        resolve(
          new Response(stream, {
            status: res.statusCode || 502,
            statusText: res.statusMessage || "",
            headers: res.headers,
          })
        );
      });
      req.on("error", (err) => {
        socket.destroy();
        reject(new ApiError(`proxy request failed: ${err.message}`, { code: ERROR_CODES.NETWORK_ERROR, cause: err }));
      });
      if (init.signal) {
        if (init.signal.aborted) {
          req.destroy();
          reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
          return;
        }
        init.signal.addEventListener(
          "abort",
          () => {
            req.destroy();
            reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
          },
          { once: true }
        );
      }
      if (body) req.write(body);
      req.end();
    });
  };
}

/**
 * Ask the local Tor control port for a new circuit (`SIGNAL NEWNYM`).
 * Auth modes: `password`, `cookie` (hex-encoded file content), or none.
 */
export async function torRenewIdentity({ host = "127.0.0.1", port = 9051, password, cookiePath, timeoutMs = 5000 } = {}) {
  const socket = await connectTcp(host, port, timeoutMs);
  const send = (line) => socket.write(`${line}\r\n`);
  const read = () => readHttpHeadLike(socket);

  try {
    let authLine = "AUTHENTICATE";
    if (cookiePath) {
      const raw = (await readFile(cookiePath, "utf8")).trim();
      authLine = `AUTHENTICATE ${raw}`;
    } else if (password) {
      authLine = `AUTHENTICATE "${String(password).replace(/"/g, '\\"')}"`;
    }
    send(authLine);
    const auth = await read();
    if (!/^250/m.test(auth)) throw new ApiError("Tor control authentication failed", { code: ERROR_CODES.PROXY_ERROR, details: auth });

    send("SIGNAL NEWNYM");
    const signal = await read();
    if (!/^250/m.test(signal)) {
      throw new ApiError("Tor NEWNYM rejected", { code: ERROR_CODES.PROXY_ERROR, details: signal });
    }
    send("QUIT");
    socket.end();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250);
      socket.once("finish", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { ok: true };
  } finally {
    socket.destroy();
  }
}

function readHttpHeadLike(socket, maxBytes = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onReadable = () => {
      if (done) return;
      let chunk;
      while ((chunk = socket.read()) !== null) {
        buffer += chunk.toString("utf8");
        // Tor replies are `250-...` lines terminated by `250 OK`.
        if (/(^|\r?\n)(250|4\d\d|5\d\d)[ ]/.test(buffer)) {
          cleanup();
          socket.resume();
          resolve(buffer.trim());
          return;
        }
        if (buffer.length > maxBytes) {
          cleanup();
          reject(new ApiError("Tor control response too large", { code: ERROR_CODES.PROXY_ERROR }));
          return;
        }
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Tor control port closed the connection"));
    };
    socket.pause();
    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("close", onClose);
    onReadable();
  });
}
