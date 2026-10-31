import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-2.5 py-0.5 text-xs font-semibold w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none outline-none focus-visible:shadow-[var(--clay-focus)] transition-[color,box-shadow] duration-200 overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-[var(--clay-elev-ink-1)] [a&]:hover:shadow-[var(--clay-elev-ink-2)]",
        secondary:
          "border-[var(--clay-line)] bg-[var(--clay-sunken)] text-secondary-foreground shadow-[var(--clay-well-1)] [a&]:hover:shadow-[var(--clay-well-2)]",
        destructive:
          "border-transparent bg-destructive text-white shadow-[var(--clay-elev-ink-1)] [a&]:hover:shadow-[var(--clay-elev-ink-2)]",
        outline:
          "border-[var(--clay-line)] bg-card text-foreground shadow-[var(--clay-elev-1)] [a&]:hover:shadow-[var(--clay-elev-2)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
