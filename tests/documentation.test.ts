import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const readme = read("README.md");
const landingPage = read("docs/index.html");
const socialStreamGuide = read("docs/social-stream-bridge.md");
const sdkWishlist = read("docs/sdk-wishlist.md");
const sdkTypeShim = read("src/vdoninja-sdk-types.ts");
const doctorSource = read("src/doctor.ts");
const bridgeSource = read("src/vdo-bridge.ts");
const codexSkill = read(".codex/skills/ninja-p2p/SKILL.md");
const agentsSkill = read(".agents/skills/ninja-p2p/SKILL.md");
const claudeSkill = read(".claude/skills/ninja-p2p/SKILL.md");
const packageJson = JSON.parse(read("package.json")) as {
  description: string;
  dependencies: Record<string, string>;
};
const markdownGuides = [
  "README.md",
  "docs/audiences.md",
  "docs/protocol-and-reliability.md",
  "docs/sdk-wishlist.md",
  "docs/security.md",
  "docs/social-stream-bridge.md",
  ".codex/skills/ninja-p2p/SKILL.md",
  ".claude/skills/ninja-p2p/SKILL.md",
];

test("the two installed Codex skill layouts stay identical", () => {
  assert.equal(agentsSkill, codexSkill);
});

test("the user guides distinguish simple, shared, swarm, and browser file paths", () => {
  for (const guide of [readme, codexSkill, claudeSkill]) {
    assert.match(guide, /send-file/);
    assert.match(guide, /256 MiB/);
    assert.match(guide, /seed/);
    assert.match(guide, /fetch/);
    assert.match(guide, /resum/);
    assert.match(guide, /64 MiB/);
    assert.match(guide, /read-only/);
  }
});

test("the product story stays aligned across user-facing surfaces", () => {
  for (const surface of [readme, landingPage, codexSkill, claudeSkill]) {
    assert.match(surface, /separate AI tools work\s+(?:like|as) a team/);
  }
  assert.match(socialStreamGuide, /important optional application/);
  assert.match(socialStreamGuide, /Start read-only/);
  assert.match(packageJson.description, /Agent coordination and file handoffs/);
  assert.match(packageJson.description, /optional Social Stream bridge/);
});

test("the landing page surfaces the main end-user capabilities", () => {
  assert.match(landingPage, /Hand work to the right agent/);
  assert.match(landingPage, /Reach an agent between turns/);
  assert.match(landingPage, /send-file/);
  assert.match(landingPage, /--share/);
  assert.match(landingPage, /seed/);
  assert.match(landingPage, /fetch/);
  assert.match(landingPage, /Social Stream/);
  assert.match(landingPage, /built-in capability, not a separate add-on/);
});

test("the library guide and package metadata describe the SDK 1.4.1 binary API", () => {
  assert.match(readme, /sendBinaryTo/);
  assert.match(readme, /bridge\.on\("binary"/);
  assert.match(readme, /sendRaw\(\).*is not the binary API/);
  assert.equal(packageJson.dependencies["@vdoninja/sdk"], "^1.4.1");
  assert.match(packageJson.description, /resumable file swarms/);
  assert.match(sdkWishlist, /npm 1\.4\.1 tarball does not contain/);
  assert.match(sdkTypeShim, /tarball published on 2026-07-25 does not contain/);
  assert.match(sdkTypeShim, /compiled into ninja-p2p's own public/);
  assert.match(sdkTypeShim, /types, so consumers do not inherit/);
  assert.match(doctorSource, /import\(OPTIONAL_WEBRTC_MODULE\)/);
  assert.match(bridgeSource, /from "\.\/vdoninja-sdk-types\.js"/);
  assert.doesNotMatch(bridgeSource, /from "@vdoninja\/sdk"/);
});

test("local links in the Markdown guides resolve", () => {
  for (const guidePath of markdownGuides) {
    const guideUrl = new URL(`../${guidePath}`, import.meta.url);
    const markdown = read(guidePath);
    for (const match of markdown.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(href)) continue;
      const relativePath = href.split(/[?#]/, 1)[0];
      if (!relativePath) continue;
      const target = new URL(decodeURIComponent(relativePath), guideUrl);
      assert.equal(
        existsSync(target),
        true,
        `${guidePath} links to missing local target ${href}`,
      );
    }
  }
});
