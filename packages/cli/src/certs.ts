// Generate the local CA and the api.anthropic.com leaf certificate. Pure node:crypto (see
// ../../router/src/x509.ts) so this works wherever Node runs, including Windows, which ships no
// openssl. Nothing is installed in any trust store; the CA is handed to Node only, through
// NODE_EXTRA_CA_CERTS (picker mode additionally trusts it in the login keychain).

import fs from "node:fs";
import path from "node:path";
import { createCa, createLeaf } from "../../router/src/x509.ts";

export type CertPaths = { caPem: string; caKey: string; leafPem: string; leafKey: string };

export function certPaths(home: string): CertPaths {
  return {
    caPem: path.join(home, "ca.pem"),
    caKey: path.join(home, "ca.key"),
    leafPem: path.join(home, "leaf.pem"),
    leafKey: path.join(home, "leaf.key"),
  };
}

export function generateCerts(home: string, upstream = "api.anthropic.com", days = 3650): CertPaths {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const p = certPaths(home);
  const ca = createCa({ days });
  fs.writeFileSync(p.caPem, ca.certPem);
  fs.writeFileSync(p.caKey, ca.keyPem, { mode: 0o600 });
  const leaf = createLeaf({ host: upstream, caCertPem: ca.certPem, caKeyPem: ca.keyPem, days: Math.min(days, 825) });
  fs.writeFileSync(p.leafPem, leaf.certPem);
  fs.writeFileSync(p.leafKey, leaf.keyPem, { mode: 0o600 });
  // Pre-existing installs were written before the mode argument; make sure the keys are private.
  for (const f of [p.caKey, p.leafKey]) fs.chmodSync(f, 0o600);
  return p;
}

export function certsExist(home: string): boolean {
  const p = certPaths(home);
  return [p.caPem, p.caKey, p.leafPem, p.leafKey].every((f) => fs.existsSync(f));
}
