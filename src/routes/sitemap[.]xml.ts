import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () =>
        new Response("Sitemap indisponível para a aplicação interna.", {
          status: 410,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Robots-Tag": "noindex, nofollow",
          },
        }),
    },
  },
});
