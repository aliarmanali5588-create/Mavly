import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Claymorphic button.
 *
 * Every variant is the same physical material at a different elevation.
 * Hover holds the resting volume and only warms the edge; press sinks the
 * button into the plane. Nothing lifts, moves, or rescales. Colour never
 * signals state — volume does. Semantic colour is preserved for `default`
 * (ink) and `destructive` (ember) so meaning survives the material.
 *
 * The material itself (sheen, ink shadow recipe, press) is defined once in
 * clay.css against `[data-slot="button"]`. These variants only choose
 * elevation and colour.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--clay-r-md)] text-sm font-semibold",
    "transition-[box-shadow,background-color,border-color] duration-200 ease-[cubic-bezier(0.22,0.61,0.36,1)]",
    "disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none",
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0",
    "outline-none focus-visible:outline-none",
  ].join(" "),
  {
    variants: {
      variant: {
        // Raised ink clay — the primary action. Hover holds elevation.
        default:
          "bg-primary text-primary-foreground shadow-[var(--clay-elev-ink-1)] active:shadow-[var(--clay-press-ink)]",
        // Ember — destructive stays unmistakably destructive.
        destructive:
          "bg-destructive text-white shadow-[var(--clay-elev-ink-1)] active:shadow-[var(--clay-press-ink)]",
        // Raised white clay with a soft moulded edge.
        outline:
          "border border-[var(--clay-line)] bg-card text-foreground shadow-[var(--clay-elev-2)] hover:border-[var(--clay-line-strong)] active:shadow-[var(--clay-well-2)]",
        // Raised white clay, secondary weight.
        secondary:
          "border border-[var(--clay-line)] bg-card text-foreground shadow-[var(--clay-elev-1)] hover:border-[var(--clay-line-strong)] active:shadow-[var(--clay-well-2)]",
        // No surface until touched; then it presses into the clay.
        ghost:
          "text-foreground shadow-none hover:bg-[var(--clay-sunken)] active:shadow-[var(--clay-well-2)]",
        link: "text-foreground underline-offset-4 hover:underline shadow-none",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-[var(--clay-r-sm)] gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 rounded-[var(--clay-r-lg)] px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
