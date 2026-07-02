#!/usr/bin/env node
/**
 * batch-link-notes.mjs
 *
 * Maps Notes/ summaries to concepts based on filename and content patterns.
 * Usage: node scripts/wiki/batch-link-notes.mjs --base-path /path/to/knowledge-base
 */

import fs from "node:fs";
import path from "node:path";

const KNOWLEDGE_DIR = (() => {
  const argvBaseIdx = process.argv.indexOf("--base-path");
  if (argvBaseIdx !== -1 && process.argv[argvBaseIdx + 1]) {
    return path.resolve(process.argv[argvBaseIdx + 1]);
  }
  console.error("Usage: --base-path <knowledge-dir>");
  process.exit(1);
})();

const SUMMARIES_DIR = path.join(KNOWLEDGE_DIR, "Wiki", "Summaries", "Notes");

// Concept matching rules: filename casing, then keyword
const CONCEPT_RULES = [
  {
    slug: "golang",
    match: (name) =>
      name.startsWith("golang") ||
      name.startsWith("go") ||
      name.includes("goroutine") ||
      name.includes("channel") ||
      name.startsWith("sync.") ||
      name.startsWith("context") ||
      name.startsWith("reflect") ||
      name.startsWith("netpoller") ||
      name.startsWith("gc-") ||
      name.startsWith("gcWork") ||
      name.startsWith("gomock") ||
      name.includes("mod使用") ||
      name.includes("net.http") ||
      name.includes("plan9") ||
      name.includes("effective-golang") ||
      name.includes("gofunction"),
  },
  {
    slug: "rust",
    match: (name) => name.startsWith("rust") || name.startsWith("tokio"),
  },
  {
    slug: "c-cpp",
    match: (name) =>
      name.toLowerCase().includes("cpp") ||
      name.toLowerCase().includes("c++") ||
      name === "C中常见API" ||
      name.startsWith("lambda") ||
      name.startsWith("malloc") ||
      name.startsWith("shared_ptr") ||
      name.startsWith("X86汇编") ||
      name.startsWith("寄存器分配") ||
      name.startsWith("闭包与宏") ||
      name.startsWith("静态单赋值") ||
      name.startsWith("编译器") ||
      name.startsWith("链接器"),
  },
  {
    slug: "databases",
    match: (name) =>
      name.toLowerCase().includes("mysql") ||
      name.toLowerCase().includes("redis") ||
      name.toLowerCase().includes("kafka") ||
      name.toLowerCase().includes("sqlite") ||
      name.toLowerCase().includes("mongodb") ||
      name.toLowerCase().includes("prometheus") ||
      name.startsWith("boltdb") ||
      name.startsWith("LSM") ||
      name.startsWith("sstable") ||
      name.startsWith("compaction") ||
      name.startsWith("WAL") ||
      name.startsWith("AOF") ||
      name.startsWith("RDB") ||
      name.startsWith("Memtable") ||
      name.startsWith("Innodb") ||
      name.startsWith("innodb") ||
      name.startsWith("es使用") ||
      name.startsWith("es内部") ||
      name.startsWith("etcd") ||
      name.startsWith("explain") ||
      name.startsWith("缓存") ||
      name.startsWith("cache") ||
      name.startsWith("explain") ||
      name.includes("存储和检索") ||
      name.includes("数据平台") ||
      name.includes("数据模型与查询"),
  },
  {
    slug: "distributed-systems",
    match: (name) =>
      name.startsWith("分布式") ||
      name.startsWith("Raft") ||
      name.startsWith("paxos") ||
      name.startsWith("Gossip") ||
      name.startsWith("sentinel") ||
      name.startsWith("hashicorp-raft") ||
      name.startsWith("etcd") ||
      name.startsWith("RPC基本") ||
      name.startsWith("nsq基本") ||
      name.includes("kafka设计") ||
      name.includes("熔断器") ||
      name.includes("限流系统") ||
      name.includes("延迟队列") ||
      name.includes("订阅推送") ||
      name.includes("排行榜") ||
      name.includes("短链接系统") ||
      name.includes("秒杀系统") ||
      name.includes("直播点赞") ||
      name.includes("分布式锁") ||
      name.startsWith("kcp理解"),
  },
  {
    slug: "linux-kernel",
    match: (name) =>
      name.toLowerCase().includes("linux") ||
      name.toLowerCase().includes("kernel") ||
      name.startsWith("epoll") ||
      name.startsWith("io_") ||
      name.startsWith("namespace") ||
      name.startsWith("cgroup") ||
      name.startsWith("chroot") ||
      name.startsWith("dwarf") ||
      name.startsWith("elf") ||
      name.startsWith("进程") ||
      name.startsWith("内存屏障") ||
      name.startsWith("内存模型") ||
      name.startsWith("虚拟内存") ||
      name.startsWith("中断上下文") ||
      name.startsWith("栈展开") ||
      name.startsWith("等待队列") ||
      name.startsWith("分支预测") ||
      name.startsWith("单一更新队列") ||
      name.startsWith("指针的原子") ||
      name.startsWith("有版本的值") ||
      name.startsWith("版本向量") ||
      name.includes("零拷贝") ||
      name.startsWith("perf") ||
      name.startsWith("systemtap") ||
      name.includes("golang启动") ||
      name.startsWith("IPC通信") ||
      name.startsWith("liburing") ||
      name.startsWith("libbootrap") ||
      name.startsWith("容器网络") ||
      name.includes("网络设备") ||
      name.includes("系统调用") ||
      name.startsWith("PMG调度"),
  },
  {
    slug: "ebpf",
    match: (name) =>
      name.toLowerCase().includes("ebpf") ||
      name.toLowerCase().includes("bpf") ||
      name.startsWith("bcc") ||
      name.startsWith("bpftrace") ||
      name.startsWith("pwru") ||
      name.startsWith("hook系统调用"),
  },
  {
    slug: "performance",
    match: (name) =>
      name.includes("性能") ||
      name.startsWith("performance") ||
      name.startsWith("perf") ||
      name.startsWith("stress-test") ||
      name.startsWith("编码的基础知识") ||
      name.includes("性能优化"),
  },
  {
    slug: "networking",
    match: (name) =>
      name.toLowerCase().includes("tcp") ||
      name.toLowerCase().includes("http") ||
      name.toLowerCase().includes("dns") ||
      name.startsWith("网络") ||
      name.startsWith("nat") ||
      name.startsWith("vpn") ||
      name.startsWith("wireguard") ||
      name.startsWith("socks") ||
      name.startsWith("iptable") ||
      name.startsWith("vxlan") ||
      name.startsWith("cdn") ||
      name.startsWith("socket") ||
      name.startsWith("sock5") ||
      name.startsWith("wireshark") ||
      name.startsWith("抓包") ||
      name.startsWith("lvs") ||
      name.startsWith("stun") ||
      name.startsWith("数字证书") ||
      name.startsWith("翻墙") ||
      name.startsWith("tun设备") ||
      name.startsWith("PacketDrill") ||
      name.includes("网络IO与协程") ||
      name.startsWith("什么是latency") ||
      name.startsWith("什么是utilization"),
  },
  {
    slug: "dev-tools",
    match: (name) =>
      name.startsWith("docker") ||
      name.startsWith("vim") ||
      name.startsWith("neovim") ||
      name.startsWith("git中的") ||
      name.startsWith("atuin") ||
      name.startsWith("debugger") ||
      name.startsWith("编辑器的开发") ||
      name.startsWith("Make的") ||
      name.startsWith("podman") ||
      name.startsWith("containerd") ||
      name.startsWith("z.lua") ||
      name.startsWith("笔记方法") ||
      name.startsWith("如何学习") ||
      name.startsWith("如何进行刻意") ||
      name.startsWith("obsidian") ||
      name.startsWith("ssh的使用") ||
      name.startsWith("ssh隧道") ||
      name.startsWith("学习资料汇总"),
  },
  {
    slug: "testing",
    match: (name) =>
      name.includes("test") ||
      name.includes("测试") ||
      name.startsWith("gomock"),
  },
  {
    slug: "algorithms",
    match: (name) =>
      name.startsWith("B树") ||
      name.startsWith("B+树") ||
      name.startsWith("排序算法") ||
      name.startsWith("arena") ||
      name.startsWith("leetcode") ||
      name.startsWith("海量数据") ||
      name.startsWith("数据估算") ||
      name.startsWith("常见面试") ||
      name.startsWith("id设计") ||
      name.startsWith("分布式ID") ||
      name.startsWith("分片与一致性"),
  },
  {
    slug: "agent-patterns",
    match: (name) =>
      name.includes("AI相关") ||
      name.includes("async和await") ||
      name.includes("ai") ||
      name.includes("agent") ||
      name.includes("llm") ||
      name.includes("prompt"),
  },
];

// Read all summary files
const summaryFiles = fs
  .readdirSync(SUMMARIES_DIR)
  .filter((f) => f.endsWith(".summary.md"))
  .sort();

// Build mapping: summaryRel → [concept-slugs]
const summaryToConcepts = {};

for (const file of summaryFiles) {
  const name = file.replace(".summary.md", "");
  const summaryRel = path.posix.join(
    "Wiki/Summaries/Notes",
    file.replace(".summary.md", ""),
  );

  for (const rule of CONCEPT_RULES) {
    if (rule.match(name)) {
      if (!summaryToConcepts[summaryRel]) summaryToConcepts[summaryRel] = [];
      if (!summaryToConcepts[summaryRel].includes(rule.slug)) {
        summaryToConcepts[summaryRel].push(rule.slug);
      }
    }
  }
}

// Insert into concept files
const conceptLinks = {};
for (const [summaryRel, slugs] of Object.entries(summaryToConcepts)) {
  for (const slug of slugs) {
    if (!conceptLinks[slug]) conceptLinks[slug] = [];
    conceptLinks[slug].push(summaryRel);
  }
}

let totalInserted = 0;
for (const [slug, links] of Object.entries(conceptLinks)) {
  const conceptPath = path.join(
    KNOWLEDGE_DIR,
    "Wiki",
    "Concepts",
    `${slug}.md`,
  );
  if (!fs.existsSync(conceptPath)) {
    console.error(`Concept file not found: ${slug}`);
    continue;
  }

  let content = fs.readFileSync(conceptPath, "utf8");
  const existingLinks = new Set();

  // Parse existing links
  const lines = content.split("\n");
  let inSources = false;
  for (const line of lines) {
    if (line === "## Sources") {
      inSources = true;
      continue;
    }
    if (inSources && line.startsWith("## ")) break;
    if (inSources && line.trim().startsWith("- [[")) {
      const match = line.match(/\[\[([^\]]+)\]\]/);
      if (match) existingLinks.add(match[1]);
    }
  }

  // Find insertion point
  let insertIdx = content.indexOf("## Sources");
  for (let i = insertIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "" || lines[i].startsWith("- [[")) insertIdx = i;
    else if (lines[i].startsWith("## ")) break;
  }

  const sortedLinks = [...new Set(links)].sort();
  const newLinks = sortedLinks.filter((l) => !existingLinks.has(l));

  if (newLinks.length > 0) {
    const linkLines = newLinks.map((l) => `- [[${l}]]`);
    lines.splice(insertIdx + 1, 0, ...linkLines);
    fs.writeFileSync(conceptPath, lines.join("\n"), "utf8");
    totalInserted += newLinks.length;
    console.log(
      `  ${slug}: +${newLinks.length} (total ${existingLinks.size + newLinks.length})`,
    );
  }
}

// Summary
console.log(
  `\nTotal: ${Object.keys(summaryToConcepts).length} summaries linked to ${Object.keys(conceptLinks).length} concepts, ${totalInserted} new links inserted`,
);

// Per concept stats
const conceptCounts = {};
for (const [, slugs] of Object.entries(summaryToConcepts)) {
  for (const slug of slugs) {
    conceptCounts[slug] = (conceptCounts[slug] || 0) + 1;
  }
}

console.log("\n=== Concept coverage ===");
for (const [slug, count] of Object.entries(conceptCounts).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`  ${slug}: ${count}`);
}
