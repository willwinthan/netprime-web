#!/usr/bin/env python3
"""Turns saved LearnWorlds blog pages into articles.json for scripts/import-blog.mjs.

Usage: python3 scripts/blog-import/extract.py <folder of saved /blog/<slug> pages> [output.json]
Needs beautifulsoup4. The pages are public blog posts; the output holds no learner data.
"""
import glob, json, os, re, sys
from datetime import datetime, timedelta, timezone
from bs4 import BeautifulSoup, NavigableString, Tag

SITE = "https://www.netprimetraining.com"
# Most specific first: the new blog keeps one category per article.
CATEGORY_ORDER = ["Lab", "Wireless", "Routing", "Switching", "Networking"]
AUTHOR_FIXES = {"Thanaris Thakornwaramgkul": "Thanaris Thakornwarangkul"}
SKIP_CLASSES = {"lw-slider", "js-embed-wrapper", "js-video-wrapper", "learnworlds-section-overlay", "spacer-element"}
# The old template repeats the author's profile after some posts; the new page shows a byline instead.
BIO = re.compile(r"\s*Thanaris thakornwarangkul \(Nut\)\s+Tripple Cisco CCIE[\s\S]*$")
LIST_LINE = re.compile(r"^(?:(\d+[.)])|- )\s*\S")
SKIP_TAGS = {"button", "meta", "script", "style", "noscript"}
CLI = re.compile(
    r"^(\S{1,40}[#>]\s?\S*|!|end|exit|(no|ip|ipv6|interface|int|switchport|router|vlan|spanning-tree|show|sh|conf|configure|aaa|radius|radius-server|"
    r"dot1x|authentication|mab|line|enable|hostname|username|channel-group|standby|storm-control|mpls|xconnect|lisp|map-server|map-resolver|eid-table|"
    r"database-mapping|service|encapsulation|neighbor|network|description|snmp-server|switch|ping|traceroute|tacacs)\b.*)$", re.I)


def clean(text):
    return re.sub(r"[ \t ​]+", " ", text.replace("\n", " "))


class Walker:
    def __init__(self, slugs):
        self.blocks, self.buf, self.slugs = [], "", slugs

    def flush(self):
        lines = [l.strip() for l in self.buf.split("\n")]
        self.buf = ""
        run = []

        def end_run():
            plain = [l.replace("**", "") for l in run]
            if len(run) >= 3 or (len(run) == 2 and any(CLI.match(l) for l in plain)):
                self.blocks.append("```\n" + "\n".join(plain) + "\n```")
            else:
                self.blocks.extend(paragraph(l) for l in run)
            run.clear()

        for line in lines:
            if not line:
                continue
            # Thai prose never lands here, so runs of ASCII lines are configs or command output.
            if line.isascii() and "](" not in line and not re.match(r"https?://", line):
                run.append(line)
                continue
            end_run()
            self.blocks.append(paragraph(line))
        end_run()

    def inline(self, node):
        saved, self.buf = self.buf, ""
        self.walk(node, inline=True)
        text, self.buf = self.buf, saved
        return text

    def href(self, url):
        match = re.match(rf"^(?:{re.escape(SITE)}|https?://netprimetraining\.com)?/blog/([^/?#]+)", url or "")
        return f"/blog/{match.group(1)}" if match and match.group(1) in self.slugs else url

    def walk(self, node, inline=False):
        for child in node.children:
            if isinstance(child, NavigableString):
                if type(child) is NavigableString:
                    self.buf += clean(str(child))
                continue
            if not isinstance(child, Tag) or child.name in SKIP_TAGS or SKIP_CLASSES & set(child.get("class") or []):
                continue
            name = child.name
            if name == "br":
                self.buf += "\n"
            elif name == "img":
                self.flush()
                src = (child.get("src") or "").split("?")[0]
                if src:
                    self.blocks.append(f"![]({src})")
            elif name == "iframe":
                self.flush()
                src = child.get("src") or child.get("data-src") or ""
                if src:
                    video = re.search(r"youtube\.com/embed/([\w-]+)", src)
                    self.blocks.append(f"[ดูวิดีโอประกอบ]({f'https://www.youtube.com/watch?v={video.group(1)}' if video else src})")
            elif name in ("ul", "ol"):
                self.flush()
                items = [" ".join(self.inline(li).split()) for li in child.find_all("li", recursive=False)]
                marker = (lambda i: f"{i}. ") if name == "ol" else (lambda i: "- ")
                self.blocks.append("\n".join(marker(i + 1) + t for i, t in enumerate(items) if t))
            elif re.fullmatch(r"h[1-6]", name) or "learnworlds-main-text-large" in (child.get("class") or []):
                text = " ".join(self.inline(child).replace("**", "").split())
                self.flush()
                if text:
                    self.blocks.append(("### " if len(text) < 120 else "") + text)
            elif name in ("b", "strong"):
                inner = self.inline(child).replace("**", "")
                self.buf += "\n".join(f"**{l.strip()}**" if l.strip() and "*" not in l else l for l in inner.split("\n"))
            elif name == "a":
                text = self.inline(child).strip()
                href = self.href(child.get("href"))
                self.buf += f"[{text}]({href})" if text and href and "\n" not in text else text
            elif name in ("div", "p", "section", "article") and not inline:
                self.buf += "\n"
                self.walk(child)
                self.buf += "\n"
            elif name in ("div", "p"):
                self.buf += "\n"
                self.walk(child, inline=True)
                self.buf += "\n"
            else:
                self.walk(child, inline=inline)


def paragraph(line):
    """Keeps old bullets as lists and stops plain text from being read as Markdown syntax."""
    line = re.sub(r"^[•·●▪◦]\s*", "- ", line)
    line = re.sub(r"^(#+|>)\s*", "", line)
    return re.sub(r"^(https?://\S+)$", r"[\1](\1)", line)


def merge_lists(blocks):
    """Puts list lines that the old pages wrote as separate paragraphs back into one list."""
    merged = []
    for block in blocks:
        kind = LIST_LINE.match(block)
        if merged and kind and (previous := LIST_LINE.match(merged[-1].rsplit("\n", 1)[-1])) and bool(kind[1]) == bool(previous[1]):
            merged[-1] += "\n" + block
        else:
            merged.append(block)
    return merged


def page_data(html):
    """Reads the page's own metadata; the fields are not always in the same order."""
    data = {}
    for key, pattern in (("author_name", r'"(?:[^"\\]|\\.)*"'), ("image", r'"(?:[^"\\]|\\.)*"'), ("description", r'"(?:[^"\\]|\\.)*"|null'),
                         ("published", r"\d+"), ("categories", r"\[[^\]]*\]")):
        matches = re.findall(rf'"{key}":({pattern})', html)
        data[key] = json.loads(matches[-1]) if matches else None
    return data


def excerpt(blocks):
    text = " ".join(b for b in blocks if not b.startswith(("![", "```", "#", "[ดู")))
    text = re.sub(r"\*\*|\[|\]\([^)]*\)|^- ", "", text)
    text = " ".join(text.split())
    return text if len(text) <= 180 else text[:180].rsplit(" ", 1)[0] + "…"


def main(folder, output):
    paths = sorted(glob.glob(os.path.join(folder, "*.html")))
    slugs = {os.path.basename(p)[:-5] for p in paths}
    articles = []
    for path in paths:
        slug = os.path.basename(path)[:-5]
        html = open(path, encoding="utf8").read()
        data = page_data(html)
        soup = BeautifulSoup(html, "html.parser")
        title = " ".join(soup.select_one("h1.js-title").get_text().split())
        section = soup.select_one('section[data-section-id="tplColumnsLists20"]')
        walker = Walker(slugs)
        walker.walk(section)
        walker.flush()
        day = datetime.fromtimestamp(data["published"], timezone(timedelta(hours=7))).strftime("%Y-%m-%d")
        tags = data["categories"]
        author = " ".join(data["author_name"].split()).title()
        articles.append({
            "slug": slug, "title": title,
            "category": next((c for c in CATEGORY_ORDER if c in tags), tags[0] if tags else None),
            "old_categories": tags, "author_label": AUTHOR_FIXES.get(author, author),
            "excerpt": (data["description"] or "").strip() or excerpt(walker.blocks),
            "body": BIO.sub("", "\n\n".join(merge_lists(walker.blocks))), "cover_url": data["image"].split("?")[0],
            "published_at": day, "status": "published",
        })
    articles.sort(key=lambda a: a["published_at"], reverse=True)
    json.dump(articles, open(output, "w", encoding="utf8"), ensure_ascii=False, indent=1)
    print(f"{len(articles)} articles -> {output}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "scripts/blog-import/articles.json")
