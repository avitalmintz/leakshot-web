/** Partially mask a matched secret for display: keep a few edge chars. */
export function maskSecret(text: string): string {
  const t = text.trim();
  if (t.length <= 8) {
    return t[0] + "•".repeat(Math.max(1, t.length - 1));
  }
  const head = t.slice(0, 4);
  const tail = t.slice(-4);
  const middle = "•".repeat(Math.min(12, t.length - 8));
  return `${head}${middle}${tail}`;
}
