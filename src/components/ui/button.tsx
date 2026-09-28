import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#7c3aed] disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-linear-to-br from-[#7c3aed] to-[#6d28d9] text-white shadow-lg shadow-[#7c3aed]/20 hover:brightness-110 active:scale-[0.98]",
        destructive:
          "border border-[#ef444440] text-[#ef4444] hover:bg-[#ef444415] active:scale-[0.98]",
        outline:
          "border border-[#2a2a3a] bg-transparent text-[#94a3b8] hover:border-[#7c3aed] hover:text-white active:scale-[0.98]",
        secondary: "bg-[#1a1a24] text-white hover:bg-[#2a2a3a] active:scale-[0.98]",
        ghost: "hover:bg-[#1a1a24] hover:text-white active:scale-[0.98]",
        link: "text-[#7c3aed] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
