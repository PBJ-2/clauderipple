import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteProxyRequest } from "../src/proxy.ts";

test("rewrites Remote Control HTTPS absolute-form registration", () => {
  const parsed = absoluteProxyRequest(Buffer.from(
    "POST https://api.anthropic.com/v1/environments/bridge?source=cli HTTP/1.1\r\n" +
      "Host: wrong.example\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: secret\r\nAuthorization: Bearer retained\r\nContent-Length: 2",
    "latin1",
  ));
  assert.ok(parsed);
  assert.equal(parsed.host, "api.anthropic.com");
  assert.equal(parsed.port, 443);
  const head = parsed.head.toString("latin1");
  assert.match(head, /^POST \/v1\/environments\/bridge\?source=cli HTTP\/1\.1\r\n/);
  assert.match(head, /\r\nHost: api\.anthropic\.com\r\n/);
  assert.match(head, /Authorization: Bearer retained/);
  assert.doesNotMatch(head, /Proxy-(?:Connection|Authorization)/i);
  assert.doesNotMatch(head, /wrong\.example/);
});

test("accepts explicit HTTPS ports and rejects unsafe or non-HTTPS targets", () => {
  const explicit = absoluteProxyRequest(Buffer.from("GET https://example.com:8443/x HTTP/1.1\r\nHost: example.com"));
  assert.equal(explicit?.port, 8443);
  assert.equal(explicit?.host, "example.com");
  assert.equal(absoluteProxyRequest(Buffer.from("GET http://example.com/x HTTP/1.1\r\nHost: example.com")), null);
  assert.equal(absoluteProxyRequest(Buffer.from("GET https://user:pass@example.com/x HTTP/1.1\r\nHost: example.com")), null);
  assert.equal(absoluteProxyRequest(Buffer.from("BROKEN\r\nHost: example.com")), null);
});
