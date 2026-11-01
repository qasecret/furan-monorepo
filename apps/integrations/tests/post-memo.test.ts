import { describe, expect, test } from "vitest";

import { createPostMemo } from "../src/github/post-memo.js";

describe("createPostMemo", () => {
  test("nothing is remembered until a post is recorded", () => {
    const memo = createPostMemo();
    expect(memo.unchanged("acme/site@abc", "failure|x")).toBe(false);
  });

  test("a recorded value is unchanged until the value differs", () => {
    const memo = createPostMemo();
    memo.remember("acme/site@abc", "failure|x");
    expect(memo.unchanged("acme/site@abc", "failure|x")).toBe(true);
    expect(memo.unchanged("acme/site@abc", "success|x")).toBe(false);
    // Another commit has its own entry.
    expect(memo.unchanged("acme/site@def", "failure|x")).toBe(false);
  });

  test("remembering a new value replaces the old one", () => {
    const memo = createPostMemo();
    memo.remember("k", "a");
    memo.remember("k", "b");
    expect(memo.unchanged("k", "a")).toBe(false);
    expect(memo.unchanged("k", "b")).toBe(true);
  });

  test("it is bounded: the least recently used key is forgotten first", () => {
    const memo = createPostMemo(2);
    memo.remember("a", "1");
    memo.remember("b", "1");
    // Touching "a" makes "b" the oldest.
    expect(memo.unchanged("a", "1")).toBe(true);
    memo.remember("c", "1");

    expect(memo.unchanged("b", "1")).toBe(false);
    expect(memo.unchanged("a", "1")).toBe(true);
    expect(memo.unchanged("c", "1")).toBe(true);
  });
});
