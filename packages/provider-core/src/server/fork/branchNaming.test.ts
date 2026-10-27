import { assert, describe, it } from "@effect/vitest";

import { toForkBranchNameResult } from "./branchNaming.ts";

const staticNaming = { mode: "static" as const, prefix: "t3", instructions: "" };

describe("toForkBranchNameResult", () => {
  it("waits when the chat so far is only chores", () => {
    assert.deepEqual(toForkBranchNameResult({ status: "inconclusive", branch: "" }, staticNaming), {
      branch: "",
      inconclusive: true,
    });
    // A name with nothing in it cannot become a branch either.
    assert.isTrue(
      toForkBranchNameResult({ status: "named", branch: "  " }, staticNaming).inconclusive,
    );
  });

  it("adds the static prefix exactly once, whether or not the model included it", () => {
    assert.equal(
      toForkBranchNameResult({ status: "named", branch: "t3/fix-logout-redirect" }, staticNaming)
        .branch,
      "t3/fix-logout-redirect",
    );
    assert.equal(
      toForkBranchNameResult({ status: "named", branch: "fix-logout-redirect" }, staticNaming)
        .branch,
      "t3/fix-logout-redirect",
    );
  });

  it("keeps a semantic type and a custom name as given", () => {
    assert.equal(
      toForkBranchNameResult(
        { status: "named", branch: "fix/logout-redirect" },
        { mode: "semantic", prefix: "", instructions: "" },
      ).branch,
      "fix/logout-redirect",
    );
    assert.equal(
      toForkBranchNameResult(
        { status: "named", branch: "ray/JIRA-12-logout" },
        { mode: "custom", prefix: "", instructions: "ray/<ticket>-<slug>" },
      ).branch,
      "ray/JIRA-12-logout",
    );
  });
});
