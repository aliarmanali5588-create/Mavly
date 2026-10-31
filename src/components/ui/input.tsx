import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Claymorphic input — a carefully moulded well in the clay surface.
 *
 * The recess is the resting state; hover deepens it slightly and focus
 * adds the single global focus ring. Nothing about the colour changes.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-[var(--clay-r-md)] border border-[var(--clay-line)] bg-[var(--clay-sunken)] px-3 py-1 text-base text-foreground",
        "shadow-[var(--clay-well-2)] transition-[box-shadow,border-color] duration-200 ease-[cubic-bezier(0.22,0.61,0.36,1)]",
        "placeholder:text-muted-foreground outline-none",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:shadow-[var(--clay-well-2),var(--clay-focus)] focus-visible:border-transparent",
        "aria-invalid:shadow-[var(--clay-well-2),0_0_0_2px_rgba(237,53,0,0.28)] aria-invalid:border-transparent",
        "md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
