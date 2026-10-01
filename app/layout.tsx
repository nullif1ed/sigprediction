import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "PredictionCup Bot",
  description: "Research and paper-trading system for the Susquehanna Predictions Cup (paper execution only).",
};

const NAV = [
  ["/", "Dashboard"],
  ["/markets", "Markets"],
  ["/opportunities", "Opportunities"],
  ["/external", "Cross-venue"],
  ["/portfolio", "Paper portfolio"],
  ["/orders", "Trade log"],
  ["/backtest", "Backtest"],
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="font-semibold text-blue-700">
              PredictionCup Bot <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">PAPER</span>
            </Link>
            <nav className="flex flex-wrap gap-4 text-sm">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href} className="text-slate-600 hover:text-blue-700">
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">{children}</main>
        <footer className="mx-auto max-w-7xl px-4 pb-6 text-xs text-slate-500">
          All execution is simulated. Data: Super Market API (SIG), Polymarket Gamma API, Kalshi public API.
        </footer>
      </body>
    </html>
  );
}
