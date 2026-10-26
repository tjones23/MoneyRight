import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { appContext } from "@/server/context";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "MoneyRight", template: "%s · MoneyRight" },
  description: "Your balances and net worth, in one place.",
  // A personal server on a private network; nothing here is for search engines.
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "MoneyRight", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#08080b" },
  ],
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Every page renders per request: each one is someone's own data, and the
 * CSP nonce only reaches scripts rendered for a request (see proxy.ts).
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const devSignIn = !appContext().secondFactorRequired;
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-ink text-text">
        {devSignIn && (
          <p className="bg-accent px-4 py-1 text-center text-xs font-medium text-accent-ink">
            Dev server, dev data — signing in skips the authenticator here. Production always asks for it.
          </p>
        )}
        {children}
      </body>
    </html>
  );
}
