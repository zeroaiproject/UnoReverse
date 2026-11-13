# SSE Frame Parsing Notes — `/rest/sse/perplexity_ask`

## Transport
- Request: `POST` with JSON body, `Accept: text/event-stream`
- Response: chunked `text/event-stream`

## Frame format
Typical SSE:
```
event: message        (optional)
data: {"...":"..."}  (JSON per frame)

```
(blank line terminates event)

Some deployments emit only `data:` lines.

## Parsing strategy
1. Read stream incrementally (line-buffered).
2. For each `data:` line, parse JSON; ignore keep-alives/empty payloads.
3. Maintain a reducer over state keys seen across frames:
   - **progress/status**: phase transitions (search → read → write)
   - **search_results/sources**: citation list; may arrive before/during text
   - **text/answer/delta**: incremental answer content; may be plain text, markdown, or a JSON-encoded string field depending on schema version
   - **final/last**: indicates stream completion
4. Deduplicate sources by URL/id; prefer latest complete text snapshot if provided.

## Robustness tips
- Treat unknown fields as opaque/pass-through (schema is versioned, e.g. `version` in request).
- Handle reconnects/idempotency via client-generated UUIDs if retrying.
- Capture raw frames during RE to detect format shifts (`send_back_text_in_streaming_api`, `use_schematized_api` flags influence shape).

## Validation checklist
- Compare captured browser frames vs reproduced request.
- Confirm citation objects: `name/title`, `url`, `snippet`, `date` (field names vary).
- Verify final frame contains complete answer and resolved `backend_uuid`/thread linkage.
