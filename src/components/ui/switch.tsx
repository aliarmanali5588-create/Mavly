"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-[var(--clay-sunken)] inline-flex h-[1.25rem] w-9 shrink-0 items-center rounded-full border border-[var(--clay-line)] shadow-[var(--clay-well-2)] data-[state=checked]:shadow-[var(--clay-elev-ink-1)] transition-all duration-200 outline-none focus-visible:shadow-[var(--clay-well-2),var(--clay-focus)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-card pointer-events-none block size-4 rounded-full shadow-[var(--clay-elev-2)] ring-0 transition-transform duration-200 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
