"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"
import { indicatorBox } from "@/lib/tabIndicator"

const Tabs = TabsPrimitive.Root

/**
 * Pill tabs: the active tab is a charcoal pill that slides to the new tab. The pill is measured from
 * the active trigger (`data-state=active`), re-measured when the active tab or the list's size changes.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, children, ...props }, ref) => {
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const [box, setBox] = React.useState<{ x: number; width: number } | null>(null)

  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[data-state="active"]')
      const next = indicatorBox(
        { left: list.getBoundingClientRect().left, width: list.offsetWidth },
        active ? { left: active.getBoundingClientRect().left, width: active.offsetWidth } : null
      )
      setBox((prev) => (prev?.x === next?.x && prev?.width === next?.width ? prev : next))
    }
    measure()
    const mutations = new MutationObserver(measure)
    mutations.observe(list, { attributes: true, attributeFilter: ["data-state"], subtree: true, childList: true })
    const resize = new ResizeObserver(measure)
    resize.observe(list)
    return () => { mutations.disconnect(); resize.disconnect() }
  }, [])

  return (
    <TabsPrimitive.List
      ref={(node) => {
        listRef.current = node
        if (typeof ref === "function") ref(node)
        else if (ref) ref.current = node
      }}
      className={cn(
        "relative inline-flex h-10 w-fit items-center justify-center gap-0.5 rounded-control p-0 text-muted-foreground",
        className
      )}
      {...props}
    >
      {box && (
        <span
          aria-hidden
          data-slot="tab-indicator"
          className="pointer-events-none absolute left-0 top-0 h-full rounded-control bg-primary transition-[transform,width] duration-300 ease-out"
          style={{ transform: `translateX(${box.x}px)`, width: box.width }}
        />
      )}
      {children}
    </TabsPrimitive.List>
  )
})
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "relative z-10 inline-flex h-full items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-4 py-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-primary-foreground data-[state=active]:hover:text-primary-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
