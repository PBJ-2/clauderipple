// Minimal X.509 issuance on node:crypto alone — no openssl binary, no npm dependency.
//
// Why hand-rolled: the product needs exactly two shapes, a self-signed CA and a serverAuth leaf,
// and Windows ships no openssl (macOS LibreSSL also forced -sha256 and RSA on us, see below). A
// general X.509 library would pull a dependency tree into a project that has none and whose app
// bundle ships source files, not node_modules. The public key comes out of node:crypto already
// DER-encoded (SPKI) and node:crypto does the signing, so what is left is a thin DER writer.
//
// RSA 2048 + SHA-256 on purpose, matching what the openssl path produced: Node's TLS client
// rejects EC keys written with explicit curve parameters, and SHA-1 signatures ("ca md too weak").
//
// Wrong output cannot pass silently: a malformed certificate fails the TLS handshake outright,
// and the tests cross-check every field against openssl.

import crypto from "node:crypto";

// ---- DER writing ------------------------------------------------------------------------

const TAG = {
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  BOOLEAN: 0x01,
  UTC_TIME: 0x17,
} as const;

/** DER length: short form below 128, else long form with a leading byte-count byte. */
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(value.length), value]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(TAG.SEQUENCE, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(TAG.SET, Buffer.concat(parts));
/** Context-specific constructed [n], used for the version and extensions wrappers. */
const explicit = (n: number, value: Buffer): Buffer => tlv(0xa0 | n, value);

/** DER INTEGER is signed: a leading byte >= 0x80 needs a 0x00 pad so it stays positive. */
function integer(value: number | Buffer): Buffer {
  let b = typeof value === "number" ? Buffer.from([value]) : value;
  while (b.length > 1 && b[0] === 0x00 && (b[1]! & 0x80) === 0) b = b.subarray(1);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(TAG.INTEGER, b);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part % 128];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v % 128) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

/** BIT STRING with the count of unused trailing bits as its first content byte. */
function bitString(bits: Buffer, unused = 0): Buffer {
  return tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([unused]), bits]));
}

/** UTCTime (YYMMDDHHMMSSZ). Valid until 2049; nothing we issue reaches that. */
function utcTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(TAG.UTC_TIME, Buffer.from(s, "ascii"));
}

const OID_CN = "2.5.4.3";
const OID_SHA256_RSA = "1.2.840.113549.1.1.11";

/** A Name with a single CN, written as UTF8String (what openssl's default string_mask emits). */
function nameWithCn(cn: string): Buffer {
  return seq(set(seq(oid(OID_CN), tlv(TAG.UTF8_STRING, Buffer.from(cn, "utf8")))));
}

const sha256WithRsa = (): Buffer => seq(oid(OID_SHA256_RSA), tlv(TAG.NULL, Buffer.alloc(0)));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  const parts = [oid(id)];
  if (critical) parts.push(tlv(TAG.BOOLEAN, Buffer.from([0xff])));
  parts.push(tlv(TAG.OCTET_STRING, value));
  return seq(...parts);
}

// ---- DER reading (only enough to lift a field out of an existing certificate) ------------

/** Range of the TLV starting at `offset`: where its value begins and where the whole TLV ends. */
function readTlv(buf: Buffer, offset: number): { tag: number; valueStart: number; end: number } {
  const tag = buf[offset]!;
  const first = buf[offset + 1]!;
  if (first < 0x80) return { tag, valueStart: offset + 2, end: offset + 2 + first };
  const n = first & 0x7f;
  let length = 0;
  for (let i = 0; i < n; i++) length = length * 256 + buf[offset + 2 + i]!;
  return { tag, valueStart: offset + 2 + n, end: offset + 2 + n + length };
}

/**
 * The subject Name of `certPem`, as the exact DER bytes it was written with.
 *
 * A leaf's issuer must be byte-identical to its CA's subject. Re-encoding "CN=…" from the string
 * form would risk a different string type (PrintableString vs UTF8String) and break chain
 * building against a CA we did not issue — including the one already trusted in the user's
 * keychain — so the bytes are copied rather than rebuilt.
 */
export function subjectDer(certPem: string): Buffer {
  const der = new crypto.X509Certificate(certPem).raw;
  const cert = readTlv(der, 0); // Certificate
  const tbs = readTlv(der, cert.valueStart); // TBSCertificate
  let p = tbs.valueStart;
  if (der[p] === 0xa0) p = readTlv(der, p).end; // [0] version, optional
  p = readTlv(der, p).end; // serialNumber
  p = readTlv(der, p).end; // signature
  p = readTlv(der, p).end; // issuer
  p = readTlv(der, p).end; // validity
  const subject = readTlv(der, p);
  return der.subarray(p, subject.end);
}

// ---- issuance ---------------------------------------------------------------------------

function pem(label: string, der: Buffer): string {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function newKeyPair(): { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/** Serial numbers must be positive and unpredictable; 16 random bytes with the top bit cleared. */
function serial(): Buffer {
  const b = crypto.randomBytes(16);
  b[0] = b[0]! & 0x7f;
  return b;
}

function signCert(tbs: Buffer, caKey: crypto.KeyObject): Buffer {
  const signature = crypto.sign("sha256", tbs, caKey);
  return seq(tbs, sha256WithRsa(), bitString(signature));
}

function validity(days: number): Buffer {
  const now = new Date();
  // Backdate an hour so a client whose clock is slightly behind ours still accepts a fresh cert.
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now.getTime() + days * 86_400_000);
  return seq(utcTime(notBefore), utcTime(notAfter));
}

function tbsCertificate(opts: {
  subject: Buffer;
  issuer: Buffer;
  spki: Buffer;
  days: number;
  extensions: Buffer[];
}): Buffer {
  return seq(
    explicit(0, integer(2)), // v3
    integer(serial()),
    sha256WithRsa(),
    opts.issuer,
    validity(opts.days),
    opts.subject,
    opts.spki,
    explicit(3, seq(...opts.extensions)),
  );
}

const basicConstraintsCa = (): Buffer =>
  extension("2.5.29.19", true, seq(tlv(TAG.BOOLEAN, Buffer.from([0xff])), integer(0)));
/** cA defaults to FALSE, so an end-entity constraint is an empty SEQUENCE. */
const basicConstraintsLeaf = (): Buffer => extension("2.5.29.19", true, seq());
/** keyCertSign (bit 5) + cRLSign (bit 6). */
const keyUsageCa = (): Buffer => extension("2.5.29.15", true, bitString(Buffer.from([0x06]), 1));
/** digitalSignature (bit 0) + keyEncipherment (bit 2). */
const keyUsageLeaf = (): Buffer => extension("2.5.29.15", true, bitString(Buffer.from([0xa0]), 5));
const extendedKeyUsageServer = (): Buffer => extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1")));

/** SHA-1 of the public key BIT STRING, per RFC 5280's first method. */
function subjectKeyIdentifier(spki: Buffer): Buffer {
  const outer = readTlv(spki, 0);
  let p = outer.valueStart;
  p = readTlv(spki, p).end; // algorithm
  const keyBits = readTlv(spki, p);
  const hash = crypto.createHash("sha1").update(spki.subarray(keyBits.valueStart + 1, keyBits.end)).digest();
  return extension("2.5.29.14", false, tlv(TAG.OCTET_STRING, hash));
}

/** dNSName is [2] IMPLICIT IA5String inside GeneralNames. */
function subjectAltName(hosts: string[]): Buffer {
  return extension("2.5.29.17", false, seq(...hosts.map((h) => tlv(0x82, Buffer.from(h, "ascii")))));
}

export type Issued = { certPem: string; keyPem: string };

function keyPem(key: crypto.KeyObject): string {
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

/** Self-signed CA. Not installed anywhere by this module; the caller decides what to trust it in. */
export function createCa(opts: { cn?: string; days?: number } = {}): Issued {
  const { publicKey, privateKey } = newKeyPair();
  const spki = publicKey.export({ format: "der", type: "spki" });
  const name = nameWithCn(opts.cn ?? "ClaudeRipple local CA");
  const tbs = tbsCertificate({
    subject: name,
    issuer: name,
    spki,
    days: opts.days ?? 3650,
    extensions: [basicConstraintsCa(), keyUsageCa(), subjectKeyIdentifier(spki)],
  });
  return { certPem: pem("CERTIFICATE", signCert(tbs, privateKey)), keyPem: keyPem(privateKey) };
}

/** serverAuth certificate for `host`, signed by an existing CA (ours or one already trusted). */
export function createLeaf(opts: { host: string; caCertPem: string; caKeyPem: string; days?: number }): Issued {
  const { publicKey, privateKey } = newKeyPair();
  const spki = publicKey.export({ format: "der", type: "spki" });
  const tbs = tbsCertificate({
    subject: nameWithCn(opts.host),
    issuer: subjectDer(opts.caCertPem),
    spki,
    days: opts.days ?? 825,
    extensions: [basicConstraintsLeaf(), keyUsageLeaf(), extendedKeyUsageServer(), subjectAltName([opts.host])],
  });
  const caKey = crypto.createPrivateKey(opts.caKeyPem);
  return { certPem: pem("CERTIFICATE", signCert(tbs, caKey)), keyPem: keyPem(privateKey) };
}
