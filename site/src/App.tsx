import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Check,
  Clock,
  Copy,
  Flame,
  GitBranch,
  Layers,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/components/ui/terminal";
import { BorderBeam } from "@/components/ui/border-beam";
import { Marquee } from "@/components/ui/marquee";
import { NumberTicker } from "@/components/ui/number-ticker";
import { CodeComparison } from "@/components/ui/code-comparison";
import { MagicCard } from "@/components/ui/magic-card";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { Spotlight } from "@/components/ui/spotlight-new";
import Noise from "@/components/Noise";
import GradientText from "@/components/GradientText";

const REPO_URL = "https://github.com/ahmedbouh-dev/ciburn";
const EMBER = ["#f97316", "#facc15", "#ef4444", "#f97316"];

const DETECTIONS = [
  "Flaky jobs",
  "Missing concurrency",
  "Re-run waste",
  "macOS on every PR",
  "Uncached installs",
  "Runner queues",
  "6-hour timeouts",
  "Oversized runners",
  "Noisy schedules",
];

const FEATURES = [
  {
    icon: Flame,
    title: "Cost per workflow, job and runner",
    text: "Billed the way GitHub bills: every job rounded up to the minute, priced by OS, arm64, core count and macOS size.",
  },
  {
    icon: RefreshCw,
    title: "Flaky jobs, proven",
    text: "Failed, then passed on the same commit with no code change. You see the flake rate, the wasted minutes and the failing step.",
  },
  {
    icon: GitBranch,
    title: "Superseded builds",
    text: "PR builds that keep running after a newer push. ciburn quantifies it and hands you the concurrency block.",
  },
  {
    icon: Server,
    title: "Right-size runners",
    text: "macOS legs that could run on Linux for PRs, 16-core runners doing 70-second jobs. iOS and Xcode jobs are never flagged.",
  },
  {
    icon: Layers,
    title: "Missing caches",
    text: "Uncached pnpm, npm, pip, uv, Gradle, Cargo, Go and CocoaPods installs, with a snippet for the ecosystem it detected.",
  },
  {
    icon: Timer,
    title: "Queues and timeouts",
    text: "Self-hosted pools that keep people waiting, and jobs that hang until the 360-minute default.",
  },
];

const BEFORE = `name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm test`;

const AFTER = `name: CI
on:
  pull_request:
  push:
    branches: [main]

concurrency: # [!code highlight]
  group: \${{ github.workflow }}-\${{ github.ref }} # [!code highlight]
  cancel-in-progress: \${{ github.event_name == 'pull_request' }} # [!code highlight]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20 # [!code highlight]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4 # [!code highlight]
      - uses: actions/setup-node@v4 # [!code highlight]
        with: { node-version: 24, cache: pnpm } # [!code highlight]
      - run: pnpm install
      - run: pnpm test`;

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="group flex h-11 items-center gap-3 rounded-full border border-border bg-background/60 px-5 font-mono text-sm backdrop-blur transition-colors hover:border-orange-500/50"
      aria-label={`Copy command: ${command}`}
    >
      <span className="text-orange-500">$</span>
      <span>{command}</span>
      {copied ? (
        <Check className="size-4 text-emerald-500" />
      ) : (
        <Copy className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      )}
    </button>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/50 bg-background/70 backdrop-blur-xl">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="#" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-orange-500 to-red-600 text-white shadow-[0_0_20px_-4px] shadow-orange-500/60">
            <Flame className="size-4" />
          </span>
          ciburn
        </a>
        <div className="flex items-center gap-1 sm:gap-2">
          <a href="#fixes" className="hidden px-3 text-sm text-muted-foreground hover:text-foreground sm:block">
            Fixes
          </a>
          <a href="#action" className="hidden px-3 text-sm text-muted-foreground hover:text-foreground sm:block">
            GitHub Action
          </a>
          <Button asChild size="sm" variant="outline">
            <a href={REPO_URL}>
              <GitBranch className="size-4" /> GitHub
            </a>
          </Button>
        </div>
      </nav>
    </header>
  );
}

function Hero() {
  const reduce = useReducedMotion();
  return (
    <section className="relative overflow-hidden">
      {!reduce && (
        <Spotlight
          gradientFirst="radial-gradient(68.54% 68.72% at 55.02% 31.46%, hsla(24, 100%, 60%, .10) 0, hsla(24, 100%, 50%, .03) 50%, hsla(24, 100%, 45%, 0) 80%)"
          gradientSecond="radial-gradient(50% 50% at 50% 50%, hsla(12, 100%, 60%, .07) 0, hsla(12, 100%, 55%, .02) 80%, transparent 100%)"
          gradientThird="radial-gradient(50% 50% at 50% 50%, hsla(40, 100%, 60%, .05) 0, hsla(40, 100%, 45%, .02) 80%, transparent 100%)"
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(249,115,22,0.16),transparent_60%)]" />

      <div className="relative mx-auto max-w-6xl px-4 pt-20 pb-16 sm:px-6 sm:pt-28">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto flex max-w-3xl flex-col items-center text-center"
        >
          <a
            href={REPO_URL}
            className="mb-8 rounded-full border border-border bg-background/50 px-1 py-1 text-xs backdrop-blur transition-colors hover:border-orange-500/40"
          >
            <AnimatedShinyText className="inline-flex items-center gap-2 px-3 font-mono tracking-wider uppercase">
              <span className="size-1.5 rounded-full bg-orange-500 shadow-[0_0_8px] shadow-orange-500" />
              Open source · MIT<span className="hidden sm:inline"> · zero dependencies</span>
              <ArrowRight className="size-3" />
            </AnimatedShinyText>
          </a>

          <h1 className="text-5xl leading-[1.02] font-semibold tracking-tighter text-balance sm:text-7xl">
            Find where your CI money{" "}
            <GradientText colors={EMBER} animationSpeed={6} className="inline-flex !mx-0 !rounded-none">
              burns.
            </GradientText>
          </h1>

          <p className="mt-6 max-w-xl text-lg text-pretty text-muted-foreground">
            ciburn reads your GitHub Actions history and shows what CI costs, which jobs are flaky and where minutes
            go to waste. Every finding comes with the YAML fix and the monthly saving.
          </p>

          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
            <CopyCommand command="npx ciburn owner/repo" />
            <a href={`${REPO_URL}/blob/main/examples/vitejs-vite-report.html`}>
              <ShimmerButton
                shimmerColor="#fdba74"
                background="linear-gradient(135deg,#ea580c,#b91c1c)"
                className="h-11 px-6 text-sm font-medium"
              >
                See a real report <ArrowRight className="ml-2 size-4" />
              </ShimmerButton>
            </a>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            No token? <code className="font-mono text-foreground">npx ciburn --demo</code>
          </p>
        </motion.div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 40, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="relative mx-auto mt-16 max-w-3xl"
        >
          <div className="absolute -inset-8 -z-10 rounded-[2rem] bg-orange-500/10 blur-3xl" />
          <div className="relative overflow-hidden rounded-xl">
            <Terminal className="max-h-none w-full max-w-none border-border/70 bg-zinc-950 text-xs text-zinc-200 sm:text-sm [&_code]:text-xs sm:[&_code]:text-sm [&_pre]:whitespace-pre-wrap">
              <TypingAnimation className="text-zinc-400">$ npx ciburn vitejs/vite --days 7</TypingAnimation>
              <AnimatedSpan className="text-zinc-500">fetched 1,024 runs · 2,853 jobs in 1m 45s</AnimatedSpan>
              <AnimatedSpan className="mt-2">
                <span>
                  <span className="text-zinc-100">$296/mo</span>
                  <span className="text-zinc-500"> monthly spend · </span>
                  <span className="text-amber-400">3% wasted</span>
                  <span className="text-zinc-500"> · </span>
                  <span className="text-emerald-400">$165/mo</span>
                  <span className="text-zinc-500"> savings · </span>
                  <span className="text-sky-400">3.2h</span>
                  <span className="text-zinc-500"> dev time</span>
                </span>
              </AnimatedSpan>
              <AnimatedSpan className="mt-2 text-zinc-500">TOP FIXES</AnimatedSpan>
              <AnimatedSpan>
                <span>
                  <span className="text-red-400">● HIGH</span> macOS matrix leg <span className="text-cyan-400">Build&amp;Test: node-26, macos-latest</span> runs on every PR{" "}
                  <span className="text-emerald-400">$163/mo</span>
                </span>
              </AnimatedSpan>
              <AnimatedSpan>
                <span>
                  <span className="text-red-400">● HIGH</span> <span className="text-cyan-400">Build&amp;Test: node-26, windows-latest</span> is flaky (8% of commits){" "}
                  <span className="text-sky-400">3.2h dev</span>
                </span>
              </AnimatedSpan>
              <AnimatedSpan>
                <span className="text-zinc-400">
                  &nbsp;&nbsp;→ fails in step <span className="text-cyan-400">Test serve (bundled dev)</span>, retry it or quarantine the spec
                </span>
              </AnimatedSpan>
              <AnimatedSpan>
                <span>
                  <span className="text-zinc-500">○ LOW&nbsp;</span> Retrying failures without code changes{" "}
                  <span className="text-emerald-400">$0.30/mo</span>
                </span>
              </AnimatedSpan>
              <AnimatedSpan className="mt-2 text-zinc-500">wrote ciburn-report.html</AnimatedSpan>
            </Terminal>
            <BorderBeam duration={8} size={120} colorFrom="#f97316" colorTo="#ef4444" />
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function DetectionsMarquee() {
  return (
    <section aria-label="What ciburn detects" className="relative border-y border-border/60 py-5">
      <Marquee pauseOnHover className="[--duration:35s] [--gap:2.5rem]">
        {DETECTIONS.map((d) => (
          <span key={d} className="flex items-center gap-2.5 font-mono text-sm tracking-wider text-muted-foreground uppercase">
            <span className="text-orange-500">✦</span> {d}
          </span>
        ))}
      </Marquee>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1/6 bg-gradient-to-r from-background" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-1/6 bg-gradient-to-l from-background" />
    </section>
  );
}

function Stat({ value, prefix, suffix, label }: { value: number; prefix?: string; suffix?: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 px-2">
      <div className="text-4xl font-semibold tracking-tighter tabular-nums sm:text-5xl">
        {prefix}
        <NumberTicker value={value} className="text-foreground" />
        {suffix && <span className="text-2xl text-muted-foreground sm:text-3xl">{suffix}</span>}
      </div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  );
}

function RealNumbers() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Badge variant="outline" className="mb-4 font-mono">vitejs/vite · last 7 days</Badge>
          <h2 className="max-w-lg text-3xl font-semibold tracking-tight sm:text-4xl">Real numbers from a real repo.</h2>
        </div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Public repos run on free standard runners, so these are list-price equivalents. On a private repo, this is what you'd be billed.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-y-10 rounded-2xl border border-border bg-card/40 p-8 md:grid-cols-4">
        <Stat value={1024} label="workflow runs analyzed" />
        <Stat value={296} prefix="$" suffix="/mo" label="CI spend at list price" />
        <Stat value={68} suffix="%" label="of it on macOS runners" />
        <Stat value={165} prefix="$" suffix="/mo" label="savings found, with fixes" />
      </div>
    </section>
  );
}

function Fixes() {
  return (
    <section id="fixes" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Not a dashboard. A diff.</h2>
        <p className="mt-4 text-muted-foreground">
          Every finding ends in a change you can paste: concurrency, timeouts and caching, chosen to match what is actually in your jobs.
        </p>
      </div>
      <CodeComparison
        beforeCode={BEFORE}
        afterCode={AFTER}
        language="yaml"
        filename=".github/workflows/ci.yml"
        lightTheme="github-light"
        darkTheme="github-dark"
        highlightColor="rgba(249, 115, 22, 0.14)"
      />
    </section>
  );
}

function Features() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <h2 className="mb-12 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
        Nine detectors, tuned on real repos, so they rarely cry wolf.
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <MagicCard key={title} className="rounded-2xl" gradientFrom="#f97316" gradientTo="#ef4444" gradientColor="rgba(249,115,22,0.08)">
            <div className="flex h-full flex-col gap-3 p-6">
              <Icon className="size-5 text-orange-500" />
              <h3 className="font-medium">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
            </div>
          </MagicCard>
        ))}
      </div>
    </section>
  );
}

function Trust() {
  const items = [
    { icon: ShieldCheck, title: "$ means billing. Hours mean people.", text: "Waiting time is reported in hours and is never added into dollar figures." },
    { icon: Lock, title: "Your data stays put", text: "It runs on your machine or your runner and needs only a read-only actions:read token." },
    { icon: Zap, title: "Fast, then faster", text: "Job data is cached locally, so later runs fetch only what is new." },
    { icon: Clock, title: "30 seconds to first insight", text: "One command. No signup, no agent, no YAML to install first." },
  ];
  return (
    <section className="border-y border-border/60 bg-card/30">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        {items.map(({ icon: Icon, title, text }) => (
          <div key={title} className="flex flex-col gap-2">
            <Icon className="mb-2 size-5 text-orange-500" />
            <h3 className="font-medium">{title}</h3>
            <p className="text-sm text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const ACTION_YAML = `# .github/workflows/ci-cost.yml
name: CI cost report
on:
  schedule: [{ cron: "0 7 * * 1" }]   # every Monday
permissions:
  actions: read
jobs:
  ciburn:
    runs-on: ubuntu-latest
    steps:
      - uses: ahmedbouh-dev/ciburn@v0
        with:
          days: 30
          fail-on-waste: 15           # optional CI gate`;

function ActionSection() {
  return (
    <section id="action" className="mx-auto grid max-w-6xl scroll-mt-20 items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2">
      <div>
        <Badge variant="outline" className="mb-4 font-mono">GitHub Action</Badge>
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">A fresh cost report every Monday.</h2>
        <p className="mt-4 text-muted-foreground">
          Add one workflow. The report lands in the job summary and the HTML version is uploaded as an artifact. With{" "}
          <code className="font-mono text-foreground">fail-on-waste</code>, the job fails when waste creeps past your budget.
        </p>
      </div>
      <div className="relative min-w-0 overflow-hidden rounded-xl border border-border bg-zinc-950 p-5 shadow-2xl">
        <pre className="overflow-x-auto font-mono text-[13px] leading-relaxed text-zinc-300">{ACTION_YAML}</pre>
        <BorderBeam duration={10} size={90} colorFrom="#f97316" colorTo="#facc15" />
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-80 bg-[radial-gradient(ellipse_at_bottom,rgba(249,115,22,0.18),transparent_65%)]" />
      <div className="relative mx-auto flex max-w-3xl flex-col items-center px-4 py-28 text-center sm:px-6">
        <h2 className="text-4xl font-semibold tracking-tighter text-balance sm:text-6xl">Stop paying for runs nobody needed.</h2>
        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
          <CopyCommand command="npx ciburn owner/repo" />
          <Button asChild size="lg" variant="ghost" className="h-11 rounded-full">
            <a href={REPO_URL}>
              Star on GitHub <ArrowRight className="size-4" />
            </a>
          </Button>
        </div>
      </div>
      <footer className="relative border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <span>ciburn · MIT licensed</span>
          <span>Prices: GitHub-hosted runner list prices (2026). Not affiliated with GitHub.</span>
        </div>
      </footer>
    </section>
  );
}

export default function App() {
  const reduce = useReducedMotion();
  return (
    <div className="relative min-h-svh overflow-x-clip bg-background text-foreground antialiased">
      {!reduce && <Noise opacity={0.05} fps={12} fixed zIndex={50} blendMode="overlay" />}
      <Nav />
      <main>
        <Hero />
        <DetectionsMarquee />
        <RealNumbers />
        <Fixes />
        <Features />
        <Trust />
        <ActionSection />
        <FinalCta />
      </main>
    </div>
  );
}
