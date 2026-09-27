import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "OutRN — Go somewhere good", template: "%s · OutRN" },
  description: "Three nearby options that actually fit the time you have.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="brand" href="/" aria-label="OutRN home">
            <span className="brand-mark" aria-hidden="true">O</span>
            <span>OutRN</span>
          </Link>
          <nav aria-label="Primary navigation">
            <Link href="/">Find somewhere</Link>
            <Link href="/ops/eligible">Eligible now</Link>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <span>Feasibility first.</span>
          <span>Local data from OpenStreetMap.</span>
        </footer>
      </body>
    </html>
  );
}
