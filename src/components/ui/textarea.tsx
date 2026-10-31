import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Claymorphic textarea — the same moulded well as `Input`, taller.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-[var(--clay-r-md)] border border-[var(--clay-line)] bg-[var(--clay-sunken)] px-3 py-2 text-base text-foreground",
        "shadow-[var(--clay-well-2)] transition-[box-shadow,border-color] duration-200 ease-[cubic-bezier(0.22,0.61,0.36,1)]",
        "placeholder:text-muted-foreground outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:shadow-[var(--clay-well-2),var(--clay-focus)] focus-visible:border-transparent",
        "aria-invalid:shadow-[var(--clay-well-2),0_0_0_2px_rgba(237,53,0,0.28)] aria-invalid:border-transparent",
        "md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
