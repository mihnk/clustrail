import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "focus-ring no-drag inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border font-medium leading-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-line-strong bg-surface-elevated text-fg hover:bg-surface-hover",
        ghost: "border-transparent bg-transparent text-fg-secondary hover:bg-surface-hover hover:text-fg",
        primary: "border-accent bg-accent text-accent-ink hover:brightness-110",
        danger: "border-status-critical-strong bg-status-critical-strong text-white hover:brightness-110",
        /** A mutation blocked by a protected context. Stays focusable; opens the unlock flow. */
        locked: "cursor-not-allowed border-dashed border-line-strong bg-transparent text-fg-muted",
      },
      size: {
        md: "h-7 px-2.5 text-cell",
        lg: "h-8 px-3.5 text-body",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Icon-only buttons must be labelled. */
  "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "focus-ring no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-transparent p-0 text-fg-secondary hover:bg-surface-hover hover:text-fg [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
});
