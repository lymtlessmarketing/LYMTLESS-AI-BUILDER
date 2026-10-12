import Link from "next/link";
import { HomePrompt } from "@/components/home-prompt";

const capabilities = [
  { number: "01", title: "Full-stack generation", text: "Frontend, backend, database, auth, storage, and functions." },
  { number: "02", title: "Conversational editing", text: "Refine features, logic, and design without rebuilding from scratch." },
  { number: "03", title: "Production workflow", text: "GitHub source control, isolated builds, testing, repair, and deployment." },
];

export default function Home() {
  return (
    <main className="public-shell">
      <div className="public-grid" aria-hidden="true" />
      <div className="public-glow public-glow-one" aria-hidden="true" />
      <div className="public-glow public-glow-two" aria-hidden="true" />

      <header className="public-nav">
        <Link href="/" className="brand-lockup" aria-label="LYMTLESS AI BUILDER home">
          <span className="brand-mark">L</span>
          <span className="brand-copy">
            <strong>LYMTLESS</strong>
            <small>AI BUILDER</small>
          </span>
        </Link>

        <div className="nav-actions">
          <a className="nav-link" href="#capabilities">Capabilities</a>
          <Link className="nav-signin" href="/login">Sign in</Link>
        </div>
      </header>

      <section className="premium-hero">
        <div className="hero-kicker">
          <span className="kicker-dot" />
          AI SOFTWARE CREATION PLATFORM
        </div>

        <h1>
          Build software at the
          <span className="headline-accent"> speed of thought.</span>
        </h1>

        <p className="hero-subtitle">
          Describe what you want. LYMTLESS architects the product, writes the code,
          connects the backend, tests it, and gets it ready to ship.
        </p>

        <div className="hero-command" id="builder">
          <HomePrompt />
        </div>

        <div className="platform-row" aria-label="Platform stack">
          <span>REACT</span>
          <i />
          <span>SUPABASE</span>
          <i />
          <span>GITHUB</span>
          <i />
          <span>VERCEL</span>
        </div>
      </section>

      <section className="capabilities-section" id="capabilities">
        <div className="section-heading">
          <span>ONE WORKSPACE</span>
          <h2>From idea to working application.</h2>
        </div>

        <div className="capability-grid">
          {capabilities.map((item) => (
            <article className="capability-card" key={item.number}>
              <div className="capability-number">{item.number}</div>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
