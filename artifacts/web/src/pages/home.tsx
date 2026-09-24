import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Activity, FileCheck2, Cpu, Zap } from "lucide-react";

function BlueprintLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="32" height="32" rx="4" fill="currentColor" fillOpacity="0.15"/>
      <rect x="4" y="4" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.5"/>
      <line x1="4" y1="9" x2="7" y2="9" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="11" cy="9" r="2.5" fill="currentColor"/>
      <line x1="13.5" y1="7" x2="20" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <rect x="20" y="2" width="10" height="6" rx="1" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1"/>
      <line x1="22" y1="4.5" x2="28" y2="4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <line x1="22" y1="6" x2="26" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <rect x="4" y="18" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="9" cy="23" r="2" fill="currentColor"/>
      <line x1="18" y1="18" x2="28" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="18" y1="21" x2="28" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="18" y1="24" x2="24" y2="24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary/30">
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-50">
        <div className="container flex h-16 max-w-screen-2xl items-center justify-between px-4 md:px-8">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <BlueprintLogo className="w-5 h-5" />
            </div>
            <span className="inline-flex items-center gap-1.5" style={{ fontFamily: "'Chakra Petch'", fontWeight: 700, color: 'hsl(var(--primary))', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <Zap className="h-4 w-4 text-accent" />
              AI-Assist Takeoffs
            </span>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/sign-in">
              <Button variant="ghost" className="hidden sm:inline-flex" data-testid="btn-login-header">Sign In</Button>
            </Link>
            <Link href="/sign-in">
              <Button data-testid="btn-signup-header">Get Started</Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        <section className="flex-1 flex flex-col items-center justify-center px-4 py-24 text-center md:py-32">
          <div className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-medium text-primary mb-8">
            <Activity className="mr-2 h-4 w-4" />
            Precision Signage Extraction Engine
          </div>
          
          <h1 className="max-w-4xl text-5xl font-extrabold tracking-tight sm:text-6xl md:text-7xl lg:text-8xl">
            Sign Takeoffs in Minutes, <br className="hidden sm:inline" />
            <span className="text-muted-foreground">Not Hours.</span>
          </h1>
          
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground md:text-xl leading-relaxed">
            Upload architectural construction PDFs. Our rules engine reads room data, applies ADA and code sign-type rules, and produces a complete, exportable sign schedule — automatically.
          </p>
          
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/sign-in">
              <Button size="lg" className="h-12 px-8 text-base gap-2 w-full sm:w-auto" data-testid="btn-signup-hero">
                Start Your First Takeoff →
              </Button>
            </Link>
          </div>
        </section>

        <section className="border-t border-border bg-muted/30">
          <div className="container max-w-screen-2xl px-4 py-24 md:px-8">
            <div className="grid gap-12 md:grid-cols-3">
              <div className="flex flex-col gap-4">
                <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <FileCheck2 className="h-6 w-6" />
                </div>
                <h3 className="text-xl font-bold">Automated Schedules</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Generate complete sign schedules from floor plans in minutes instead of days. Every room, every door, accounted for automatically.
                </p>
              </div>
              <div className="flex flex-col gap-4">
                <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <Activity className="h-6 w-6" />
                </div>
                <h3 className="text-xl font-bold">Confidence Scoring</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Our extraction engine provides confidence intervals for every detected sign, letting you focus only on the exceptions that need human review.
                </p>
              </div>
              <div className="flex flex-col gap-4">
                <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <Cpu className="h-6 w-6" />
                </div>
                <h3 className="text-xl font-bold">Rules Engine</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Train the system on your specific jurisdiction codes. Overrides and custom logic ensure output matches local building requirements.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8 md:py-12">
        <div className="container max-w-screen-2xl px-4 md:px-8 text-center text-sm text-muted-foreground">
          <p>© {new Date().getFullYear()} AI-Assist Takeoffs. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
