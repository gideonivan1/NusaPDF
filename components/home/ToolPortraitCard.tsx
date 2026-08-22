import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { CATEGORY_LABEL, type ToolDefinition } from '@/lib/tools';
import { cn } from '@/lib/utils';

/**
 * The signature gesture (PRD §6): a perfect circle with a white satellite CTA
 * docked bottom-right and protruding outside the portrait, an eyebrow with its
 * accent dot, then the title. Never a rounded rectangle.
 *
 * Sized for a six-across constellation. At that density the card is an icon,
 * not an editorial card, so the long tool description is left to the tool page
 * itself — two clamped lines at ~170px wide would be unreadable either way.
 *
 * Real photography would sit inside the circle in production. Until then the
 * portrait is a warm radial wash that dissolves into the cream canvas at its
 * edge — the same "circle-image fade" the design system describes, so the
 * placeholder reads as designed rather than unfinished.
 */

const PORTRAIT_WASH: Record<string, string> = {
  ai: 'radial-gradient(120% 120% at 30% 25%, #F9B487 0%, #F37338 42%, #CF4500 100%)',
  organize: 'radial-gradient(120% 120% at 30% 25%, #F5E3D3 0%, #E2B48C 45%, #9A3A0A 100%)',
  optimize: 'radial-gradient(120% 120% at 30% 25%, #EFE7DF 0%, #C9B6A4 45%, #6B5442 100%)',
  convert: 'radial-gradient(120% 120% at 30% 25%, #FBD9BC 0%, #F0A472 45%, #B7511C 100%)',
  edit: 'radial-gradient(120% 120% at 30% 25%, #E7E4E1 0%, #B9B2AB 45%, #4A443E 100%)',
};

export function ToolPortraitCard({ tool }: { tool: ToolDefinition }) {
  const Icon = tool.icon;
  const disabled = !tool.available;

  const content = (
    <>
      {/* Fixed cap keeps the circle small regardless of how wide the column
          gets on very large screens. */}
      <div className="relative mx-auto w-full max-w-[108px]">
        <div
          className={cn(
            'relative grid aspect-square w-full place-items-center overflow-hidden rounded-full transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]',
            !disabled && 'group-hover:scale-[1.06]',
            disabled && 'opacity-45 saturate-50',
          )}
          style={{ backgroundImage: PORTRAIT_WASH[tool.category] }}
        >
          <Icon
            aria-hidden
            strokeWidth={1.5}
            className="size-[40%] text-white/95 drop-shadow-[0_2px_8px_rgb(0_0_0/0.18)]"
          />
        </div>

        {/* Satellite micro-CTA: a perfect circle docked on the portrait's rim. */}
        <span
          aria-hidden
          className={cn(
            'absolute right-0 bottom-0 grid size-8 translate-x-[30%] translate-y-[30%] place-items-center rounded-full bg-white shadow-nav transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]',
            !disabled && 'group-hover:-translate-y-[calc(30%+3px)] group-hover:translate-x-[30%]',
            disabled && 'bg-lifted',
          )}
        >
          {disabled ? (
            <span className="text-[8px] leading-none font-bold tracking-[0.04em] text-slate uppercase">
              soon
            </span>
          ) : (
            <ArrowUpRight className="size-3.5 text-ink" strokeWidth={2.25} />
          )}
        </span>
      </div>

      <div className="mt-6 text-center">
        <p className="flex items-center justify-center gap-1.5 text-[11px] leading-none font-bold tracking-[0.04em] text-slate uppercase">
          <span aria-hidden className="size-[4px] shrink-0 rounded-full bg-signal-light" />
          {CATEGORY_LABEL[tool.category]}
        </p>

        <h3 className="mt-2.5 text-[16px] leading-[1.25] tracking-[-0.02em] text-ink text-balance">
          {tool.name}
        </h3>
      </div>
    </>
  );

  if (disabled) {
    return (
      <div className="group relative" aria-label={`${tool.name} — segera hadir`}>
        {content}
      </div>
    );
  }

  return (
    <Link
      href={tool.href}
      // The description still reaches assistive tech and hover, just not the grid.
      title={tool.description}
      className="group relative block rounded-stadium outline-offset-4 focus-visible:outline-2 focus-visible:outline-ink"
    >
      {content}
    </Link>
  );
}
