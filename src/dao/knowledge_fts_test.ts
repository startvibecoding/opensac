// Ported from internal/dao/knowledge_fts_test.go (package dao internal test).

import { assert, assertEquals } from "@std/assert";
import {
  knowledgeFTSHasTokenRune,
  knowledgeFTSIndexText,
  knowledgeFTSQuery,
  knowledgeIsFTSCJK,
} from "./mod.ts";
import { closeTestDbs, openBareDb } from "./test_util.ts";

Deno.test("knowledge FTS index text splits CJK runs into bigrams", () => {
  const cases: { name: string; input: string; want: string }[] = [
    {
      name: "latin unchanged",
      input: "The runtime owns durable runs.",
      want: "The runtime owns durable runs.",
    },
    { name: "cjk run becomes bigrams", input: "知识库", want: " 知识 识库 " },
    { name: "isolated cjk character is kept", input: "猫", want: " 猫 " },
    {
      name: "mixed run is separated",
      input: "go语言模型",
      want: "go 语言 言模 模型 ",
    },
    { name: "cjk with punctuation", input: "知识。库", want: " 知识 。 库 " },
  ];
  for (const testCase of cases) {
    assertEquals(
      knowledgeFTSIndexText(testCase.input),
      testCase.want,
      testCase.name,
    );
  }
});

Deno.test("knowledge FTS query builds CJK phrases", () => {
  const cases: { query: string; want: string }[] = [
    { query: "知识库", want: `"知识 识库"` },
    { query: "go语言", want: `"go 语言"` },
    { query: "knowledge base", want: `"knowledge" OR "base"` },
    { query: "durable_run", want: `"durable_run"` },
    { query: "...", want: "" },
    { query: "", want: "" },
  ];
  for (const testCase of cases) {
    assertEquals(knowledgeFTSQuery(testCase.query), testCase.want);
  }
});

// TestKnowledgeFTSCJKRoundTrip proves the index/query rewrite pair against a
// real FTS5 table with the same definition as knowledge_chunk_fts.
Deno.test("knowledge FTS CJK round trip", () => {
  const db = openBareDb();
  try {
    db.exec(
      `CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(chunk_id UNINDEXED, snapshot_id UNINDEXED, text)`,
    );
    const rows = [
      { id: "c1", text: "知识库是一个可重建的图谱索引系统" },
      { id: "c2", text: "The knowledge base is a rebuildable graph index" },
      { id: "c3", text: "go语言 bindings expose the same API" },
    ];
    for (const row of rows) {
      db.run(
        `INSERT INTO knowledge_chunk_fts(chunk_id, snapshot_id, text) VALUES (?, 's1', ?)`,
        row.id,
        knowledgeFTSIndexText(row.text),
      );
    }
    const match = (query: string): string[] => {
      const terms = knowledgeFTSQuery(query);
      if (terms === "") return [];
      return db.query<{ chunk_id: string }>(
        `SELECT chunk_id FROM knowledge_chunk_fts
         WHERE knowledge_chunk_fts MATCH ?
         ORDER BY bm25(knowledge_chunk_fts)`,
        terms,
      ).map((r) => r.chunk_id);
    };
    const cases: { query: string; want: string }[] = [
      { query: "知识库", want: "c1" },
      { query: "图谱索引", want: "c1" },
      { query: "索引系统", want: "c1" },
      { query: "知识", want: "c1" },
      { query: "knowledge base", want: "c2" },
      { query: "rebuildable", want: "c2" },
      { query: "go语言", want: "c3" },
      { query: "bindings", want: "c3" },
    ];
    for (const testCase of cases) {
      const ids = match(testCase.query);
      assert(
        ids.length > 0 && ids[0] === testCase.want,
        `query ${testCase.query} matched ${JSON.stringify(ids)}`,
      );
    }
    assertEquals(match("不存在的词组").length, 0);
    assert(knowledgeFTSQuery("知识库").includes(" "));
    assert(knowledgeFTSHasTokenRune("go语言"));
    assert(knowledgeIsFTSCJK(0x4e00) && !knowledgeIsFTSCJK(0x20));
  } finally {
    closeTestDbs();
  }
});
