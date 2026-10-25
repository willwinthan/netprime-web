import React, { useState } from "react";
import { BlockRenderer } from "../../site/BlockRenderer";
import { Markdown, parseMarkdown, safeHref, safeImage } from "../../site/Markdown";
import { Link } from "../../site/router";
import { Course, CourseCard, CourseDialog } from "../../site/shared";
import { useI18n } from "../../i18n";
import { LeadFormEmbed } from "./LeadFormEmbed";
import { PageBlock, videoEmbed } from "./blocks";
import "./builder.css";

/**
 * Renders page-builder blocks on the public site (inside .ps) and in the console preview.
 * Text is rendered as text, Markdown through the site's Markdown component, rich text through
 * BlockRenderer, links through safeHref and images through safeImage. No HTML is ever injected.
 */

const SmartLink: React.FC<{ href: string; className?: string; children: React.ReactNode }> = ({ href, className, children }) => {
  const safe = safeHref(href);
  if (!safe) return <span className={className}>{children}</span>;
  const external = /^(https?:|mailto:)/.test(safe) && !safe.startsWith(window.location.origin);
  return external
    ? <a href={safe} className={className} target="_blank" rel="noopener noreferrer">{children}</a>
    : <Link to={safe} className={className}>{children}</Link>;
};

const Img: React.FC<{ src: string | null | undefined; alt?: string | null; className?: string }> = ({ src, alt, className }) => {
  const safe = src ? safeImage(src) : null;
  return safe ? <img src={safe} alt={alt || ""} className={className} loading="lazy" /> : null;
};

const Text: React.FC<{ source: string | null | undefined }> = ({ source }) => source ? <div className="ps-pb-text"><Markdown blocks={parseMarkdown(source)} /></div> : null;

const Heading: React.FC<{ text: string | null | undefined }> = ({ text }) => text ? <div className="ps-section-head"><h2>{text}</h2></div> : null;

const CourseGrid: React.FC<{ courses: Course[]; empty: string }> = ({ courses, empty }) => {
  const [open, setOpen] = useState<Course | null>(null);
  if (!courses.length) return <div className="ps-card ps-empty">{empty}</div>;
  return (
    <>
      <div className="ps-grid">{courses.map(c => <CourseCard key={c.id} course={c} onOpen={() => setOpen(c)} />)}</div>
      {open && <CourseDialog course={open} onClose={() => setOpen(null)} />}
    </>
  );
};

const Block: React.FC<{ block: PageBlock; preview?: boolean }> = ({ block, preview }) => {
  const { t } = useI18n();
  switch (block.type) {
    case "hero": {
      const image = block.image_url ? safeImage(block.image_url) : null;
      return (
        <section className={`ps-pb-hero ps-pb-tone-${block.tone || "light"} ps-pb-align-${block.align || "left"}${image ? " has-image" : ""}`}>
          <div className="ps-container ps-pb-hero-inner">
            <div className="ps-pb-hero-copy">
              <h1>{block.heading}</h1>
              {block.subheading && <p className="ps-lead">{block.subheading}</p>}
              {block.cta_label && block.cta_href && <SmartLink href={block.cta_href} className="ps-btn ps-btn-primary ps-btn-lg">{block.cta_label}</SmartLink>}
            </div>
            {image && <div className="ps-pb-hero-art"><img src={image} alt="" /></div>}
          </div>
        </section>
      );
    }
    case "richtext":
      return block.doc?.length ? <section className="ps-container ps-pb-section"><div className="ps-prose ps-pb-narrow"><BlockRenderer blocks={block.doc} /></div></section> : null;
    case "image": {
      const img = <Img src={block.url} alt={block.alt} />;
      if (!img) return null;
      return (
        <section className={`ps-pb-section ps-pb-image ps-pb-width-${block.width || "wide"}`}>
          <figure className={block.width === "full" ? "" : "ps-container"}>
            {block.link ? <SmartLink href={block.link}>{img}</SmartLink> : img}
            {block.caption && <figcaption className="ps-muted">{block.caption}</figcaption>}
          </figure>
        </section>
      );
    }
    case "image_text":
      return (
        <section className="ps-container ps-pb-section">
          <div className={`ps-pb-split ps-pb-split-${block.image_side || "left"}`}>
            <div className="ps-pb-split-media"><Img src={block.image_url} alt={block.alt} /></div>
            <div className="ps-pb-split-copy">
              {block.heading && <h2>{block.heading}</h2>}
              <Text source={block.text} />
              {block.cta_label && block.cta_href && <SmartLink href={block.cta_href} className="ps-btn ps-btn-primary">{block.cta_label}</SmartLink>}
            </div>
          </div>
        </section>
      );
    case "features":
      return (
        <section className="ps-container ps-pb-section">
          <Heading text={block.heading} />
          {block.intro && <p className="ps-lead ps-pb-intro">{block.intro}</p>}
          <div className="ps-pb-cols" style={{ ["--ps-pb-cols" as string]: String(block.columns || 3) }}>
            {block.items.map((item, i) => {
              const body = <>
                <Img src={item.image_url} className="ps-pb-feature-img" />
                <strong>{item.title}</strong>
                {item.text && <span className="ps-muted">{item.text}</span>}
              </>;
              return item.link
                ? <SmartLink key={i} href={item.link} className="ps-card ps-pb-feature">{body}</SmartLink>
                : <div key={i} className="ps-card ps-pb-feature">{body}</div>;
            })}
          </div>
        </section>
      );
    case "courses":
      return (
        <section className="ps-container ps-pb-section">
          <Heading text={block.heading} />
          <CourseGrid courses={(block.courses || []) as Course[]} empty={t("page.noCourses")} />
        </section>
      );
    case "testimonials":
      return (
        <section className="ps-container ps-pb-section">
          <Heading text={block.heading} />
          <div className="ps-pb-cols" style={{ ["--ps-pb-cols" as string]: String(Math.min(3, Math.max(1, block.items.length))) }}>
            {block.items.map((item, i) => (
              <figure key={i} className="ps-card ps-pb-quote">
                <blockquote>“{item.quote}”</blockquote>
                <figcaption>
                  <Img src={item.avatar_url} className="ps-pb-avatar" />
                  <span><strong>{item.name}</strong>{item.role && <small className="ps-muted">{item.role}</small>}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      );
    case "faq":
      return (
        <section className="ps-container ps-pb-section ps-pb-narrow">
          <Heading text={block.heading || t("page.faq")} />
          <div className="ps-faq">
            {block.items.map((item, i) => (
              <details key={i}><summary>{item.q}</summary><Text source={item.a} /></details>
            ))}
          </div>
        </section>
      );
    case "cta":
      return (
        <section className="ps-container ps-pb-section">
          <div className={`ps-pb-cta ps-pb-cta-${block.style || "primary"}`}>
            <div>
              {block.heading && <h2>{block.heading}</h2>}
              {block.text && <p>{block.text}</p>}
            </div>
            <SmartLink href={block.href} className={`ps-btn ps-btn-lg ${block.style === "dark" ? "ps-btn-primary" : block.style === "outline" ? "ps-btn-outline" : "ps-btn-dark"}`}>{block.label}</SmartLink>
          </div>
        </section>
      );
    case "video": {
      const embed = videoEmbed(block.url);
      if (!embed) return preview ? <div className="ps-container ps-pb-section"><div className="ps-pb-placeholder">ลิงก์วิดีโอไม่ถูกต้อง (รองรับ YouTube/Vimeo)</div></div> : null;
      return (
        <section className="ps-container ps-pb-section ps-pb-narrow">
          <div className="ps-pb-video">
            <iframe src={embed.src} title={block.title || t("page.video")} loading="lazy" allowFullScreen
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" />
          </div>
          {block.title && <p className="ps-muted ps-pb-caption">{block.title}</p>}
        </section>
      );
    }
    case "lead_form":
      return (
        <section className="ps-container ps-pb-section ps-pb-narrow">
          <Heading text={block.heading} />
          <LeadFormEmbed formId={block.form_id} preview={preview} />
        </section>
      );
    default:
      return null;
  }
};

export const PageBlocks: React.FC<{ blocks: PageBlock[]; preview?: boolean }> = ({ blocks, preview }) => (
  <div className="ps-pb">{blocks.map(b => <Block key={b.id} block={b} preview={preview} />)}</div>
);
