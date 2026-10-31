"use client"

import * as React from "react"
import * as TogglePrimitive from "@radix-ui/react-toggle"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium text-foreground outline-none transition-[box-shadow,background-color] duration-200 hover:bg-[var(--neu-sunken)] hover:shadow-[var(--neu-inset-1)] disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-[var(--neu-sunken)] data-[state=on]:shadow-[var(--neu-inset-2)] data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:shadow-[var(--neu-focus)] whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-[var(--neu-line)] bg-card shadow-[var(--neu-elev-1)] hover:shadow-[var(--neu-elev-2)] data-[state=on]:shadow-[var(--neu-inset-2)]",
      },
      size: {
        default: "h-9 px-2 min-w-9",
        sm: "h-8 px-1.5 min-w-8",
        lg: "h-10 px-2.5 min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
