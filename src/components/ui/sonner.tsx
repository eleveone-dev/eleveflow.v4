import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-[#111118] group-[.toaster]:text-white group-[.toaster]:border-[#2a2a3a] group-[.toaster]:shadow-2xl group-[.toaster]:rounded-xl group-[.toaster]:p-4",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-[#7c3aed] group-[.toast]:text-white font-bold",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
