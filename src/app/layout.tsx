import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LYMTLESS AI BUILDER",
  description: "Build full-stack web applications from natural language.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
