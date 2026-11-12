'use client';

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Small shadcn/ui-style primitives, written for this project.
 * Composition over configuration: each is a styled element that forwards refs
 * and accepts className, so pages can adjust without new variants.
 */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap',
  {
    variants: {
      variant: {
        primary: 'bg-sierra-700 text-white hover:bg-sierra-800 active:bg-sierra-900',
        secondary: 'bg-surface-muted text-[var(--text)] border border-default hover:bg-sierra-50 dark:hover:bg-sierra-900',
        ghost: 'text-[var(--text)] hover:bg-surface-muted',
        danger: 'bg-red-600 text-white hover:bg-red-700',
        gold: 'bg-gold-500 text-sierra-900 hover:bg-gold-600 font-semibold',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
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
      className={cn('bg-surface border border-default rounded-xl shadow-sm', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pt-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('font-semibold text-base leading-tight', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-default bg-surface px-3 text-sm',
        'placeholder:text-[var(--text-muted)] disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-lg border border-default bg-surface px-3 py-2 text-sm resize-none',
        'placeholder:text-[var(--text-muted)] disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-muted border-default text-muted',
        success: 'bg-sierra-50 border-sierra-200 text-sierra-800 dark:bg-sierra-900 dark:text-sierra-100',
        warning: 'bg-gold-100 border-gold-300 text-gold-700',
        danger: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950 dark:text-red-200',
        info: 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950 dark:text-blue-200',
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
    info: 'bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-950/50 dark:border-blue-900 dark:text-blue-100',
    warning: 'bg-gold-100 border-gold-300 text-gold-700',
    danger: 'bg-red-50 border-red-200 text-red-900 dark:bg-red-950/50 dark:border-red-900 dark:text-red-100',
    success: 'bg-sierra-50 border-sierra-200 text-sierra-900 dark:bg-sierra-900/50 dark:border-sierra-700 dark:text-sierra-50',
  };
  return (
    <div role="status" className={cn('rounded-lg border px-4 py-3 text-sm', tones[tone], className)}>
      {title && <p className="font-semibold mb-1">{title}</p>}
      {children}
    </div>
  );
}
