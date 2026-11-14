/** Shared test helpers: synthetic fetch responses and recorded calls. */

export function textResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: init.headers ?? {},
  });
}

/** A Response whose body streams `chunks`; optionally errors mid-stream. */
export function streamResponse(chunks, { status = 200, headers = {}, failAt = null, stallAt = null } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (stallAt != null && index === stallAt) return new Promise(() => {}); // never settles
      if (failAt != null && index === failAt) {
        controller.error(new Error("socket hang up"));
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
  return new Response(body, { status, headers });
}

export function hangUntilAborted(_url, init = {}) {
  return new Promise((_resolve, reject) => {
    const signal = init.signal;
    const fail = () => reject(signal && signal.reason ? signal.reason : Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (!signal) return;
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail, { once: true });
  });
}

/**
 * Mock fetch from a handler `(url, init, callIndex) => Response|Promise<Response>`.
 * Records every call for assertions.
 */
export function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: init.headers || {} });
    return handler(String(url), init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

export const CONVERSATION = "09cc2f976f305994544a43e9f83b649a8e02";

export function searchPageHtml(conversation = CONVERSATION) {
  return `<html><body><div class="answer" data-conversation="${conversation}">Answer with AI</div></body></html>`;
}

export const PONG_STREAM = [
  '{"type":"text_start"}\n',
  '{"type":"text_delta","delta":"*"}\n',
  '{"type":"text_delta","delta":"*PONG**"}\n',
  '{"type":"text_stop","text":"**PONG**"}\n',
  '{"type":"usage","prompt_tokens":11177,"completion_tokens":4,"reasoning_tokens":0}\n',
  '{"type":"followups","followups":[]}\n',
  '{"type":"enrichments","enrichments":{"raw_response":"**PONG**","references":[{"url":"https://example.com/a","title":"A"}],"urls":["https://example.com/a","https://example.com/b"],"reference_urls":[],"images":[],"qa":[],"entities":[],"main_entity":null,"main_entity_infobox":null,"predicate":null,"context":[],"context_urls":[],"context_results":[]}}\n',
];
