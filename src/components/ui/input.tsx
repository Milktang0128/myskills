import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

// Square corners, hairline border, near-white paper fill. Focus collapses
// the rule to ink. No shadow — separation in this design is borders, not
// elevation.
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-8 w-full border border-rule bg-paper-white px-2.5 py-1 text-[12.5px] text-ink transition-colors',
        'placeholder:text-mute focus-visible:outline-none focus-visible:border-ink',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
