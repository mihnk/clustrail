import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { backend } from "@/backend/client";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** Records an interface error in Clustrail's log (desktop app only; nothing leaves the machine). */
export function logClientError(message: string, detail: string) {
  void backend?.logClientError(message, detail).catch(() => {});
}

type Props = { children: ReactNode; label: string; whole?: boolean };
type State = { error: Error | null; attempt: number };

/**
 * Keeps an error in one view inside that view: the other tabs keep working,
 * and this one offers a reload. `whole` covers the entire window (start-up).
 */
export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logClientError(`${this.props.label}: ${error.message}`, `${error.stack ?? ""}\n${info.componentStack ?? ""}`);
  }

  render() {
    const { error, attempt } = this.state;
    if (!error) return <ViewKey key={attempt}>{this.props.children}</ViewKey>;
    const text = `${error.name}: ${error.message}`;
    return (
      <EmptyState
        className={this.props.whole ? "h-full" : "flex-1"}
        icon={<TriangleAlert />}
        title={this.props.whole ? t("Clustrail could not start") : t("This view stopped working")}
        action={
          <span className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => (this.props.whole ? location.reload() : this.setState({ error: null, attempt: attempt + 1 }))}
            >
              {this.props.whole ? t("Reload") : t("Reload view")}
            </Button>
            <Button onClick={() => void navigator.clipboard?.writeText(`${text}\n${error.stack ?? ""}`)}>{t("Copy error")}</Button>
          </span>
        }
      >
        <span className="flex flex-col items-center gap-2">
          <span>{this.props.whole ? t("The error is in Clustrail's log.") : t("The other tabs keep working. The error is in Clustrail's log.")}</span>
          <code className="selectable max-w-[640px] break-words font-mono text-meta text-fg-muted">{text}</code>
        </span>
      </EmptyState>
    );
  }
}

/** Remounts the view on "Reload view" (a new key), so it starts from fresh state. */
function ViewKey({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
