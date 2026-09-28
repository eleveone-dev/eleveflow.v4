import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[#7c3aed20] text-[#8b5cf6] shadow-sm",
        secondary: "border-transparent bg-[#47556920] text-[#64748b]",
        destructive: "border-transparent bg-[#ef444420] text-[#ef4444]",
        outline: "border-[#2a2a3a] text-[#94a3b8]",
        success: "border-transparent bg-[#10b98120] text-[#10b981]",
        warning: "border-transparent bg-[#f59e0b20] text-[#f59e0b]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
