import { Toaster as Sonner, type ToasterProps } from "sonner"

/** shadcn/ui's Sonner wrapper, colored with this app's existing shadcn tokens. */
function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "group/toast !rounded-card !border-0 !bg-toast !text-toast-foreground !shadow-lift",
          title: "!text-toast-foreground",
          description: "!text-toast-foreground/70",
          actionButton: "!rounded-control !bg-stage-yellow !px-3 !font-semibold !text-stage-yellow-foreground hover:!opacity-90",
          closeButton: "pointer-events-none opacity-0 transition-opacity duration-200 group-hover/toast:pointer-events-auto group-hover/toast:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100",
          error: "!bg-destructive !text-destructive-foreground",
          warning: "!bg-warning !text-stage-yellow-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
