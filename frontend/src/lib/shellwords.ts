// Splitting and quoting command lines the way a POSIX shell does, for
// commands typed into a field that become argv (no expansion, no globbing).

/** Splits on unquoted whitespace; '…' is literal, "…" and \ escape. Returns an error for an open quote. */
export function splitArgs(line: string): string[] | { error: string } {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return { error: quote === "'" ? "unterminated ' quote" : 'unterminated " quote' };
  if (started) out.push(cur);
  return out;
}

/** Quotes an argument for display in a shell command, only when it needs it. */
export function quoteArg(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
