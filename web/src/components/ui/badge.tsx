import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 rounded-control border border-transparent px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        /* Soft status tints: a pale wash of the status colour with its readable text colour. */
        warning: "bg-warning/20 text-warning-foreground",
        success: "bg-success/15 text-success-foreground",
        info: "bg-info/15 text-info-foreground",
        "soft-destructive": "bg-destructive/15 text-destructive",
        outline: "border-input text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  /** Shows a dot in the variant's colour before the label, on the plain track instead of a tint. */
  dot?: boolean
}

function Badge({ className, variant, dot = false, children, ...props }: BadgeProps) {
  const toned = dot ? "bg-secondary text-secondary-foreground" : ""
  return (
    <div className={cn(badgeVariants({ variant }), dot && toned, className)} {...props}>
      {dot && <span aria-hidden className={cn("size-2 rounded-full", DOT_COLOUR[variant ?? "default"])} />}
      {children}
    </div>
  )
}

const DOT_COLOUR: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "bg-primary",
  secondary: "bg-muted-foreground",
  destructive: "bg-destructive",
  warning: "bg-warning",
  success: "bg-success",
  info: "bg-info",
  "soft-destructive": "bg-destructive",
  outline: "bg-muted-foreground",
}

export { Badge, badgeVariants }
