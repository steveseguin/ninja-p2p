#!/usr/bin/env node
// Builds the GitHub Pages site in docs/: copies the dashboard and renders the
// Markdown guides into styled HTML pages. The Markdown files stay the source
// of truth; rerun this (npm run sync:docs) after editing any of them.
//
//   node scripts/build-site.mjs [--root <repo>] [--out <dir>]

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(argValue("--root") ?? path.join(scriptDir, ".."));
const outDir = path.resolve(argValue("--out") ?? path.join(root, "docs"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const REPO = "https://github.com/steveseguin/ninja-p2p";
const SITE = "https://steveseguin.github.io/ninja-p2p/";

const PAGES = [
  {
    src: "README.md", out: "guide.html", title: "Guide", group: "Start", icon: "book",
    description: "Install ninja-p2p, start two agents, and learn the whole CLI: wake hooks, shared folders, swarms, the dashboard, and the library.",
  },
  {
    src: "docs/operations.md", out: "operations.html", title: "Operations & recovery", group: "Start", icon: "wrench",
    description: "Upgrade without losing local work, inspect mail before consuming it, recover files, and diagnose wake hooks.",
  },
  {
    src: "docs/security.md", out: "security.html", title: "Security model", group: "Concepts", icon: "shield",
    description: "What ninja-p2p protects, what it does not, and the decisions you make when you start a sidecar.",
  },
  {
    src: "docs/protocol-and-reliability.md", out: "protocol-and-reliability.html", title: "Protocol & reliability", group: "Concepts", icon: "layers",
    description: "Layers, delivery semantics, the swarm transfer design, and what was measured and deliberately not built.",
  },
  {
    src: "docs/social-stream-bridge.md", out: "social-stream-bridge.html", title: "Social Stream bridge", group: "Integrations", icon: "radio",
    description: "Bring live Twitch, YouTube, Kick, and other chat into a room as shared input for an agent team.",
  },
  {
    src: "docs/cloud-connections.md", out: "cloud-connections.html", title: "Cloud connections", group: "Integrations", icon: "globe",
    description: "Connect agents that cannot run WebRTC through an encrypted HTTPS relay or a hosted mailbox.",
  },
  {
    src: "CHANGELOG.md", out: "changelog.html", title: "Changelog", group: "Project", icon: "list",
    description: "Grouped release notes for every ninja-p2p version.",
  },
  {
    src: "docs/recovery-validation.md", out: "recovery-validation.html", title: "Recovery validation", group: "Project", icon: "rotate",
    description: "How interrupted and relayed transfers were tested, and what the runs showed.",
  },
  {
    src: "docs/releases.md", out: "releases.html", title: "Release guide", group: "Project", icon: "package",
    description: "Maintainer checks and the publishing workflow.",
  },
  {
    src: "docs/north-star.md", out: "north-star.html", title: "Product direction", group: "Project", icon: "network",
    description: "Where ninja-p2p is headed: shared rooms for people and independent agents across machines and changing networks.",
  },
  {
    src: "docs/sdk-wishlist.md", out: "sdk-wishlist.html", title: "SDK wishlist", group: "Project", icon: "plus",
    description: "Changes to the VDO.Ninja SDK that would simplify or strengthen ninja-p2p.",
  },
].filter((page) => existsSync(path.join(root, page.src)));

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const icon = (name, extra = "") =>
  `<svg class="icon${extra ? ` ${extra}` : ""}" aria-hidden="true"><use href="assets/icons.svg#${name}"/></svg>`;

// GitHub's heading anchors, so links written for github.com keep working here.
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

// Point repository-relative links at the generated page, a published asset,
// or the file on GitHub.
function rewriteUrl(url, page) {
  if (!url || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) return url;
  const [pathPart, hash] = url.split("#");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page.src), pathPart));
  const suffix = hash ? `#${hash}` : "";
  const target = PAGES.find((candidate) => candidate.src === resolved);
  if (target) return target.out + suffix;
  if (resolved.startsWith("docs/") && !resolved.endsWith(".md") && existsSync(path.join(root, resolved))) {
    return resolved.slice("docs/".length) + suffix;
  }
  return `${REPO}/blob/main/${resolved}${suffix}`;
}

function highlight(code, lang) {
  const escaped = escapeHtml(code);
  if (!/^(?:bash|sh|shell|powershell|ps1)$/i.test(lang)) return escaped;
  return escaped
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return `<span class="tok-c">${line}</span>`;
      return line.replace(/(\s{2,})(#\s.*)$/, '$1<span class="tok-c">$2</span>');
    })
    .join("\n");
}

function renderMarkdown(source, page) {
  const headings = [];
  const used = new Map();
  const marked = new Marked({ gfm: true });

  marked.use({
    walkTokens(token) {
      if (token.type === "link" || token.type === "image") token.href = rewriteUrl(token.href, page);
      if (token.type === "html") {
        token.text = token.text.replace(/\b(href|src)="([^"]*)"/g, (match, attr, url) => `${attr}="${rewriteUrl(url, page)}"`);
      }
    },
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        let id = slugify(text);
        const seen = used.get(id) ?? 0;
        used.set(id, seen + 1);
        if (seen) id = `${id}-${seen}`;
        if (depth === 2 || depth === 3) headings.push({ id, depth, html: inner.replace(/<[^>]+>/g, "") });
        const anchor = depth <= 3 ? `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : "";
        return `<h${depth} id="${id}">${inner}${anchor}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const language = (lang ?? "").split(/\s/)[0];
        const label = language && language !== "text" ? `<span class="lang">${escapeHtml(language)}</span>` : "";
        return `<div class="codeblock">${label}<pre><code>${highlight(text, language)}</code></pre>`
          + `<button class="copy-btn" type="button" aria-label="Copy code">${icon("copy", "i-copy")}${icon("check", "i-check")}</button></div>\n`;
      },
    },
  });

  const tokens = marked.lexer(source);
  const first = tokens.findIndex((token) => token.type !== "space");
  if (first >= 0 && tokens[first].type === "heading" && tokens[first].depth === 1) tokens.splice(first, 1);

  marked.walkTokens(tokens, marked.defaults.walkTokens ?? (() => {}));
  const html = marked.parser(tokens)
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, "</table></div>");

  return { html, headings };
}

function renderToc(headings) {
  const entries = headings.length > 36 ? headings.filter((h) => h.depth === 2) : headings;
  if (entries.length < 2) return "";
  const items = entries
    .map((h) => `<li><a href="#${h.id}"${h.depth === 3 ? ' style="padding-left:24px"' : ""}>${h.html}</a></li>`)
    .join("\n");
  return `<aside class="docs-toc" aria-label="On this page"><h4>On this page</h4><ul>${items}</ul></aside>`;
}

function renderSidebar(current) {
  const groups = [];
  for (const page of PAGES) {
    let group = groups.find((entry) => entry.name === page.group);
    if (!group) groups.push(group = { name: page.group, pages: [] });
    group.pages.push(page);
  }
  return `<nav class="docs-side" aria-label="Documentation">
${groups.map((group) => `<h4>${escapeHtml(group.name)}</h4><ul>
${group.pages.map((page) => `<li><a href="${page.out}"${page === current ? ' aria-current="page"' : ""}>${icon(page.icon)}${escapeHtml(page.title)}</a></li>`).join("\n")}
</ul>`).join("\n")}
</nav>`;
}

function renderPager(page) {
  const index = PAGES.indexOf(page);
  const prev = PAGES[index - 1];
  const next = PAGES[index + 1];
  if (!prev && !next) return "";
  return `<nav class="docs-pager" aria-label="More guides">
${prev ? `<a href="${prev.out}"><small>Previous</small>${escapeHtml(prev.title)}</a>` : ""}
${next ? `<a class="next" href="${next.out}"><small>Next</small>${escapeHtml(next.title)}</a>` : ""}
</nav>`;
}

const SITE_PATH = new URL(SITE).pathname;
const OG_IMAGE = `${SITE}images/og-image.png`;
const OG_IMAGE_ALT = "ninja-p2p: Claude, Codex, a worker bot, and a person connected directly in one encrypted room";
const COPYRIGHT = "&copy; 2026 Steve Seguin";

// JSON inside <script> must not be able to close the element.
const jsonLd = (value) => JSON.stringify(value, null, 2).replace(/</g, "\\u003c");

function renderHead({ title, description, canonical, ogType = "article", robots, base, structuredData }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${base ? `<base href="${base}">\n` : ""}<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="author" content="Steve Seguin">
${robots ? `<meta name="robots" content="${robots}">\n` : ""}${canonical ? `<link rel="canonical" href="${canonical}">\n` : ""}<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f5f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e0f12" media="(prefers-color-scheme: dark)">
<link rel="icon" href="favicon.ico" sizes="32x32">
<link rel="icon" href="images/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="images/apple-touch-icon.png">
<link rel="manifest" href="site.webmanifest">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="ninja-p2p">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
${canonical ? `<meta property="og:url" content="${canonical}">\n` : ""}<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<meta name="twitter:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">
${structuredData ? `<script type="application/ld+json">\n${jsonLd(structuredData)}\n</script>\n` : ""}<script>
  try {
    var savedTheme = localStorage.getItem("ninja-p2p-theme");
    if (savedTheme === "light" || savedTheme === "dark") document.documentElement.setAttribute("data-theme", savedTheme);
  } catch (e) {}
</script>
<link rel="preload" href="fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="assets/site.css">
<script src="assets/site.js" defer></script>`;
}

function renderNav(current) {
  const here = (out) => (current === out ? ' aria-current="page"' : "");
  return `<header class="nav">
  <div class="wrap">
    <a class="brand" href="./" aria-label="ninja-p2p home"><img class="brand-mark" src="images/favicon.svg" width="24" height="24" alt="">ninja-p2p</a>
    <nav aria-label="Primary">
      <ul class="nav-links">
        <li><a href="./#how">How it works</a></li>
        <li><a href="./#faq">FAQ</a></li>
        <li><a href="guide.html"${here("guide.html")}>Guide</a></li>
        <li><a href="security.html"${here("security.html")}>Security</a></li>
      </ul>
    </nav>
    <div class="nav-actions">
      <a class="btn small" href="dashboard.html">${icon("monitor")}Dashboard</a>
      <a class="icon-btn" href="${REPO}" aria-label="ninja-p2p on GitHub">${icon("github")}</a>
      <button class="icon-btn theme-toggle" type="button" aria-label="Toggle dark mode">${icon("moon", "i-moon")}${icon("sun", "i-sun")}</button>
      <button class="icon-btn menu-toggle" type="button" aria-label="Menu" aria-expanded="false">${icon("menu")}</button>
    </div>
  </div>
</header>`;
}

function renderFooter() {
  return `<footer class="footer">
  <div class="wrap">
    <div>
      <a class="brand" href="./"><img class="brand-mark" src="images/favicon.svg" width="24" height="24" alt="">ninja-p2p</a>
      <p class="fine">Peer coordination for AI agents over WebRTC. Built on <a href="https://vdo.ninja">VDO.Ninja</a>.</p>
    </div>
    <div><h4>Product</h4><ul><li><a href="./#how">How it works</a></li><li><a href="dashboard.html">Dashboard</a></li><li><a href="./#faq">FAQ</a></li><li><a href="https://www.npmjs.com/package/@vdoninja/ninja-p2p">npm package</a></li></ul></div>
    <div><h4>Docs</h4><ul><li><a href="guide.html">Guide</a></li><li><a href="security.html">Security model</a></li><li><a href="protocol-and-reliability.html">Protocol</a></li><li><a href="operations.html">Operations</a></li></ul></div>
    <div><h4>Community</h4><ul><li><a href="${REPO}">GitHub</a></li><li><a href="https://discord.vdo.ninja">Discord</a></li><li><a href="changelog.html">Release ${escapeHtml(pkg.version)}</a></li><li><a href="${REPO}/issues">Report an issue</a></li></ul></div>
    <div class="footer-base">
      <span>${COPYRIGHT} &middot; <a href="${REPO}/blob/main/LICENSE">MIT License</a></span>
      <span>Claude and Codex are trademarks of their respective owners. ninja-p2p is not affiliated with Anthropic or OpenAI.</span>
    </div>
  </div>
</footer>`;
}

function renderPage(page, body, headings) {
  const title = `${page.title} | ninja-p2p`;
  const url = `${SITE}${page.out}`;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: page.title,
        description: page.description,
        url,
        inLanguage: "en",
        image: OG_IMAGE,
        author: { "@type": "Person", name: "Steve Seguin", url: "https://github.com/steveseguin" },
        isPartOf: { "@type": "WebSite", "@id": `${SITE}#website`, name: "ninja-p2p", url: SITE },
        about: { "@type": "SoftwareApplication", "@id": `${SITE}#software`, name: "ninja-p2p" },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "ninja-p2p", item: SITE },
          { "@type": "ListItem", position: 2, name: "Docs", item: `${SITE}guide.html` },
          { "@type": "ListItem", position: 3, name: page.title, item: url },
        ],
      },
    ],
  };
  return `<!DOCTYPE html>
<html lang="en" class="no-js">
<head>
${renderHead({ title, description: page.description, canonical: url, structuredData })}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<!-- Generated by scripts/build-site.mjs from ${page.src}. Edit the Markdown, then run npm run sync:docs. -->

${renderNav(page.out)}

<div class="wrap docs-layout">
${renderSidebar(page)}
<main id="main">
  <header class="docs-head">
    <span class="kicker">${escapeHtml(page.group)}</span>
    <h1>${escapeHtml(page.title)}</h1>
    <p>${escapeHtml(page.description)}</p>
    <div class="meta">
      <a href="${REPO}/blob/main/${page.src}">${icon("github")}View source</a>
      <a href="${REPO}/edit/main/${page.src}">${icon("wrench")}Suggest an edit</a>
      <a href="https://www.npmjs.com/package/@vdoninja/ninja-p2p">${icon("package")}v${escapeHtml(pkg.version)}</a>
    </div>
  </header>
  <article class="prose">
${body}
  </article>
  ${renderPager(page)}
</main>
${renderToc(headings)}
</div>

${renderFooter()}
</body>
</html>
`;
}

// GitHub Pages serves 404.html for any missing path under the site, so its
// links resolve from a <base> rather than from wherever the visitor landed.
function renderNotFound() {
  return `<!DOCTYPE html>
<html lang="en" class="no-js">
<head>
${renderHead({ title: "Page not found | ninja-p2p", description: "This page does not exist. Find the ninja-p2p guide, security model, or browser dashboard instead.", robots: "noindex", base: SITE_PATH, ogType: "website" })}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<!-- Generated by scripts/build-site.mjs. -->

${renderNav("")}

<main id="main" class="not-found">
  <div class="wrap">
    <span class="kicker">404</span>
    <h1>This page isn&rsquo;t in the room.</h1>
    <p>The link may be old, or the page may have moved. These are the usual destinations:</p>
    <div class="cta">
      <a class="btn primary" href="./">Home ${icon("arrow-right")}</a>
      <a class="btn" href="guide.html">${icon("book")}Guide</a>
      <a class="btn" href="dashboard.html">${icon("monitor")}Dashboard</a>
    </div>
    <p class="fine">Looking for a room? Open the dashboard and enter its name.</p>
  </div>
</main>

${renderFooter()}
</body>
</html>
`;
}

function renderSitemap() {
  const urls = [SITE, ...PAGES.map((page) => `${SITE}${page.out}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}
</urlset>
`;
}

// A plain-text map of the docs for AI tools (https://llmstxt.org).
function renderLlmsTxt() {
  const raw = (src) => `https://raw.githubusercontent.com/steveseguin/ninja-p2p/main/${src}`;
  const line = (page) => `- [${page.title}](${raw(page.src)}): ${page.description}`;
  const core = PAGES.filter((page) => page.group !== "Project");
  const extra = PAGES.filter((page) => page.group === "Project");
  return `# ninja-p2p

> ${pkg.description}. Version ${pkg.version}, MIT licensed, Node.js 20 or newer.

Install with \`npm install -g @vdoninja/ninja-p2p @roamhq/wrtc\`, then run \`ninja-p2p demo\` to prove a live peer round trip. Each agent runs a persistent sidecar (\`ninja-p2p start --id <name>\`) that keeps a local inbox; agents read it with \`ninja-p2p read\` and reply with \`ninja-p2p dm\`. Signaling uses VDO.Ninja's public server; messages and files travel peer to peer over encrypted WebRTC data channels.

## Docs

${core.map(line).join("\n")}

## Optional

${extra.map(line).join("\n")}
- [Website](${SITE}): overview, how it works, and FAQ
- [Source](${REPO}): repository on GitHub
`;
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“",
  rdquo: "”", mdash: "—", ndash: "–", hellip: "…", middot: "·", rarr: "→",
};

const htmlToText = (html) => html
  .replace(/<[^>]+>/g, "")
  .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => {
    if (name[0] === "#") {
      const hex = name[1].toLowerCase() === "x";
      return String.fromCodePoint(parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return ENTITIES[name] ?? match;
  })
  .replace(/\s+/g, " ")
  .trim();

// The landing page is hand-written. Keep its version and FAQ structured data
// in step with package.json and the visible FAQ.
function stampLanding() {
  const file = path.join(outDir, "index.html");
  if (!existsSync(file)) return;
  const before = readFileSync(file, "utf8");
  const faq = [...before.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="a">([\s\S]*?)<\/div>\s*<\/details>/g)]
    .map(([, question, answer]) => ({
      "@type": "Question",
      name: htmlToText(question),
      acceptedAnswer: { "@type": "Answer", text: htmlToText(answer.replace(/<\/p>\s*<p>/g, "</p> <p>")) },
    }));
  // Keep the hand-edited page's line endings; mixed endings make noisy diffs.
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const faqData = (faq.length ? jsonLd({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq }) : "{}")
    .replace(/\n/g, eol);
  const after = before
    .replace(/("softwareVersion":\s*")[^"]*(")/, `$1${pkg.version}$2`)
    .replace(/(<span data-version>)[^<]*(<\/span>)/g, `$1${pkg.version}$2`)
    .replace(/(<script type="application\/ld\+json" id="faq-schema">)[\s\S]*?(<\/script>)/, (_, open, close) => `${open}${eol}${faqData}${eol}${close}`);
  if (after !== before) writeFileSync(file, after);
  console.log(`docs/index.html: version ${pkg.version}, ${faq.length} FAQ entries`);
}

mkdirSync(outDir, { recursive: true });

// GitHub Pages would otherwise run Jekyll over docs/ and publish its own
// renderings of these Markdown files next to ours.
writeFileSync(path.join(outDir, ".nojekyll"), "");

copyFileSync(path.join(root, "dashboard.html"), path.join(outDir, "dashboard.html"));

for (const page of PAGES) {
  const source = readFileSync(path.join(root, page.src), "utf8");
  const { html, headings } = renderMarkdown(source, page);
  writeFileSync(path.join(outDir, page.out), renderPage(page, html, headings));
  console.log(`${page.src} -> ${path.relative(root, path.join(outDir, page.out))}`);
}

writeFileSync(path.join(outDir, "404.html"), renderNotFound());
writeFileSync(path.join(outDir, "sitemap.xml"), renderSitemap());
writeFileSync(path.join(outDir, "llms.txt"), renderLlmsTxt());
stampLanding();
