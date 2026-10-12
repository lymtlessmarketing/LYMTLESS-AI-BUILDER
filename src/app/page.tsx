import Link from "next/link";
import { HomePrompt } from "@/components/home-prompt";

const capabilities = [
  { number: "01", title: "Architect", text: "Turn intent into product structure, data models, permissions, and workflows." },
  { number: "02", title: "Build", text: "Generate frontend, backend, authentication, storage, and business logic as one system." },
  { number: "03", title: "Refine", text: "Edit the product conversationally without rebuilding the entire application." },
  { number: "04", title: "Ship", text: "Test in isolation, repair failures, version the source, and deploy with confidence." },
];

export default function Home() {
  return (
    <main className="lux-shell">
      <div className="lux-noise" aria-hidden="true" />
      <div className="lux-orbit lux-orbit-one" aria-hidden="true" />
      <div className="lux-orbit lux-orbit-two" aria-hidden="true" />

      <header className="lux-nav">
        <Link href="/" className="lux-brand" aria-label="LYMTLESS AI BUILDER home">
          <span className="lux-monogram">L</span>
          <span className="lux-brand-name">
            <strong>LYMTLESS</strong>
            <small>AI BUILDER</small>
          </span>
        </Link>

        <div className="lux-nav-center" aria-hidden="true">
          <span>AI PRODUCT ENGINEERING</span>
          <i />
          <span>EST. 2026</span>
        </div>

        <div className="lux-nav-actions">
          <a href="#system" className="lux-text-link">System</a>
          <Link href="/login" className="lux-signin">Sign in <span>↗</span></Link>
        </div>
      </header>

      <section className="lux-hero">
        <div className="lux-hero-copy">
          <div className="lux-section-label">
            <span>01</span>
            <div className="lux-hairline" />
            <strong>THE BUILDER</strong>
          </div>

          <h1>
            <span className="lux-display-line">Ideas,</span>
            <span className="lux-display-line lux-display-indent">engineered</span>
            <span className="lux-display-line lux-display-serif">without limits.</span>
          </h1>

          <p className="lux-hero-copytext">
            Describe the product. LYMTLESS handles the architecture, interface,
            database, authentication, logic, testing, repair, and deployment.
          </p>

          <div className="lux-proof-row">
            <div>
              <span className="lux-proof-index">A</span>
              <strong>Full-stack</strong>
              <small>One connected system</small>
            </div>
            <div>
              <span className="lux-proof-index">B</span>
              <strong>Agentic</strong>
              <small>Plans, builds & repairs</small>
            </div>
            <div>
              <span className="lux-proof-index">C</span>
              <strong>Yours</strong>
              <small>Real source in GitHub</small>
            </div>
          </div>
        </div>

        <div className="lux-console-stage" id="builder">
          <div className="lux-stage-caption lux-stage-caption-top">LYMTLESS ENGINE / 01</div>
          <div className="lux-stage-caption lux-stage-caption-side">NATURAL LANGUAGE → SOFTWARE</div>
          <div className="lux-console-aura" aria-hidden="true" />
          <HomePrompt />
          <div className="lux-console-footnote">
            <span>SUPABASE</span>
            <span>GITHUB</span>
            <span>VERCEL</span>
            <span>AI GATEWAY</span>
          </div>
        </div>
      </section>

      <section className="lux-system" id="system">
        <div className="lux-system-intro">
          <div className="lux-section-label">
            <span>02</span>
            <div className="lux-hairline" />
            <strong>THE SYSTEM</strong>
          </div>
          <h2>From a sentence to a working product.</h2>
          <p>Not a template generator. A software creation system with memory, code, infrastructure, and execution.</p>
        </div>

        <div className="lux-capability-grid">
          {capabilities.map((item, index) => (
            <article className={`lux-capability-card lux-capability-${index + 1}`} key={item.number}>
              <div className="lux-card-number">{item.number}</div>
              <div className="lux-card-copy">
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
              <span className="lux-card-arrow">↗</span>
            </article>
          ))}
        </div>
      </section>

      <footer className="lux-footer">
        <span>LYMTLESS AI BUILDER</span>
        <em>Build beyond the boundary.</em>
        <span>FULL-STACK AI DEVELOPMENT</span>
      </footer>
    </main>
  );
}
