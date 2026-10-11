import Link from "next/link";
import { HomePrompt } from "@/components/home-prompt";

export default function Home() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">LYMTLESS AI BUILDER</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="badge">MVP FOUNDATION</span>
          <Link className="secondary-btn" href="/login">Sign in</Link>
        </div>
      </header>
      <div className="container">
        <section className="hero">
          <div>
            <div className="eyebrow">DESCRIBE IT. BUILD IT. SHIP IT.</div>
            <h1>Turn plain English into working software.</h1>
            <p>Generate full-stack applications with UI, database architecture, authentication, permissions, storage, integrations, versioning, and deployment workflows from one conversational workspace.</p>
            <div className="feature-grid">
              <div className="card feature"><strong>Full-stack generation</strong><span>Frontend, data model, auth, storage, functions, and integrations.</span></div>
              <div className="card feature"><strong>Conversational iteration</strong><span>Refine features and design without rebuilding the entire application.</span></div>
              <div className="card feature"><strong>Own the code</strong><span>GitHub becomes the durable source of truth for generated projects.</span></div>
            </div>
          </div>
          <HomePrompt />
        </section>
      </div>
    </main>
  );
}
