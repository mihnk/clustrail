// A tiny line-editing shell used while there is no backend. The desktop
// build replaces it with a pods/exec stream from the Go backend (SPDY or
// WebSocket via client-go remotecommand); xterm.js talks to either the same way.

const FILES: Record<string, string> = {
  "/sys/fs/cgroup/memory.max": "268435456",
  "/sys/fs/cgroup/memory.current": "241172480",
  "/sys/fs/cgroup/memory.events": "low 0\r\nhigh 0\r\nmax 1873\r\noom 0\r\noom_kill 0",
  "/etc/hostname": "checkout-api-7d9f8b6c4-9rkzd",
};

const ENV: Record<string, string> = {
  JAVA_TOOL_OPTIONS: "-Xmx384m -XX:+UseG1GC",
  HOME: "/app",
  HOSTNAME: "checkout-api-7d9f8b6c4-9rkzd",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};

export const SCROLLBACK = [
  "\x1b[36m/app $\x1b[0m cat /sys/fs/cgroup/memory.max",
  "268435456",
  "\x1b[36m/app $\x1b[0m cat /sys/fs/cgroup/memory.current",
  "241172480",
  "\x1b[36m/app $\x1b[0m grep -E 'max|oom' /sys/fs/cgroup/memory.events",
  "max 1873",
  "oom 0",
  "oom_kill 0",
  "\x1b[36m/app $\x1b[0m echo $JAVA_TOOL_OPTIONS",
  "-Xmx384m -XX:+UseG1GC",
  "\x1b[36m/app $\x1b[0m jcmd 1 GC.heap_info | head -3",
  "1:",
  " garbage-first heap   total 393216K, used 301460K",
  "  region size 1024K, 142 young (145408K), 9 survivors",
  "\x1b[36m/app $\x1b[0m ps -o pid,rss,args",
  "\x1b[2mPID   RSS  COMMAND\x1b[0m",
  "    1 229m java -Xmx384m -XX:+UseG1GC -jar /app/checkout-api.jar",
  "   87 1.2m /bin/sh",
  "  104 0.9m ps -o pid,rss,args",
].join("\r\n");

export class MockShell {
  private line = "";
  private history: string[] = [];
  private historyPos = 0;

  constructor(
    private readonly write: (data: string) => void,
    private readonly cwd: string,
    private readonly onExit: (code: number) => void,
  ) {}

  prompt() {
    this.write(`\r\n\x1b[36m${this.cwd} $\x1b[0m `);
  }

  /** Bytes typed into the terminal (xterm onData). */
  input(data: string) {
    for (const ch of data) {
      if (ch === "\r") {
        const cmd = this.line.trim();
        this.line = "";
        if (cmd) this.history.push(cmd);
        this.historyPos = this.history.length;
        this.run(cmd);
      } else if (ch === "\x7f") {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.write("\b \b");
        }
      } else if (ch === "\x03") {
        this.line = "";
        this.write("^C");
        this.prompt();
      } else if (ch === "\x0c") {
        this.write("\x1b[2J\x1b[H");
        this.write(`\x1b[36m${this.cwd} $\x1b[0m ${this.line}`);
      } else if (ch >= " " && ch !== "\x1b") {
        this.line += ch;
        this.write(ch);
      }
    }
    if (data === "\x1b[A" && this.history.length) this.recall(-1);
    if (data === "\x1b[B" && this.history.length) this.recall(1);
  }

  private recall(delta: number) {
    this.historyPos = Math.max(0, Math.min(this.history.length, this.historyPos + delta));
    const next = this.history[this.historyPos] ?? "";
    this.write("\b \b".repeat(this.line.length) + next);
    this.line = next;
  }

  private run(cmd: string) {
    const out = (s: string) => this.write(`\r\n${s.replace(/\n/g, "\r\n")}`);
    const [name = "", ...args] = cmd.split(/\s+/);
    switch (name) {
      case "":
        break;
      case "exit":
        this.write("\r\nexit");
        this.onExit(0);
        return;
      case "cat":
        for (const a of args) out(FILES[a] ?? `cat: can't open '${a}': No such file or directory`);
        break;
      case "echo":
        out(args.map((a) => (a.startsWith("$") ? (ENV[a.slice(1)] ?? "") : a)).join(" "));
        break;
      case "env":
        out(Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join("\n"));
        break;
      case "pwd":
        out(this.cwd);
        break;
      case "whoami":
        out("app");
        break;
      case "id":
        out("uid=1000(app) gid=1000(app) groups=1000(app)");
        break;
      case "hostname":
        out(FILES["/etc/hostname"]!);
        break;
      case "ls":
        out("checkout-api.jar  config  lib  logs");
        break;
      case "ps":
        out("PID   RSS  COMMAND\n    1 229m java -Xmx384m -XX:+UseG1GC -jar /app/checkout-api.jar\n   87 1.2m /bin/sh\n  131 0.9m ps -o pid,rss,args");
        break;
      case "clear":
        this.write("\x1b[2J\x1b[H");
        this.write(`\x1b[36m${this.cwd} $\x1b[0m `);
        return;
      case "help":
        out("This is a mock shell (no backend yet). Try: cat /sys/fs/cgroup/memory.max, ps, env, echo $JAVA_TOOL_OPTIONS, exit");
        break;
      default:
        out(`sh: ${name}: not found`);
    }
    this.prompt();
  }
}
