import { describe, expect, it } from "vitest";
import { quoteArg, splitArgs } from "./shellwords";

describe("splitArgs", () => {
  it("splits on unquoted whitespace like a POSIX shell", () => {
    expect(splitArgs("  ls   -la\t/tmp ")).toEqual(["ls", "-la", "/tmp"]);
    expect(splitArgs("")).toEqual([]);
  });

  it("keeps single quotes literal and lets double quotes and backslashes escape", () => {
    expect(splitArgs(`echo 'a "b" \\c'`)).toEqual(["echo", `a "b" \\c`]);
    expect(splitArgs(`echo "a \\"b\\" \\$HOME \\n"`)).toEqual(["echo", `a "b" $HOME \\n`]);
    expect(splitArgs(`a\\ b c`)).toEqual(["a b", "c"]);
  });

  it("keeps empty quoted arguments", () => {
    expect(splitArgs(`x '' ""`)).toEqual(["x", "", ""]);
  });

  it("reports an open quote instead of guessing", () => {
    expect(splitArgs(`echo 'open`)).toEqual({ error: "unterminated ' quote" });
    expect(splitArgs(`echo "open`)).toEqual({ error: 'unterminated " quote' });
  });
});

describe("quoteArg", () => {
  it("leaves plain words alone and quotes the rest", () => {
    expect(quoteArg("kubectl")).toBe("kubectl");
    expect(quoteArg("a=b,c:d/e.f")).toBe("a=b,c:d/e.f");
    expect(quoteArg("")).toBe("''");
    expect(quoteArg("it's here")).toBe(`'it'\\''s here'`);
  });

  // The debug command shown to the user must split back into exactly the argv that runs.
  it("round-trips through splitArgs for any argv", () => {
    const alphabet = ["a", "Z", "0", " ", "\t", "'", '"', "\\", "$", "`", "*", "=", "-", "\n", "ü", "🙂", ";", "|"];
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let run = 0; run < 2000; run++) {
      const argv = Array.from({ length: 1 + rand(5) }, () => Array.from({ length: rand(8) }, () => alphabet[rand(alphabet.length)]!).join(""));
      expect(splitArgs(argv.map(quoteArg).join(" ")), JSON.stringify(argv)).toEqual(argv);
    }
  });
});
