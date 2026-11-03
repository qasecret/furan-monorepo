import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";

import { sections, steps, trustFacts } from "../landing";

import styles from "./index.module.css";

const REPO = "https://github.com/qasecret/furan-monorepo";

/**
 * The portal's home page: a short case for Furan first (people deciding
 * whether to adopt it), then routes into the docs (people already running it).
 * The words and links live in src/landing.ts. The overview doc
 * (docs/README.md) stays at /overview for GitHub readers.
 */
export default function Home(): ReactNode {
  return (
    <Layout
      title="Self-hosted visual testing"
      description="Self-hosted visual testing. Furan catches visual regressions by comparing the screenshots your tests take against approved baselines and putting every change in front of a reviewer, on your own servers."
    >
      <main>
        <header className={styles.hero}>
          <div className={`container ${styles.heroInner}`}>
            <div>
              <p className={styles.eyebrow}>Self-hosted · Apache-2.0</p>
              <h1 className={styles.title}>Visual testing you host yourself</h1>
              <p className={styles.lede}>
                Furan compares every screenshot your tests take against an
                approved baseline and puts each change in front of a reviewer.
                It runs on your servers, so your screenshots never leave them.
              </p>
              <div className={styles.actions}>
                <Link
                  className="button button--primary button--lg"
                  to="/getting-started/install"
                >
                  Get started
                </Link>
                <Link
                  className="button button--secondary button--outline button--lg"
                  href={REPO}
                >
                  View on GitHub
                </Link>
              </div>
            </div>
            <Screenshot
              src="/img/demo-diff.png"
              alt="The Furan diff viewer: a baseline and the current screenshot side by side, with the changed regions highlighted and Approve and Reject buttons."
            />
          </div>
        </header>

        <section className={styles.band} aria-labelledby="trust">
          <div className="container">
            <h2 id="trust" className={styles.sectionTitle}>
              Built for teams that keep their data in-house
            </h2>
            <ul className={styles.trustGrid}>
              {trustFacts.map((fact) => (
                <li key={fact.title}>
                  <Link className={styles.trustItem} to={fact.to}>
                    <span className={styles.trustTitle}>{fact.title}</span>
                    <span className={styles.muted}>{fact.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="how">
          <div className={`container ${styles.how}`}>
            <div>
              <h2 id="how" className={styles.sectionTitle}>
                How it works
              </h2>
              <ol className={styles.steps}>
                {steps.map((step, i) => (
                  <li key={step.title} className={styles.step}>
                    <span className={styles.stepNumber} aria-hidden="true">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <h3 className={styles.stepTitle}>{step.title}</h3>
                      <p className={styles.muted}>{step.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <Screenshot
              src="/img/demo-review.png"
              lazy
              alt="A batch in the Furan dashboard: recent batch runs on the left, and the unresolved pricing test with its screenshot on the right."
            />
          </div>
        </section>

        <section className={styles.band} aria-labelledby="docs">
          <div className="container">
            <h2 id="docs" className={styles.sectionTitle}>
              Find your way around
            </h2>
            <div className={styles.cards}>
              {sections.map((section) => (
                <div key={section.title} className={styles.card}>
                  <h3 className={styles.cardTitle}>{section.title}</h3>
                  <p className={styles.muted}>{section.summary}</p>
                  <ul className={styles.cardLinks}>
                    {section.links.map((link) => (
                      <li key={link.doc}>
                        <Link to={`/${link.doc}`}>{link.label}</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}

// The screenshots in static/img are copies of the README's "See it in action"
// images (docs/images/demo-0{2,3}-*.png); TypeScript can't type an image
// import from outside the site, so they are served as static files.
function Screenshot({
  src,
  alt,
  lazy = false,
}: {
  src: string;
  alt: string;
  /** Only below the fold: the hero's image is the first thing on screen. */
  lazy?: boolean;
}): ReactNode {
  return (
    <figure className={styles.frame}>
      <div className={styles.frameBar} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <img
        src={useBaseUrl(src)}
        alt={alt}
        width={1440}
        height={900}
        loading={lazy ? "lazy" : "eager"}
      />
    </figure>
  );
}
