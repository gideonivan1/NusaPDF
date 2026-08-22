import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/**
 * Ref: PRD §6 / design system §4.
 *
 * `consent` exists but is deliberately not used anywhere in the product UI:
 * Signal Orange is the compliance colour and using it for a marketing CTA
 * dilutes that signal. It is here so the cookie banner has a correct variant
 * to reach for, not as a general "emphasis" button.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'consent';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'border-[1.5px] border-ink bg-ink text-canvas hover:bg-charcoal disabled:border-dust disabled:bg-dust disabled:text-white',
  secondary:
    'border-[1.5px] border-ink bg-white text-ink font-normal hover:bg-lifted disabled:border-dust disabled:text-dust disabled:bg-transparent',
  ghost:
    'border-[1.5px] border-transparent bg-transparent text-granite hover:text-ink hover:bg-lifted disabled:text-dust',
  consent: 'rounded-consent border-0 bg-signal text-white hover:bg-clay',
};

const SIZES: Record<Size, string> = {
  sm: 'px-4 py-1.5 text-[14px]',
  md: 'px-6 py-2.5 text-[16px]',
  lg: 'px-8 py-3.5 text-[17px]',
};

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  asChild = false,
  className,
  ...props
}: Props) {
  const Component = asChild ? Slot : 'button';

  return (
    <Component
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-btn font-medium tracking-[-0.02em] transition-all duration-200',
        'active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

/** Circular icon-only button — carousel controls, rotate, remove. */
export function IconButton({
  className,
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        // 40px is the design system's floor for icon-only circles, which also
        // clears the 44px touch target once the focus ring is counted.
        'grid size-11 shrink-0 place-items-center rounded-full text-ink transition-colors',
        'hover:bg-canvas disabled:cursor-not-allowed disabled:text-dust disabled:hover:bg-transparent',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
