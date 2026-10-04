import { describe, expect, it } from "vitest";
import { describeScanError } from "./scan/engine";
import { CERTIFICATE_HELP, isCertificateError } from "./tls-errors";

describe("certificate errors", () => {
  it("recognises certificate codes and nothing else", () => {
    for (const c of ["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) expect(isCertificateError(c), c).toBe(true);
    for (const c of ["ENOTFOUND", "ECONNREFUSED", "", undefined, null, 42, {}]) expect(isCertificateError(c), String(c)).toBe(false);
  });

  it("explains the likely cause without telling anyone to skip verification", () => {
    expect(CERTIFICATE_HELP).toMatch(/antivirus/i);
    expect(CERTIFICATE_HELP).toMatch(/993/);
    expect(CERTIFICATE_HELP).not.toMatch(/reject_?unauthorized|NODE_TLS/i);
  });

  it("a scan that fails on a certificate says so instead of 'try again'", () => {
    expect(describeScanError(Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }))).toBe(CERTIFICATE_HELP);
    expect(describeScanError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toMatch(/Couldn't reach the mail server/);
  });
});
