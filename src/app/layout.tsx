import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { NO_FLASH_SCRIPT } from "@/components/theme/theme-provider";

export const metadata: Metadata = {
  title: "Sales Planning System",
  description: "Seasonal sales planning and performance management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the no-flash script sets the theme class on <html> before
    // React hydrates, so the server/client class attribute legitimately differs.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body className="h-screen overflow-hidden antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
