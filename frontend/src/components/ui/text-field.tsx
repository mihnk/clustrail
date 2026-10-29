import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: ReactNode;
  /** Shown below the field in the critical color; marks the field invalid. */
  error?: string;
  /** Icon or adornment inside the field, before the input. */
  leading?: ReactNode;
  /** Adornment after the input (match check, shortcut hint). */
  trailing?: ReactNode;
  mono?: boolean;
  size?: "md" | "lg";
}

/** Labelled text input with focus ring and error state. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, leading, trailing, mono, size = "md", className, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  return (
    <div className={cn("flex flex-col gap-[5px]", className)}>
      {label && (
        <label htmlFor={inputId} className="text-ui text-fg-secondary">
          {label}
        </label>
      )}
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-app text-fg-muted",
          "focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]",
          size === "lg" ? "h-[34px] gap-2 px-2.5" : "h-7 px-2",
          error && "border-status-critical focus-within:border-status-critical",
        )}
      >
        {leading}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          spellCheck={false}
          className={cn(
            "min-w-0 flex-1 border-0 bg-transparent text-fg outline-none placeholder:text-fg-muted",
            mono ? "font-mono" : "",
            size === "lg" ? (mono ? "text-body font-medium" : "text-body") : "text-cell",
          )}
          {...props}
        />
        {trailing}
      </div>
      {error && (
        <span id={errorId} className="text-meta text-status-critical">
          {error}
        </span>
      )}
    </div>
  );
});
