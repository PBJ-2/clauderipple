// Per-host leaf certificates minted at runtime from the local CA (picker mode terminates
// claude.ai in addition to api.anthropic.com). Pure node:crypto like the installer, so no
// openssl binary is needed; results are cached in <home>/certs/<host>.pem|key and reused
// across restarts.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { createLeaf } from "./x509.ts";

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
      try {
        const notAfter = new crypto.X509Certificate(cert).validTo;
        if (Date.parse(notAfter) - Date.now() > 30 * 86400_000) return { cert, key: fs.readFileSync(keyFile) };
      } catch {
        /* unparseable cache entry: fall through and mint a fresh one */
      }
    }
    const caPem = path.join(this.home, "ca.pem");
    const caKey = path.join(this.home, "ca.key");
    if (!fs.existsSync(caKey)) throw new Error(`CA key missing (${caKey}); re-run the installer`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const leaf = createLeaf({
      host,
      caCertPem: fs.readFileSync(caPem, "utf8"),
      caKeyPem: fs.readFileSync(caKey, "utf8"),
    });
    fs.writeFileSync(certFile, leaf.certPem);
    fs.writeFileSync(keyFile, leaf.keyPem, { mode: 0o600 });
    return { cert: Buffer.from(leaf.certPem), key: Buffer.from(leaf.keyPem) };
  }
}
