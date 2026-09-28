import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-linear-to-r from-[#1e1e2e] via-[#2a2a3a] to-[#1e1e2e] bg-[length:200%_100%]",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
