import { describe, expect, it } from "vite-plus/test";

import { foldedKeys, foldExceptions } from "./diffDefaults";

describe("diff folds", () => {
  it("keeps files that appear after an expand collapsed", () => {
    const expandedA = foldExceptions(["a", "b"], new Set(["b"]), true);
    expect([...foldedKeys(["a", "b", "c"], expandedA, true)]).toEqual(["b", "c"]);
  });

  it("starts new files expanded when the default is expanded", () => {
    const collapsedA = foldExceptions(["a", "b"], new Set(["a"]), false);
    expect([...foldedKeys(["a", "b", "c"], collapsedA, false)]).toEqual(["a"]);
  });
});
