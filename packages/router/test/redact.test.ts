import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialHeaderValues, redactErrorText, redactHeaders } from "../src/redact.ts";

test("redacts configured opaque credentials, bearer tokens, JWTs, and credential headers", () => {
  const opaque = "vendor_credential_with_an_unusual_format";
  const secrets = credentialHeaderValues([
    ["x-api-key", opaque],
    ["authorization", "Bearer access-token-which-must-not-appear"],
    ["x-request-id", "safe-request-id"],
  ]);
  const text = redactErrorText(`rejected ${opaque}; Bearer access-token-which-must-not-appear; eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature` , secrets);
  assert.doesNotMatch(text, /vendor_credential|access-token|eyJhbGci/);
  assert.match(text, /\[REDACTED\]/);
  assert.deepEqual(redactHeaders({ "set-cookie": "session=secret", "x-api-key": opaque, "x-request-id": "safe-request-id" }), {
    "set-cookie": "[REDACTED]",
    "x-api-key": "[REDACTED]",
    "x-request-id": "safe-request-id",
  });
});
