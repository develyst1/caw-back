// Keep secrets out of what the runner stores and prints (security review F8). A blocked command is quoted in the hop's note — which the
// API stores and the screen shows — and in the log; a command like `git push https://user:token@host` must not carry its secret there.
// Best-effort by pattern: it covers URL credentials, `token=` / `key=` / `secret=` / `password=` forms, and Bearer headers.
export function redact(text: string): string {
  return text
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1***@")
    .replace(/\b((?:[A-Za-z0-9]+[_-])*(?:token|secret|password|passwd|pwd|api[_-]?key|key)|auth(?:orization)?)=[^\s&'"]+/gi, "$1=***")
    .replace(/\b(Bearer)\s+[^\s'"]+/gi, "$1 ***");
}
