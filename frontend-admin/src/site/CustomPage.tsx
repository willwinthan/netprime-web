import React, { useEffect, useState } from "react";
import { publicGet } from "../components/site/PublicSections";
import { PageBlocks } from "../components/builder/PageBlocks";
import type { PageBlock } from "../components/builder/blocks";
import { localized, useI18n } from "../i18n";
import { Link, usePageMeta } from "./router";

/** Published page from the website builder, served at /p/:slug. Drafts are never returned by the API. */
interface PublicPage {
  slug: string; title: string; title_en: string | null; seo_title: string | null; seo_description: string | null;
  og_image_url: string | null; blocks: PageBlock[]; blocks_en: PageBlock[] | null;
}

export const CustomPage: React.FC<{ slug: string }> = ({ slug }) => {
  const { lang, t } = useI18n();
  const [page, setPage] = useState<PublicPage | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPage(undefined);
    setError(null);
    publicGet<{ page: PublicPage }>(`/website/pages/${encodeURIComponent(slug)}`)
      .then(data => { if (alive) setPage(data.page); })
      .catch(err => { if (alive) { setPage(null); setError(err.message); } });
    return () => { alive = false; };
  }, [slug]);

  const title = page ? localized(lang, page.title, page.title_en) : null;
  usePageMeta(page === null ? t("notFound.title") : page ? (page.seo_title || title) : null, page?.seo_description);

  if (page === undefined) return <div className="ps-container" style={{ padding: "72px 24px" }}><p className="ps-muted">{t("page.loading")}</p></div>;
  if (!page) {
    return (
      <div className="ps-container" style={{ padding: "72px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 32 }}>{t("notFound.title")}</h1>
        <p className="ps-muted">{error && !/ไม่พบ/.test(error) ? t("page.loadError") : t("notFound.text")}</p>
        <Link to="/" className="ps-btn ps-btn-primary" style={{ marginTop: 12 }}>{t("notFound.home")}</Link>
      </div>
    );
  }
  const blocks = lang === "en" && page.blocks_en?.length ? page.blocks_en : page.blocks;
  // Pages that do not start with a hero still get a visible title for screen readers and SEO.
  const startsWithHero = blocks[0]?.type === "hero";
  return (
    <article>
      {!startsWithHero && (
        <section className="ps-page-head">
          <div className="ps-container ps-page-head-inner"><div><h1>{title}</h1></div></div>
        </section>
      )}
      <PageBlocks blocks={blocks} />
    </article>
  );
};

export default CustomPage;
