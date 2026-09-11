// Per-host leaf certificates minted at runtime from the local CA (picker mode terminates
// claude.ai in addition to api.anthropic.com). Uses the system openssl like the installer;
// results are cached in <home>/certs/<host>.pem|key and reused across restarts.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

export class CertStore {
  private readonly home: string;
  private readonly contexts = new Map<string, tls.SecureContext>();

  constructor(home: string) {
    this.home = home;
  }

  /** Context for `host`; mints a leaf on first use. Throws if the CA key is missing. */
  contextFor(host: string): tls.SecureContext {
    const cached = this.contexts.get(host);
    if (cached) return cached;
    const { cert, key } = this.leafFor(host);
    const ctx = tls.createSecureContext({ cert, key });
    this.contexts.set(host, ctx);
    return ctx;
  }

  /** Register a pre-existing leaf (the installer's api.anthropic.com leaf). */
  register(host: string, certPem: Buffer, keyPem: Buffer): void {
    this.contexts.set(host, tls.createSecureContext({ cert: certPem, key: keyPem }));
  }

  has(host: string): boolean {
    return this.contexts.has(host);
  }

  private leafFor(host: string): { cert: Buffer; key: Buffer } {
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error(`refusing to mint a certificate for "${host}"`);
    const dir = path.join(this.home, "certs");
    const certFile = path.join(dir, `${host}.pem`);
    const keyFile = path.join(dir, `${host}.key`);
    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      const cert = fs.readFileSync(certFile);
      // re-mint when within 30 days of expiry
      const notAfter = execFileSync("openssl", ["x509", "-noout", "-enddate", "-in", certFile]).toString().replace("notAfter=", "").trim();
      if (Date.parse(notAfter) - Date.now() > 30 * 86400_000) return { cert, key: fs.readFileSync(keyFile) };
    }
    const caPem = path.join(this.home, "ca.pem");
    const caKey = path.join(this.home, "ca.key");
    if (!fs.existsSync(caKey)) throw new Error(`CA key missing (${caKey}); re-run the installer`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(dir, ".mint-"));
    try {
      const cnf = path.join(tmp, "leaf.cnf");
      fs.writeFileSync(
        cnf,
        ["[req]", "distinguished_name=dn", "req_extensions=v3_req", "prompt=no", "[dn]", `CN=${host}`, "[v3_req]", "basicConstraints=CA:FALSE", "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth", `subjectAltName=DNS:${host}`].join("\n"),
      );
      const csr = path.join(tmp, "leaf.csr");
      const run = (args: string[]): void => void execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
      run(["req", "-new", "-sha256", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", csr, "-config", cnf]);
      run(["x509", "-req", "-sha256", "-in", csr, "-CA", caPem, "-CAkey", caKey, "-CAcreateserial", "-out", certFile, "-days", "825", "-extfile", cnf, "-extensions", "v3_req"]);
      fs.chmodSync(keyFile, 0o600);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  }
}
