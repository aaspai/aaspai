import { FileKnowledgeSource } from "@aaspai/file-loader";
import { Command } from "commander";
import pc from "picocolors";

export function knowledgeCommand(): Command {
  const cmd = new Command("knowledge").description("Knowledge (OKF) operations");

  function source(): FileKnowledgeSource {
    return new FileKnowledgeSource(process.env.AASPAI_KNOWLEDGE_DIR ?? "./knowledge");
  }

  cmd
    .command("list")
    .description("List all OKF concepts")
    .action(async () => {
      const s = source();
      await s.start();
      try {
        const ids = await s.list();
        console.log(pc.cyan(`Knowledge (${ids.length} concepts)`));
        for (const id of ids) console.log(`  ${id}`);
      } finally {
        await s.stop();
        process.exit(0);
      }
    });

  cmd
    .command("search <query>")
    .description("Search across all knowledge")
    .action(async (query: string) => {
      const s = source();
      await s.start();
      try {
        const results = await s.search(query);
        console.log(pc.cyan(`Search results for "${query}" (${results.length})`));
        for (const c of results) {
          console.log(`  ${c.id.padEnd(40)} ${pc.gray(`[${c.type}] ${c.title}`)}`);
        }
      } finally {
        await s.stop();
        process.exit(0);
      }
    });

  cmd
    .command("show <path>")
    .description("Show a knowledge file")
    .action(async (path: string) => {
      const s = source();
      await s.start();
      try {
        const c = await s.get(path);
        console.log(pc.cyan(`# ${c.title}`));
        console.log(pc.gray(`id: ${c.id}  type: ${c.type}  tags: [${c.tags.join(", ")}]`));
        console.log("");
        console.log(c.body);
      } finally {
        await s.stop();
        process.exit(0);
      }
    });

  cmd
    .command("new <path>")
    .description("Scaffold a new knowledge file")
    .action(async (path: string) => {
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      const fullPath = nodePath.join(
        process.env.AASPAI_KNOWLEDGE_DIR ?? "./knowledge",
        `${path}.md`,
      );
      const template = `---
type: Doc
title: "${path.split("/").pop()}"
description: TODO
timestamp: ${new Date().toISOString()}
tags: []
---

# ${path}

Write the content here.
`;
      await fs.writeFile(fullPath, template, "utf8");
      console.log(pc.green(`✓ Created ${fullPath}`));
      process.exit(0);
    });

  cmd
    .command("validate")
    .description("Validate all OKF files")
    .action(async () => {
      const s = source();
      await s.start();
      try {
        const ids = await s.list();
        let ok = 0;
        for (const id of ids) {
          try {
            await s.get(id);
            ok++;
          } catch (err) {
            console.log(`  ${pc.red("✗")} ${id}: ${(err as Error).message}`);
          }
        }
        console.log(pc.green(`✓ ${ok}/${ids.length} concepts valid`));
      } finally {
        await s.stop();
        process.exit(0);
      }
    });

  return cmd;
}
