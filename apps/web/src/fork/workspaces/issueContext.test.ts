import { describe, expect, it } from "vite-plus/test";

import { buildIssueReferenceContext, forkIssueContextNumber } from "./issueContext";

describe("issue reference context", () => {
  const issue = {
    number: 2158,
    title: "Print  label\nfails",
    url: "https://github.com/o/r/issues/2158",
  };

  it("marks the record so its chip is the issue's, with the URL kept", () => {
    const record = buildIssueReferenceContext(issue);
    expect(forkIssueContextNumber(record)).toBe(2158);
    expect(record.filePath).toBe(issue.url);
    expect(record.rangeLabel).toBe("Print label fails");
  });

  it("leaves other review comments alone", () => {
    expect(forkIssueContextNumber({ sectionId: "pull-request:2180" })).toBeNull();
  });
});
