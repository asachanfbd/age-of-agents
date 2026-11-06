"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { useResizablePopup } from "@/lib/useResizablePopup"
import { isStatusFooterTarget } from "@/lib/statusFooter"
import { isToastTarget } from "@/lib/notificationToasts"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

// No backdrop blur: it re-blurred the whole screen on every frame the page redrew, which kept the GPU
// busy while any popup was open. The scrim is darker in dark mode so a dark popup still stands out.
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-[150] bg-scrim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Omit the built-in top-right X, for a dialog that renders its own close control (e.g. inside its header). */
    hideClose?: boolean
    /** localStorage key under which this popup remembers its dragged size per browser-window size. */
    sizeMemoryKey?: string
  }
>(({ className, children, hideClose = false, sizeMemoryKey, style, onInteractOutside, ...props }, ref) => {
  const resize = useResizablePopup(sizeMemoryKey)
  return (
  <DialogPortal>
    <DialogOverlay />
    {/* Centred in the space above the status footer and no taller than it allows (see popupResize.ts). */}
    <DialogPrimitive.Content
      ref={ref}
      style={{ ...style, ...resize.style }}
      onInteractOutside={(event) => {
        // The status footer and toasts stay usable while a popup is open; using it must not dismiss the popup.
        if (isStatusFooterTarget(event.target) || isToastTarget(event.target)) event.preventDefault()
        onInteractOutside?.(event)
      }}
      className={cn(
        "fixed left-[50%] top-[var(--popup-center-y)] z-[150] grid max-h-[var(--popup-max-height)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto bg-card p-6 shadow-lift duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] rounded-card",
        className
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-control p-1 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
      {/* Drag grip: resizes the popup, capped at the space above the status footer less a margin (see useResizablePopup). */}
      <div
        aria-hidden
        data-popup-resize-handle
        className="absolute bottom-0 right-0 z-10 hidden h-4 w-4 cursor-nwse-resize touch-none text-muted-foreground/60 hover:text-muted-foreground sm:block"
        {...resize.handleProps}
      >
        <svg viewBox="0 0 16 16" className="h-full w-full" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M13 7 7 13M13 11l-2 2" />
        </svg>
      </div>
    </DialogPrimitive.Content>
  </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
