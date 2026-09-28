import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-lg border border-[#2a2a3a] bg-[#0d0d14] px-4 py-2 text-sm text-[#f1f5f9] shadow-sm transition-all placeholder:text-[#475569] focus-visible:outline-none focus-visible:border-[#7c3aed] focus-visible:ring-4 focus-visible:ring-[#7c3aed]/15 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
