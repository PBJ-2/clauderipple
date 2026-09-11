// Generate the local CA and the api.anthropic.com leaf certificate with the system
// openssl binary (present on macOS and Linux). Nothing is installed in any trust
// store; the CA is handed to Node only, through NODE_EXTRA_CA_CERTS.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type CertPaths = { caPem: string; caKey: string; leafPem: string; leafKey: string };

export function certPaths(home: string): CertPaths {
  return {
    caPem: path.join(home, "ca.pem"),
    caKey: path.join(home, "ca.key"),
    leafPem: path.join(home, "leaf.pem"),
    leafKey: path.join(home, "leaf.key"),
  };
}

function openssl(args: string[]): void {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

export function generateCerts(home: string, upstream = "api.anthropic.com", days = 3650): CertPaths {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const p = certPaths(home);
  const tmp = fs.mkdtempSync(path.join(home, ".certgen-"));
  try {
    const caCnf = path.join(tmp, "ca.cnf");
    fs.writeFileSync(
      caCnf,
      [
        "[req]", "distinguished_name=dn", "x509_extensions=v3_ca", "prompt=no",
        "[dn]", "CN=ClaudeRipple local CA",
        "[v3_ca]", "basicConstraints=critical,CA:TRUE,pathlen:0", "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash",
      ].join("\n"),
    );
    // RSA 2048 on purpose: macOS LibreSSL writes EC keys with explicit curve parameters, which Node's
    // TLS client rejects ("Certificate public key has explicit ECC parameters"). -sha256 explicitly:
    // LibreSSL defaults to SHA-1 for `x509 -req`, which Node rejects ("ca md too weak").
    openssl(["req", "-x509", "-sha256", "-newkey", "rsa:2048", "-nodes", "-keyout", p.caKey, "-out", p.caPem, "-days", String(days), "-config", caCnf]);

    const leafCnf = path.join(tmp, "leaf.cnf");
    fs.writeFileSync(
      leafCnf,
      [
        "[req]", "distinguished_name=dn", "req_extensions=v3_req", "prompt=no",
        "[dn]", `CN=${upstream}`,
        "[v3_req]", "basicConstraints=CA:FALSE", "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth", `subjectAltName=DNS:${upstream}`,
      ].join("\n"),
    );
    const csr = path.join(tmp, "leaf.csr");
    openssl(["req", "-new", "-sha256", "-newkey", "rsa:2048", "-nodes", "-keyout", p.leafKey, "-out", csr, "-config", leafCnf]);
    openssl(["x509", "-req", "-sha256", "-in", csr, "-CA", p.caPem, "-CAkey", p.caKey, "-CAcreateserial", "-out", p.leafPem, "-days", String(Math.min(days, 825)), "-extfile", leafCnf, "-extensions", "v3_req"]);
    for (const f of [p.caKey, p.leafKey]) fs.chmodSync(f, 0o600);
    try {
      fs.unlinkSync(path.join(home, "ca.srl"));
    } catch {
      /* openssl may not have created it */
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return p;
}

export function certsExist(home: string): boolean {
  const p = certPaths(home);
  return [p.caPem, p.caKey, p.leafPem, p.leafKey].every((f) => fs.existsSync(f));
}
