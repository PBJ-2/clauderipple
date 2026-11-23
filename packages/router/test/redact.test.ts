import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialHeaderValues, redactErrorText, redactHeaders, redactTokenLike } from "../src/redact.ts";

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

test("redactTokenLike keeps the diagnostic but drops the quoted excerpt it borrowed from a credential", () => {
  // Node 24's JSON.parse quotes a short excerpt around the fault. The fragment there can be a
  // credential piece too short for the 24-character run rule, so the excerpt goes whole.
  const messages = [
    `Unexpected token 'a', ..."ANTHROPIC_AUTH_TOKEN": abcd1234ef"... is not valid JSON`,
    `Unexpected token ''', ..."ANTHROPIC_AUTH_TOKEN": 'sk-ant-x1"... is not valid JSON`,
    `Unexpected token 'a', "{"env": {"A"... is not valid JSON`,
  ];
  for (const message of messages) {
    const out = redactTokenLike(message);
    assert.doesNotMatch(out, /abcd1234ef|sk-ant-x1|H_TOKEN|"env"/, out);
    assert.match(out, /^Unexpected token '.{0,3}' is not valid JSON$/, out);
  }
  // An all-capitals constant is an error code, not a credential, and survives the masking.
  assert.equal(redactTokenLike("certutil failed: SEC_ERROR_PKCS11_DEVICE_ERROR"), "certutil failed: SEC_ERROR_PKCS11_DEVICE_ERROR");
  // A long token-shaped run is still masked, and the position form the diagnostic may carry stays.
  assert.equal(redactTokenLike("A1b2C3d4E5f6G7h8I9j0K1l2M3n4"), "[REDACTED]");
  assert.equal(
    redactTokenLike("Unexpected token 'x', ...\"AUTH_TOKEN\": abcd1234ef\"... at position 12 (line 1 column 13) is not valid JSON"),
    "Unexpected token 'x' at position 12 (line 1 column 13) is not valid JSON",
  );
});
