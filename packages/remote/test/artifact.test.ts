// The Artifact tool's result as the Claude app writes it (shape copied from a real 2026-11-12 publish).
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactOf } from "../src/artifact.ts";

test("a real publish result becomes a card: title and claude.ai URL kept, a word icon kept, a string version left out", () => {
  const real = {
    url: "https://claude.ai/artifact/KpjjDH2MmCvcre6m3qWHpD",
    path: "/private/tmp/scratchpad/roadmap/page/index.html",
    artifact_id: "986ec8f6-0a40-4083-9dfa-799e8653fc3a",
    title: "클로드리플 로드맵",
    updated: false, owned: true, icon: "map", audience: "owner", seq: 1,
    version: "1794447724-6232", contract: "0.0.0", liveSubscription: "armed",
  };
  assert.deepEqual(artifactOf(real), { title: "클로드리플 로드맵", url: "https://claude.ai/artifact/KpjjDH2MmCvcre6m3qWHpD", icon: "map" });
});

test("the quickstart result (no artifact id) is not a card", () => {
  assert.equal(artifactOf({ quickstart: { intent: "other", types: [] } }), undefined);
});
