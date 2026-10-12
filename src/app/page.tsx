import Link from "next/link";
import { HomePrompt } from "@/components/home-prompt";
import { LandingMotion } from "@/components/landing-motion";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const pillars = [
  { overline: "PILLAR I", title: "The Architect", text: "Turns a raw idea into product structure, data models, roles, workflows, and a build plan." },
  { overline: "PILLAR II", title: "The Builder", text: "Generates the interface, backend, database, authentication, storage, and application logic." },
  { overline: "PILLAR III", title: "The Operator", text: "Runs isolated builds, reads failures, repairs code, and keeps the application moving forward." },
  { overline: "PILLAR IV", title: "The Editor", text: "Refines features and design conversationally without throwing away the application you already built." },
  { overline: "PILLAR V", title: "The Owner", text: "Keeps the source, versions, infrastructure, and deployment path under your control." },
];

const standards = [
  ["01 / THINK", "Architecture first", "Every build begins with structure: product intent, permissions, data, dependencies, and execution path."],
  ["02 / MAKE", "Full-stack by default", "The interface and the infrastructure are treated as one product, not separate handoffs."],
  ["03 / PROVE", "Build before belief", "Generated code is compiled and tested in isolation before it earns a live preview."],
  ["04 / OWN", "Your source stays yours", "GitHub, version history, and deployable code remain part of the product from the beginning."],
];

const paths = [
  { eyebrow: "PATH I", title: "The Launch", sub: "From idea to first working product.", points: ["Architecture plan", "Full-stack generation", "Database + auth", "Live sandbox preview"], cta: "START A BUILD" },
  { eyebrow: "PATH II", title: "The Studio", sub: "Build, refine, and keep evolving.", points: ["Conversational edits", "Version history", "Visual refinement", "Repair + rebuild loop"], cta: "ENTER THE STUDIO" },
  { eyebrow: "PATH III", title: "The System", sub: "A production workflow you control.", points: ["GitHub source", "Supabase backend", "Vercel deployment", "Real application ownership"], cta: "BUILD THE SYSTEM", featured: true },
];

export default async function Home() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const signedIn = Boolean(authData.user);
  const accountHref = signedIn ? "/workspace" : "/login";

  return (
    <main className="cr-shell">
      <LandingMotion />
      <header className="cr-nav">
        <Link href="/" className="cr-brand">LYMTLESS <em>AI BUILDER</em></Link>
        <nav className="cr-nav-links" aria-label="Primary navigation">
          <a href="#builder">BUILD</a>
          <a href="#pillars">SYSTEM</a>
          <a href="#standards">STANDARD</a>
          <a href="#paths">ACCESS</a>
        </nav>
        <Link href={accountHref} className="cr-nav-cta">{signedIn ? "WORKSPACE" : "SIGN IN"} <span>↗</span></Link>
      </header>

      <section className="cr-hero">
        <div className="cr-kicker">A PRIVATE AI SOFTWARE ENGINE FOR BUILDING WHAT DOESN&apos;T EXIST YET</div>
        <h1>
          <span>Some ideas stay</span>
          <span>in your head.</span>
          <em>These ones</em>
          <em>become real.</em>
        </h1>
        <p className="cr-hero-copy">
          LYMTLESS turns plain language into working software — architecture, interface, database,
          authentication, logic, testing, repair, and deployment in one connected build system.
        </p>
        <div className="cr-hero-actions">
          <a href="#builder" className="cr-button cr-button-solid">BUILD AN APP</a>
          <a href="#pillars" className="cr-button cr-button-outline">SEE THE SYSTEM</a>
          <Link href={accountHref} className="cr-button cr-button-ghost">{signedIn ? "OPEN WORKSPACE" : "SIGN IN"}</Link>
        </div>
      </section>

      <div className="cr-index-strip" aria-hidden="true">
        <span>ARCHITECTURE</span><i />
        <span>DATABASE</span><i />
        <span>AUTH</span><i />
        <span>INTERFACE</span><i />
        <span>LOGIC</span><i />
        <span>TESTING</span><i />
        <span>DEPLOYMENT</span>
      </div>

      <section className="cr-quote-band">
        <blockquote>
          For the first time, the distance between <em>describing</em> an application and
          <em> operating</em> one can be measured in a single workflow.
        </blockquote>
        <span>LYMTLESS / BUILD WITHOUT THE HANDOFF</span>
      </section>

      <section className="cr-story">
        <div className="cr-story-inner">
          <span className="cr-overline">THE PREMISE</span>
          <h2>Every serious product used to require a room full of specialists.</h2>
          <p>
            Product strategy, interface design, databases, authentication, backend logic, infrastructure,
            testing, and deployment traditionally moved through separate hands. LYMTLESS compresses that
            chain into one intelligent workspace while keeping the underlying code and infrastructure real.
          </p>
          <p>
            You describe the outcome. The system plans the product, generates the application, stores each
            version, executes it in isolation, reads the failures, repairs what broke, and presents the result.
          </p>
          <a href="#builder" className="cr-inline-link">START WITH AN IDEA <span>↗</span></a>
        </div>
      </section>

      <section className="cr-builder-section" id="builder">
        <div className="cr-builder-heading">
          <span className="cr-overline">THE ENGINE</span>
          <h2>Describe it. Then watch it become software.</h2>
        </div>
        <HomePrompt />
      </section>

      <section className="cr-pillars" id="pillars">
        <div className="cr-section-head">
          <span className="cr-overline">THE SYSTEM</span>
          <h2>Five pillars. One build room.</h2>
        </div>
        <div className="cr-pillar-grid">
          {pillars.map((pillar) => (
            <article className="cr-pillar-card" key={pillar.overline}>
              <span>{pillar.overline}</span>
              <h3>{pillar.title}</h3>
              <p>{pillar.text}</p>
              <small>LYMTLESS ENGINE ↗</small>
            </article>
          ))}
          <article className="cr-pillar-card cr-pillar-quote">
            <p>“The interface is only the surface. The real product is the system underneath it.”</p>
            <small>LYMTLESS PRINCIPLE</small>
          </article>
        </div>
      </section>

      <section className="cr-stages">
        <div className="cr-stages-inner">
          <span className="cr-overline">EXECUTION / BUILD & VERIFY</span>
          <h2>Two stages. <em>One loop.</em></h2>
          <p>
            First, LYMTLESS architects and generates the application. Then it runs the result, reads compiler
            and runtime failures, repairs the affected files, versions the changes, and tries again.
          </p>
          <a href="#builder" className="cr-button cr-button-solid">RUN A BUILD</a>
        </div>
      </section>

      <section className="cr-stats" aria-label="Platform statistics">
        <div><strong>1</strong><span>CONNECTED BUILD WORKFLOW</span></div>
        <div><strong>4</strong><span>CORE INFRASTRUCTURE LAYERS</span></div>
        <div><strong>2</strong><span>SELF-REPAIR RETRIES</span></div>
        <div><strong>∞</strong><span>PRODUCTS YOU CAN DESCRIBE</span></div>
      </section>

      <section className="cr-standards" id="standards">
        <div className="cr-section-head">
          <span className="cr-overline">THE STANDARD</span>
          <h2>Four rules. One standard.</h2>
        </div>
        <div className="cr-standard-grid">
          {standards.map(([eyebrow, title, text]) => (
            <article key={eyebrow}>
              <span>{eyebrow}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="cr-paths" id="paths">
        <span className="cr-overline">ACCESS / CHOOSE YOUR PATH</span>
        <h2>Three doors. Each one builds.</h2>
        <div className="cr-path-grid">
          {paths.map((path) => (
            <article className={`cr-path-card ${path.featured ? "featured" : ""}`} key={path.eyebrow}>
              <span>{path.eyebrow}</span>
              <h3>{path.title}</h3>
              <p>{path.sub}</p>
              <ul>
                {path.points.map((point) => <li key={point}>{point}</li>)}
              </ul>
              <a href="#builder">{path.cta} <span>↗</span></a>
            </article>
          ))}
        </div>
      </section>

      <section className="cr-testimonial-band">
        <blockquote>
          “You should not have to learn every tool in the stack just to turn a clear business idea into a real application.”
        </blockquote>
        <span>THE LYMTLESS THESIS</span>
      </section>

      <section className="cr-invite">
        <span className="cr-overline">YOUR NEXT BUILD</span>
        <h2>Request your first application.</h2>
        <p>Start with one sentence. The system will take it from there.</p>
        <a href="#builder" className="cr-button cr-button-solid">BUILD WITH LYMTLESS</a>
      </section>

      <footer className="cr-footer">
        <div>
          <strong>LYMTLESS AI BUILDER</strong>
          <p>AI product engineering for full-stack applications.</p>
        </div>
        <nav>
          <a href="#builder">BUILD</a>
          <a href="#pillars">SYSTEM</a>
          <a href="#standards">STANDARD</a>
          <a href="#paths">ACCESS</a>
          <Link href={accountHref}>{signedIn ? "WORKSPACE" : "SIGN IN"}</Link>
        </nav>
        <small>© 2026 LYMTLESS</small>
      </footer>
    </main>
  );
}
