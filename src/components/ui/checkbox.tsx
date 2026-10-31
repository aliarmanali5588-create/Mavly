"use client"

import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[5px] border border-[var(--neu-line)] bg-[var(--neu-sunken)] shadow-[var(--neu-inset-1)] transition-[box-shadow,background-color] duration-200 outline-none data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-transparent data-[state=checked]:shadow-[var(--neu-elev-1)] focus-visible:shadow-[var(--neu-inset-1),var(--neu-focus)] aria-invalid:shadow-[var(--neu-inset-1),0_0_0_2px_rgba(237,53,0,0.28)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
