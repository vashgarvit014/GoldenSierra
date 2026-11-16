'use client';

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Small shadcn/ui-style primitives, written for this project.
 * Composition over configuration: each is a styled element that forwards refs
 * and accepts className, so pages can adjust without new variants.
 *
 * Every colour here is a semantic token from globals.css. The shapes follow
 * goldensierra.com: pill buttons with a 2px border, flat 16px cards, 4px
 * inputs and tags.
 */

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill border-2 font-bold',
    'transition-colors duration-150 ease-in-out',
    'disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        // The site's call to action: gold fill, charcoal border and label.
        primary:
          'border-foreground bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
        // Its secondary: a light fill inside the same charcoal border.
        secondary:
          'border-foreground bg-surface text-foreground hover:bg-muted active:bg-muted-hover',
        // Its outline: tobacco border and label, for quieter choices.
        outline:
          'border-accent bg-transparent text-accent hover:bg-accent-soft hover:text-accent-hover active:text-accent-active',
        ghost:
          'border-transparent bg-transparent text-foreground hover:bg-muted active:bg-muted-hover',
        danger:
          'border-destructive bg-destructive text-destructive-foreground hover:border-destructive-hover hover:bg-destructive-hover',
        // Kept for existing call sites; identical to `primary`.
        gold:
          'border-foreground bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
      },
      size: {
        sm: 'h-8 px-3.5 text-xs',
        md: 'h-10 px-4.5 text-sm',
        lg: 'h-12 px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-card border border-border bg-surface text-surface-foreground', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pt-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-base font-bold leading-tight', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />;
}

const fieldBase = [
  'w-full rounded-control border border-input bg-surface px-3 text-sm text-foreground',
  'placeholder:text-muted-foreground',
  'transition-colors duration-150 ease-in-out focus-visible:border-foreground',
  'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
];

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(fieldBase, 'h-10', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldBase, 'resize-none py-2', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-control border px-1.5 py-0.5 text-xs font-semibold leading-tight',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        // Something noted or chosen — the brand's warm tint, not a status.
        accent: 'border-border bg-accent-soft text-accent',
        success: 'border-success-border bg-success-soft text-success-strong',
        warning: 'border-warning-border bg-warning-soft text-warning-strong',
        danger: 'border-destructive-border bg-destructive-soft text-destructive-strong',
        info: 'border-info-border bg-info-soft text-info-strong',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin h-4 w-4', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    info: 'border-info-border bg-info-soft text-info-strong',
    warning: 'border-warning-border bg-warning-soft text-warning-strong',
    danger: 'border-destructive-border bg-destructive-soft text-destructive-strong',
    success: 'border-success-border bg-success-soft text-success-strong',
  };
  return (
    <div role="status" className={cn('rounded-panel border px-4 py-3 text-sm', tones[tone], className)}>
      {title && <p className="mb-1 font-bold">{title}</p>}
      {children}
    </div>
  );
}

/**
 * The Golden Sierra logo. `onInk` is the official artwork (white wordmark) for
 * charcoal surfaces; the default is the same artwork with a charcoal wordmark
 * for light ones. Sized by height so the 168:47 ratio is never distorted.
 */
export function Logo({ onInk = false, className }: { onInk?: boolean; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a 4KB static SVG; next/image adds nothing
    <img
      src={onInk ? '/brand/golden-sierra-logo.svg' : '/brand/golden-sierra-logo-dark.svg'}
      alt="Golden Sierra Job Training Agency"
      width={168}
      height={47}
      className={cn('h-9 w-auto', className)}
    />
  );
}
