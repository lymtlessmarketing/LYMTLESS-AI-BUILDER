import Link from "next/link";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="site-page-shell">
      <header className="site-page-nav">
        <Link href="/" className="site-page-brand" aria-label="LYMTLESS AI BUILDER home">
          <span className="site-page-mark">L</span>
          <span className="site-page-brand-copy">
            <strong>LYMTLESS</strong>
            <small>AI BUILDER</small>
          </span>
        </Link>

        <div className="site-page-nav-center" aria-hidden="true">
          <span>ARCHITECT</span><i />
          <span>BUILD</span><i />
          <span>VERIFY</span>
        </div>

        <Link href="/" className="site-page-back">BACK TO HOME ↗</Link>
      </header>

      <section className="site-auth-stage">
        <div className="site-auth-copy">
          <div className="site-auth-overline">PRIVATE BUILD WORKSPACE / SECURE ACCESS</div>
          <h1>
            <span>Return to the</span>
            <span>build room.</span>
            <em>Keep creating.</em>
          </h1>
          <p>
            Sign in to continue building, refining, testing, and deploying your applications inside the
            LYMTLESS engineering workspace.
          </p>

          <div className="site-auth-proof" aria-label="Platform features">
            <div><span>01</span><strong>Architecture</strong><small>Structured before code</small></div>
            <div><span>02</span><strong>Sandbox</strong><small>Built and verified in isolation</small></div>
            <div><span>03</span><strong>Ownership</strong><small>Versioned source stays yours</small></div>
          </div>
        </div>

        <div className="site-auth-form-wrap">
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
