import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

interface SkillFrontmatter {
  readonly description: string | undefined;
  readonly fieldNames: readonly string[];
  readonly name: string | undefined;
}

const repositoryRoot = resolve(".");

async function runCommand(
  command: string[],
  cwd = repositoryRoot,
): Promise<CommandResult> {
  const process = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function parseFrontmatter(contents: string): SkillFrontmatter {
  const frontmatterMatch = contents.match(/^---\n([\s\S]*?)\n---\n/);
  if (frontmatterMatch?.[1] === undefined) {
    return { description: undefined, fieldNames: [], name: undefined };
  }
  const fields = new Map(
    frontmatterMatch[1].split("\n").flatMap((line) => {
      const separator = line.indexOf(":");
      return separator === -1
        ? []
        : [[line.slice(0, separator), line.slice(separator + 1).trim()]];
    }),
  );
  return {
    description: fields.get("description"),
    fieldNames: [...fields.keys()],
    name: fields.get("name"),
  };
}

async function readSkill(name: string): Promise<string> {
  return readFile(resolve("skills", name, "SKILL.md"), "utf8");
}

describe("Agent Skills", () => {
  test("npx skills discovers Drop and HTML communication", async () => {
    const result = await runCommand([
      "npx",
      "--no-install",
      "skills",
      "add",
      repositoryRoot,
      "--list",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("drop");
    expect(result.output).toContain("html-communication");
    expect(result.output).not.toContain("No valid skills found");
  });

  test("npx skills installs both ordinary skills", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "drop-skills-"));
    try {
      expect((await runCommand(["git", "init", "-q"], project)).exitCode).toBe(
        0,
      );
      const result = await runCommand(
        [
          "npx",
          "--prefix",
          repositoryRoot,
          "--no-install",
          "skills",
          "add",
          repositoryRoot,
          "--skill",
          "*",
          "--agent",
          "codex",
          "--copy",
          "-y",
        ],
        project,
      );

      expect(result.exitCode).toBe(0);
      for (const name of ["drop", "html-communication"]) {
        expect(
          await readFile(
            resolve(project, ".agents", "skills", name, "SKILL.md"),
            "utf8",
          ),
        ).toBe(await readSkill(name));
      }
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("skills have valid harness-neutral frontmatter", async () => {
    for (const name of ["drop", "html-communication"]) {
      const contents = await readSkill(name);
      const frontmatter = parseFrontmatter(contents);
      expect(frontmatter.name).toBe(name);
      expect(frontmatter.description?.length).toBeGreaterThan(20);
      expect(frontmatter.fieldNames).toEqual(["name", "description"]);
      expect(contents).not.toMatch(/Codex|Claude|plugin|marketplace|npm package/i);
    }
    expect(
      (
        await Array.fromAsync(
          new Bun.Glob("skills/**/*").scan({
            cwd: repositoryRoot,
            onlyFiles: true,
          }),
        )
      ).sort(),
    ).toEqual([
      "skills/drop/SKILL.md",
      "skills/html-communication/SKILL.md",
    ]);
  });

  test("Drop instructions cover publishing and setup failures", async () => {
    const contents = (await readSkill("drop")).toLowerCase();

    for (const required of [
      "command -v drop",
      "run `drop <path>`",
      "drop auth set",
      "drop_upload_key",
      "unlisted url",
      "curl",
      "explicit",
      "never silently substitute",
      "a failed cli invocation never authorizes another upload method",
      "local path identity",
      "keep the local artifact",
      "jpeg, png, webp, avif, gif, mp4, and webm",
    ]) {
      expect(contents).toContain(required);
    }
  });

  test("HTML communication keeps the Doc contract and stable revision path", async () => {
    const contents = (await readSkill("html-communication")).toLowerCase();
    const forbiddenCapabilities = contents.match(/never include[^\n]+/)?.[0];

    for (const required of [
      "512 kib",
      "#000",
      "responsive viewport",
      "semantic html",
      "inline css",
      "inline svg",
      "data or https media",
      "external or module scripts",
      "inline event handlers",
      "private network urls",
      "same local path",
      "re-drops the doc at its existing live url",
      "manual browser refresh",
      "command -v drop",
      "drop auth set",
      "drop_upload_key",
      "keep the local artifact",
    ]) {
      expect(contents).toContain(required);
    }
    expect(forbiddenCapabilities).toContain("storage");
    expect(forbiddenCapabilities).toContain("script-initiated network requests");
    expect(forbiddenCapabilities).toContain("workers");
    expect(forbiddenCapabilities).toContain("script-created popups");
    expect(contents).not.toContain("localhost");
  });
});
