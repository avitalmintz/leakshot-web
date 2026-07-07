import { describe, it, expect } from "vitest";
import { scanLine, scanText, TIER_HIGH, TIER_MEDIUM } from "./detectors";

function types(line: string): string[] {
  return scanLine(line).map((f) => f.secretType);
}

function findByType(line: string, t: string) {
  return scanLine(line).find((f) => f.secretType === t);
}

describe("AWS access key", () => {
  it("detects a real-looking AWS key as HIGH", () => {
    const f = findByType("aws_access_key_id = AKIAZ3ROAPK7QWERTYUI", "aws_access_key");
    expect(f).toBeDefined();
    expect(f!.tier).toBe(TIER_HIGH);
  });

  it("does NOT flag the vendor example key AKIAIOSFODNN7EXAMPLE (allowlist)", () => {
    expect(types("AKIAIOSFODNN7EXAMPLE")).not.toContain("aws_access_key");
  });

  it("recovers a space-split AWS key via de-noising", () => {
    const f = findByType("AKIA Z3RO APK7 QWER TYUI", "aws_access_key");
    expect(f).toBeDefined();
    expect(f!.tier).toBe(TIER_HIGH);
  });
});

describe("JWT", () => {
  // header {"alg":"HS256","typ":"JWT"} . payload {"sub":"123","name":"a"} . sig
  const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const payload = "eyJzdWIiOiIxMjMiLCJuYW1lIjoiYSJ9";
  const validJwt = `${header}.${payload}.abcDEF123_-signature`;

  it("validates a real JWT as HIGH", () => {
    const f = findByType(`token=${validJwt}`, "jwt");
    expect(f).toBeDefined();
    expect(f!.tier).toBe(TIER_HIGH);
  });

  it("validates a garbled-but-recoverable JWT (OCR 1/l swap in header)", () => {
    // Simulate an OCR confusion inside the header segment: the '1' in the block
    // 'UzI1' is read as an 'l'. Base64url block repair should recover it (both
    // are valid base64url chars, so only decoding-and-scoring can disambiguate)
    // and the JWT should still validate.
    const swapped = header.replace("UzI1", "UzIl");
    expect(swapped).not.toBe(header);
    const garbled = `${swapped}.${payload}.sigsigsig`;
    const f = findByType(garbled, "jwt");
    expect(f).toBeDefined();
    expect(f!.tier).toBe(TIER_HIGH);
  });

  it("does NOT flag random a.b.c dotted base64", () => {
    // Three dotted base64url runs that start with eyJ but are not valid JSON.
    const junk = "eyJxxxxxx.eyJyyyyyy.zzzzzzzz";
    expect(types(junk)).not.toContain("jwt");
  });
});

describe("Credit card (Luhn)", () => {
  it("detects a Luhn-valid card 4242 4242 4242 4242", () => {
    const f = findByType("card: 4242 4242 4242 4242", "credit_card");
    expect(f).toBeDefined();
    expect(f!.tier).toBe(TIER_HIGH);
  });

  it("does NOT flag a non-Luhn 16-digit run", () => {
    // 1234 5678 9012 3456 is not Luhn-valid.
    expect(types("num 1234 5678 9012 3456")).not.toContain("credit_card");
  });
});

describe("SSN", () => {
  it("detects a valid SSN", () => {
    const f = findByType("SSN 123-45-6789", "ssn");
    expect(f).toBeDefined();
    expect(f!.tier).toBe(TIER_HIGH);
  });

  it("rejects invalid area 000", () => {
    expect(types("000-12-3456")).not.toContain("ssn");
  });
  it("rejects invalid area 666", () => {
    expect(types("666-12-3456")).not.toContain("ssn");
  });
  it("rejects invalid area 900+", () => {
    expect(types("900-12-3456")).not.toContain("ssn");
  });
});

describe("Context keyword (medium)", () => {
  it("flags DB_PASSWORD=S3cr3t! as MEDIUM", () => {
    const f = findByType("DB_PASSWORD=S3cr3t!", "context_secret");
    expect(f).toBeDefined();
    expect(f!.tier).toBe(TIER_MEDIUM);
  });

  it("does not double-flag a value already caught by a high detector", () => {
    // A stripe key after api_key= should be reported HIGH, not also medium.
    const line = "api_key=sk_live_abcdefghijklmnop1234";
    const found = scanLine(line);
    const stripe = found.filter((f) => f.secretType === "stripe_key");
    const ctx = found.filter((f) => f.secretType === "context_secret");
    expect(stripe.length).toBe(1);
    expect(ctx.length).toBe(0);
  });
});

describe("Other high patterns", () => {
  it("detects a Stripe live key", () => {
    expect(types("sk_live_abcdefghijklmnop1234")).toContain("stripe_key");
  });
  it("detects a GitHub token", () => {
    expect(types("ghp_" + "a".repeat(36))).toContain("github_token");
  });
  it("detects a Google API key", () => {
    expect(types("AIza" + "a".repeat(35))).toContain("google_api_key");
  });
  it("detects a Slack token", () => {
    expect(types("xoxb-" + "1234567890abc")).toContain("slack_token");
  });
  it("detects a private key header (dash tolerant)", () => {
    expect(types("-----BEGIN RSA PRIVATE KEY-----")).toContain("private_key");
  });
});

describe("scanText line indexing", () => {
  it("stamps line indices onto findings", () => {
    const lines = ["nothing here", "DB_PASSWORD=S3cr3t!"];
    const all = scanText(lines);
    const ctx = all.find((f) => f.secretType === "context_secret");
    expect(ctx).toBeDefined();
    expect(ctx!.lineIndex).toBe(1);
  });
});
