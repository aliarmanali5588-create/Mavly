import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] shadow-[var(--clay-well-1)]", className)}
      {...props}
    />
  )
}

export { Skeleton }
