"use client";

import { useEffect } from "react";

export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".cr-shell");
    if (!root) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      root.classList.add("cr-motion-ready", "cr-reduced-motion");
      return;
    }

    const revealTargets = Array.from(
      root.querySelectorAll<HTMLElement>(
        ".cr-quote-band, .cr-story, .cr-builder-section, .cr-pillars, .cr-stages, .cr-stats, .cr-standards, .cr-paths, .cr-testimonial-band, .cr-invite, .cr-footer, .cr-pillar-card, .cr-standard-grid article, .cr-path-card"
      )
    );

    revealTargets.forEach((el, index) => {
      el.classList.add("cr-reveal-ready");
      el.style.setProperty("--cr-reveal-delay", `${Math.min((index % 6) * 55, 275)}ms`);
    });

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).classList.add("cr-in-view");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -7% 0px" }
    );

    revealTargets.forEach((el) => observer.observe(el));

    let raf = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        root.style.setProperty("--cr-mx", `${event.clientX}px`);
        root.style.setProperty("--cr-my", `${event.clientY}px`);
      });
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    requestAnimationFrame(() => root.classList.add("cr-motion-ready"));

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  return null;
}
