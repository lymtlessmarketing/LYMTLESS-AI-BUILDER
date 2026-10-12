import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WorkspaceSignOut } from "@/components/workspace-sign-out";
import styles from "./workspace.module.css";

export default async function WorkspacePage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;

  if (!user) redirect("/login");

  const { data: projects } = await supabase
    .from("projects")
    .select("id,name,description,status,created_at,updated_at")
    .order("updated_at", { ascending: false });

  const items = projects ?? [];

  return (
    <main className={styles.shell}>
      <header className={styles.nav}>
        <Link href="/" className={styles.brand}>
          <span className={styles.mark}>L</span>
          <span>
            <strong>LYMTLESS</strong>
            <small>AI BUILDER</small>
          </span>
        </Link>

        <div className={styles.navCenter} aria-hidden="true">
          <span>PROJECTS</span><i />
          <span>VERSIONS</span><i />
          <span>DEPLOY</span>
        </div>

        <WorkspaceSignOut className={styles.signOut} />
      </header>

      <section className={styles.hero}>
        <div>
          <span className={styles.overline}>PRIVATE WORKSPACE / AUTHENTICATED</span>
          <h1>Your build room.</h1>
          <p>
            Resume an existing application or start something new. Every project stays connected to its
            source, versions, database, sandbox history, and deployment path.
          </p>
        </div>
        <div className={styles.identity}>
          <span>ACTIVE SESSION</span>
          <strong>{user.email}</strong>
          <small>{items.length} {items.length === 1 ? "PROJECT" : "PROJECTS"}</small>
        </div>
      </section>

      <section className={styles.commandBand}>
        <div>
          <span>NEW BUILD</span>
          <h2>What are we making next?</h2>
        </div>
        <Link href="/#builder" className={styles.primaryAction}>START A NEW APP ↗</Link>
      </section>

      <section className={styles.projectsSection}>
        <div className={styles.sectionHead}>
          <span>YOUR APPLICATIONS</span>
          <small>{String(items.length).padStart(2, "0")} TOTAL</small>
        </div>

        {items.length ? (
          <div className={styles.projectGrid}>
            {items.map((project, index) => (
              <Link href={`/builder/${project.id}`} className={styles.projectCard} key={project.id}>
                <div className={styles.cardTop}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <small>{String(project.status ?? "draft").toUpperCase()}</small>
                </div>
                <h3>{project.name}</h3>
                <p>{project.description || "Full-stack LYMTLESS application workspace."}</p>
                <div className={styles.cardBottom}>
                  <span>UPDATED {new Date(project.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase()}</span>
                  <b>OPEN BUILD ↗</b>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className={styles.emptyState}>
            <span>NO BUILDS YET</span>
            <h3>Your first project starts with one sentence.</h3>
            <p>Describe the application on the homepage and LYMTLESS will create the project workspace automatically.</p>
            <Link href="/#builder" className={styles.secondaryAction}>DESCRIBE YOUR FIRST APP ↗</Link>
          </div>
        )}
      </section>

      <footer className={styles.footer}>
        <span>LYMTLESS AI BUILDER / PRIVATE WORKSPACE</span>
        <Link href="/">RETURN TO HOME ↗</Link>
      </footer>
    </main>
  );
}
