import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-2.5 py-0.5 text-xs font-semibold w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none outline-none focus-visible:shadow-[var(--neu-focus)] transition-[color,box-shadow] duration-200 overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-[var(--neu-elev-1)] [a&]:hover:shadow-[var(--neu-elev-2)]",
        secondary:
          "border-[var(--neu-line)] bg-[var(--neu-sunken)] text-secondary-foreground shadow-[var(--neu-inset-1)] [a&]:hover:shadow-[var(--neu-inset-2)]",
        destructive:
          "border-transparent bg-destructive text-white shadow-[var(--neu-elev-1)] [a&]:hover:shadow-[var(--neu-elev-2)]",
        outline:
          "border-[var(--neu-line)] bg-card text-foreground shadow-[var(--neu-elev-1)] [a&]:hover:shadow-[var(--neu-elev-2)]",
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
