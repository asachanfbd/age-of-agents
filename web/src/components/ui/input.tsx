import * as React from "react"

import { cn } from "@/lib/utils"

const fieldClass =
  "flex h-9 w-full rounded-control border border-input bg-card px-4 py-1 text-base shadow-xs transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"

export interface InputProps extends React.ComponentProps<"input"> {
  /** A leading icon (a search glass, say); the field then pads its text to clear it. */
  icon?: React.ReactNode
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, icon, ...props }, ref) => {
    const field = (
      <input
        type={type}
        className={cn(fieldClass, icon ? "pl-10" : "", className)}
        ref={ref}
        {...props}
      />
    )
    if (!icon) return field
    return (
      <div className="relative flex w-full items-center">
        <span aria-hidden className="pointer-events-none absolute left-3.5 flex text-muted-foreground [&_svg]:size-4">{icon}</span>
        {field}
      </div>
    )
  }
)
Input.displayName = "Input"

export { Input }
