import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Neumorphic button.
 *
 * Every variant is the same physical material at a different elevation.
 * Hover raises the button (deeper shadow, 1px lift); press pushes it back
 * into the surface (inset shadow, no lift). Colour is never the signal —
 * depth is. Semantic colour is preserved for `default` (ink) and
 * `destructive` (ember) so meaning survives the redesign.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold",
    "transition-[box-shadow,transform,background-color,border-color] duration-200 ease-[cubic-bezier(0.22,0.61,0.36,1)]",
    "disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none",
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0",
    "outline-none focus-visible:outline-none",
  ].join(" "),
  {
    variants: {
      variant: {
        // Raised ink surface — the primary action.
        default:
          "bg-primary text-primary-foreground shadow-sm hover:shadow-md hover:-translate-y-px active:shadow-none active:translate-y-0 active:bg-primary/95",
        // Ember — destructive stays unmistakably destructive.
        destructive:
          "bg-destructive text-white shadow-sm hover:shadow-md hover:-translate-y-px active:shadow-none active:translate-y-0",
        // Raised white surface with a carved edge.
        outline:
          "border border-[var(--neu-line)] bg-card text-foreground shadow-sm hover:shadow-md hover:-translate-y-px hover:border-[var(--neu-line-strong)] active:shadow-none active:translate-y-0",
        // Recessed neutral — secondary weight.
        secondary:
          "border border-[var(--neu-line)] bg-secondary text-secondary-foreground shadow-[var(--neu-inset-1)] hover:shadow-sm hover:-translate-y-px active:shadow-[var(--neu-inset-2)] active:translate-y-0",
        // No surface until touched; then it recesses.
        ghost:
          "text-foreground shadow-none hover:bg-secondary hover:shadow-[var(--neu-inset-1)] active:shadow-[var(--neu-inset-2)]",
        link: "text-foreground underline-offset-4 hover:underline shadow-none",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-lg gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 rounded-xl px-6 has-[>svg]:px-4",
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
