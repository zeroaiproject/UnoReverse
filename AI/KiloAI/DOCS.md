# Kilo AI — Tor + Anonymous Gateway

> **Target:** `https://api.kilo.ai/api/gateway/v1` (OpenAI-compatible gateway, anonymous keyless access)  
> **Model (documented example):** `reflection/beam-free`  
> **Principle:** API requests routed through a Tor `SOCKS5` proxy + exit-IP rotation to work around IP-based limits  
> **Status:** Technical documentation (how it works, setup, limitations)

---

## Table of Contents

- [Overview](#overview)
- [Architecture & Network Flow](#architecture--network-flow)
- [Why It Works](#why-it-works)
  - [1. Keyless gateway access](#1-keyless-gateway-access)
  - [2. Access control/quotas primarily tied to IP](#2-access-controlquotas-primarily-tied-to-ip)
  - [3. Tor as an IP-rotation layer](#3-tor-as-an-ip-rotation-layer)
  - [4. API compatibility (chat/completions format)](#4-api-compatibility-chatcompletions-format)
- [Implementation](#implementation)
  - [Prerequisites](#prerequisites)
  - [Baseline `curl` example](#baseline-curl-example)
  - [Tor identity rotation](#tor-identity-rotation)
  - [Useful parameters](#useful-parameters)
- [Limitations & Constraints](#limitations--constraints)
  - [Gateway-side limitations](#gateway-side-limitations)
  - [Tor-related limitations](#tor-related-limitations)
  - [Anonymity & traceability limitations](#anonymity--traceability-limitations)
  - [Reliability & reproducibility](#reliability--reproducibility)
  - [Model/prompt behavior](#modelprompt-behavior)
- [Quick Troubleshooting](#quick-troubleshooting)
- [Quick Reference](#quick-reference)

---

## Overview

The Kilo AI gateway exposes an **OpenAI Chat Completions–style** interface that can be accessed **without an API key** (*keyless*). In this mode, the service typically enforces controls (quotas/rate limits, filtering, availability) at the network/usage level rather than through an authenticated account.

By routing requests through **Tor** (`--socks5-hostname 127.0.0.1:9050`), the client egresses via a **Tor exit node** IP. Changing the Tor circuit/identity yields a different exit IP, which can **distribute or reset** limits associated with a given source IP.

**In short:**
- *Access* → anonymous gateway (no key)
- *Quota distribution* → IP changes via Tor
- *Interface* → OpenAI-compatible `/chat/completions` endpoint

---

## Architecture & Network Flow

```text
┌──────────────┐      SOCKS5 (9050)      ┌─────────────┐      TLS/HTTPS      ┌──────────────────────────────┐
│ Client (curl │ ──────────────────────▶ │  Local Tor  │ ─────────────────▶ │  api.kilo.ai (Gateway v1)    │
│ / app)       │   DNS resolved via      │  client     │   source IP =      │  /api/gateway/v1/...         │
└──────────────┘   proxy (hostname)      └──────┬──────┘   Tor exit node    └──────────────┬───────────────┘
                                                │                                      │
                                         [Tor circuit]                                 ▼
                                       entry → middle → exit                    ┌───────────────┐
                                                                                │  LLM model    │
                                                                                │ (e.g. beam)   │
                                                                                └───────────────┘

Rotation: "New Identity" / new circuit  ⇒  new exit IP  ⇒  fresh IP-side quota bucket
```

**Key point:** `--socks5-hostname` (not `--socks5`) asks the proxy to resolve the hostname, avoiding local DNS leaks in this call path.

---

## Why It Works

### 1. Keyless gateway access

- The endpoint is exposed in **keyless** mode: no `Authorization: Bearer <API_KEY>` is required for a valid request.
- Without a strong account identity, the service cannot bind usage to an authenticated user and instead relies on available signals (source IP, fingerprints, volume, patterns, and any gateway-side session/anti-abuse tokens).

**Implication:** low barrier to entry (standard HTTP JSON request).

### 2. Access control/quotas primarily tied to IP

- Anonymous/free gateways commonly enforce **rate limits** and quotas per **IP address** (requests/min, tokens/day, concurrency, etc.).
- An exhausted or throttled IP receives errors/rate-limiting; a "new" IP has not (yet) consumed the same budget.

**Implication:** changing the IP observed by the gateway can restore request capacity.

### 3. Tor as an IP-rotation layer

- Tor routes traffic through a **circuit** (guard → middle relay → exit node). The remote server sees the **exit node** IP.
- Requesting a **new identity/circuit** generally yields a different exit node and therefore a **different source IP** from the gateway's perspective.
- Rotation can be manual (signal/control port) or occur naturally depending on circuit management.

**Implication:** Tor provides a practical mechanism for IP rotation without operating your own proxy infrastructure.

### 4. API compatibility (chat/completions format)

- The gateway speaks an **OpenAI-compatible** schema (`/chat/completions`, `model`, `messages`, `max_tokens`, etc.).
- Existing clients/tools work with a simple `base URL` change and no key.

**Implication:** immediate integration (curl, compatible SDKs, scripts).

---

## Implementation

### Prerequisites

- **Tor** running with a local SOCKS5 proxy (default `127.0.0.1:9050`).
  - Debian/Ubuntu: `apt install tor && systemctl start tor`
  - Quick check: `ss -ltnp | grep 9050` or `curl --socks5-hostname 127.0.0.1:9050 https://check.torproject.org/api/ip`
- **curl** (or any HTTP client supporting SOCKS5 with remote hostname resolution).
- Outbound connectivity to the Tor network and to `api.kilo.ai`.

### Baseline `curl` example

```bash
curl -sS --socks5-hostname 127.0.0.1:9050 \
  https://api.kilo.ai/api/gateway/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "reflection/beam-free",
    "messages": [
      {"role": "system", "content": "<SYSTEM_PROMPT>"},
      {"role": "user", "content": "Briefly explain how you work."}
    ],
    "max_tokens": 400,
    "reasoning_effort": "none"
  }'
```

**Notes:**
- Replace `<SYSTEM_PROMPT>` with the desired system prompt.
- For reasoning-oriented models, a lower setting (`reasoning_effort: "none"` or `"low"`) can reduce reasoning verbosity/latency depending on model support.

### Tor identity rotation

```bash
# If ControlPort is enabled (e.g. 9051) with cookie/auth configured:
# Conceptual example (adapt to your torrc):
#   echo -e 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT' | nc 127.0.0.1 9051

# Simple alternative: restart the Tor service (slower, less subtle)
#   systemctl restart tor
```

- `SIGNAL NEWNYM` requests new circuits; the effect on the exit IP depends on exit availability and circuit reuse policies (not always instantaneous or guaranteed on every attempt).
- Good pattern: detect `429`/quota errors → brief wait → new identity → retry with backoff.

### Useful parameters

| Parameter | Role | Notes |
|---|---|---|
| `model` | Selects the backend model | e.g. `reflection/beam-free` (availability may vary) |
| `messages` | Conversation context (`system`, `user`, `assistant`) | OpenAI format |
| `max_tokens` | Output cap | affects latency and gateway-side quotas |
| `temperature`, `top_p` | Sampling controls | subject to gateway/model support |
| `reasoning_effort` | Reasoning effort (if supported) | `none`/`low` for more direct/lightweight responses |
| `stream` | Token-by-token streaming (if supported) | verify per implementation |

---

## Limitations & Constraints

### Gateway-side limitations

| Limitation | Details |
|---|---|
| **Rate limits / quotas** | Per IP, per time window, per token volume, or by concurrency; may persist despite rotation (global quotas, heuristics). |
| **Model availability** | Anonymous/`*-free` models may be removed, renamed, saturated, or degraded without notice. |
| **API changes** | Endpoint, schema, accepted fields, or policies may evolve (breaking changes). |
| **Gateway-side filtering** | Prompt/response blocking, moderation, or refusals may be enforced by the provider/gateway regardless of the system prompt. |
| **No SLA** | Best-effort service: no guarantees on uptime, latency, or capacity. |

### Tor-related limitations

| Limitation | Details |
|---|---|
| **Latency & throughput** | Multi-hop circuits ⇒ higher RTT, lower throughput, less smooth streaming. |
| **Stability** | Circuits can break; timeouts and retries are necessary. |
| **Exit blocking** | Some services block or challenge Tor exit IPs (CAPTCHAs, 403/429, reputation lists). |
| **Variable exit quality** | Exits may already be "burned"/rate-limited by other usage. |
| **DNS resolution** | Use `--socks5-hostname` to avoid local DNS leaks; misconfiguration can expose traffic outside the tunnel path. |

### Anonymity & traceability limitations

| Limitation | Details |
|---|---|
| **Anonymity ≠ invulnerability** | Tor reduces client-IP exposure but does not anonymize content, application identifiers, or usage patterns. |
| **Correlation & fingerprinting** | Timing, volume, style, headers, TLS/HTTP fingerprinting, and entry/exit traffic correlation can reduce anonymity. |
| **Application metadata** | Reused accounts, cookies, tokens, or client-side identifiers negate network-layer benefits. |
| **Visible egress point** | The gateway sees the exit IP (and any operator logs); traffic between exit and destination depends on TLS, but observation/termination at the service remains possible. |
| **Legal/compliance context** | Applicable laws and service terms remain in force regardless of transport. |

### Reliability & reproducibility

- **Non-deterministic outputs** (temperature, model versions, load): identical responses are not guaranteed.
- IP rotation ≠ guaranteed reset (NEWNYM delay, exit reuse, non-IP limits).
- Dependence on third-party, non-contractual infrastructure: service may be interrupted at any time.

### Model/prompt behavior

- The **system prompt** strongly influences behavior but does not guarantee absence of refusals/filtering if the gateway or model enforces its own policies.
- `reasoning_effort` (when supported) adjusts reasoning style/effort, not service availability.
- Actual capabilities depend on the model exposed behind the alias (context window, tools, multimodality, data freshness).

---

## Quick Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Connection refused` on `127.0.0.1:9050` | Tor not running / different SOCKS port |
| Timeout / very slow | Degraded Tor circuit or saturated exit; retry or renew circuit |
| `429` / rate limited | Wait, renew Tor identity, reduce request rate/size |
| `403` / blocked | Tor exit blacklisted; change circuit/IP |
| `404` on base `/v1` path | Expected if the correct route is `/chat/completions` (or another path) |
| Empty / JSON error response | Check `model`, `messages` schema, `max_tokens`, and parameter support |

---

## Quick Reference

- **Base URL (gateway v1):** `https://api.kilo.ai/api/gateway/v1`
- **Chat endpoint:** `POST /chat/completions`
- **Auth:** no key required (anonymous mode)
- **Recommended transport:** `curl --socks5-hostname 127.0.0.1:9050 ...`
- **Model (example):** `reflection/beam-free`
- **IP-quota relief lever:** Tor identity/circuit rotation

---

*Technical reference — observed/expected behavior of Kilo AI anonymous gateway access via Tor; subject to change.*
---

## Client

A zero-dependency Node.js client and CLI live in [`KiloAPI.js`](./KiloAPI.js) / [`src/`](./src/). It implements the keyless OpenAI-compatible chat contract and, because Node's `fetch` has no SOCKS support, ships a built-in SOCKS5/HTTP-CONNECT transport plus Tor control-port circuit renewal in [`/lib/proxy.js`](../../lib/proxy.js).

- **Gateway:** `POST /api/gateway/v1/chat/completions` (no API key), default model `reflection/beam-free`.
- **Proxy/Tor:** `--proxy socks5h://127.0.0.1:9050` or `--tor`; on 429/403 the client can `SIGNAL NEWNYM` and retry (`--retries`, control host/port/password/cookie configurable).
- **Streaming:** OpenAI-style SSE chunks and usage.
- **Offline tests:** mocked fetch + a fake in-process SOCKS5 server (`node --test AI/KiloAI/test/*.test.js`).

```bash
node AI/KiloAI/KiloAPI.js "Explain how you work" --stream
node AI/KiloAI/KiloAPI.js "Explain how you work" --tor --retries 2
node AI/KiloAI/KiloAPI.js --models --proxy socks5h://127.0.0.1:9050
```

```js
import { kiloChat, KiloClient } from "./AI/KiloAI/KiloAPI.js";

const res = await kiloChat({ prompt: "Hello", proxy: "socks5h://127.0.0.1:9050", tor: true, retries: 1 });
// res.meta.proxy / res.meta.torRotations record egress and circuit renewals

const client = new KiloClient({ proxy: "socks5h://127.0.0.1:9050", renewIdentity: myHook });
```
