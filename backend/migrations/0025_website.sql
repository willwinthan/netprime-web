-- Website builder (v0.5): custom pages at /p/:slug, certificate templates and per-course template overrides.
-- Theme/branding and header/footer menus are JSON documents in site_settings (keys 'theme' and 'nav'),
-- validated by handlers/website.ts. Needs website.design (granted to coordinators in 0017).

-- Custom pages. Editing changes the draft columns; publishing copies them into the published_* columns,
-- so visitors never see unpublished edits. blocks_* hold the validated block list (see handlers/website.ts).
CREATE TABLE IF NOT EXISTS site_pages (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    title_en TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
    blocks_json TEXT NOT NULL DEFAULT '[]',
    blocks_en_json TEXT,
    seo_title TEXT,
    seo_description TEXT,
    og_image_url TEXT,
    published_title TEXT,
    published_title_en TEXT,
    published_blocks_json TEXT,
    published_blocks_en_json TEXT,
    published_seo_json TEXT,
    show_in_nav INTEGER NOT NULL DEFAULT 0 CHECK(show_in_nav IN (0, 1)),
    show_in_footer INTEGER NOT NULL DEFAULT 0 CHECK(show_in_footer IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_site_pages_status ON site_pages(status, sort_order);

-- Certificate designs; config_json follows handlers/website.ts CertificateConfig. One row may be the default.
CREATE TABLE IF NOT EXISTS certificate_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    config_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS certificate_templates_one_default ON certificate_templates(is_default) WHERE is_default = 1;

-- Per-course override; courses without a row use the default template (or the built-in design).
CREATE TABLE IF NOT EXISTS course_certificate_templates (
    course_id TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES certificate_templates(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_course_certificate_templates_template ON course_certificate_templates(template_id);
