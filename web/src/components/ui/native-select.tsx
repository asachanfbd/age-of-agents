import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/** A pill-shaped native `<select>` with a chevron: for filters, where the browser's own list and keyboard handling are enough.
 *  The wrapper is the sizing box (`w-fit` by default, so it hugs the select even in a grid cell) and the select fills it,
 *  which keeps the chevron inside the pill; pass `wrapperClassName="w-full"` to fill a grid cell. */
const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select"> & { wrapperClassName?: string }>(
  ({ className, wrapperClassName, children, ...props }, ref) => (
    <span className={cn("relative inline-flex w-fit items-center", wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          "h-9 w-full cursor-pointer appearance-none rounded-control border border-input bg-card py-1 pl-4 pr-9 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 size-4 text-muted-foreground" />
    </span>
  )
)
NativeSelect.displayName = "NativeSelect"

export { NativeSelect }
