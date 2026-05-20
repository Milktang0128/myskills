import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Button — adapted for the paper × ink design.
 *
 * Sharp corners (no radius), mono uppercase labels, hairline borders. The
 * brand's "vermillion red" is reserved for primary-hover and destructive
 * — never the default rest state, so it stays a meaningful signal.
 *
 * Variants:
 *   - default: ink button on paper; hover slides to red (matches the
 *     prototype's "ink → red" hover for primary CTAs).
 *   - outline: paper button with ink border (matches the prototype's
 *     standard secondary button — ink border, ink text, ink-fill on hover).
 *   - ghost:   borderless, used for tertiary actions inside table rows.
 *   - destructive: explicit red fill for irreversible actions only.
 *   - link / secondary: kept for places that already use them.
 */
const buttonVariants = cva(
  // leading-none is critical: body's line-height: 1.55 inflates the text box
  // inside fixed-height buttons (h-7 / h-8) and pushes glyphs above optical
  // center. Especially visible with CJK labels (重新生成 etc).
  'inline-flex items-center justify-center whitespace-nowrap font-mono text-[11.5px] uppercase leading-none tracking-[0.06em] transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink focus-visible:ring-offset-0 ' +
    'disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        default:
          'border border-ink bg-ink text-[#f2eee2] hover:bg-red-brand hover:border-red-brand',
        outline:
          'border border-ink bg-paper text-ink hover:bg-ink hover:text-[#f2eee2]',
        secondary:
          'border border-rule bg-paper-alt text-ink hover:border-ink',
        ghost:
          'border border-rule bg-transparent text-soft hover:border-ink hover:text-ink',
        destructive:
          'border border-red-brand bg-red-brand text-[#f2eee2] hover:bg-[#c33b22] hover:border-[#c33b22]',
        link: 'text-ink underline-offset-4 hover:underline normal-case tracking-normal font-sans',
      },
      size: {
        default: 'h-7 px-3',
        sm: 'h-6 px-2.5 text-[10.5px]',
        lg: 'h-8 px-4 text-[12px]',
        icon: 'h-7 w-7 px-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
